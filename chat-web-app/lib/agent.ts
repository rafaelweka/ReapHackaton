import { brandFilter, checkDelivery, chips, preferredHit } from "@/lib/guardrails";
import { MERCHANTS, type Merchant } from "@/lib/merchants";
import { provider, ReapError } from "@/lib/provider";
import type {
  AgentEvent,
  Candidate,
  CartLine,
  Guardrails,
  Ingredient,
  MerchantScore,
  PlanResult,
  Quote,
} from "@/lib/types";

export type Emit = (event: AgentEvent) => void;

function nowEvent(kind: AgentEvent["kind"], message: string): AgentEvent {
  return { ts: Date.now(), kind, message };
}

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

function relevance(ingredient: string, productName: string): number {
  const want = tokens(ingredient);
  const have = tokens(productName);
  if (!want.length) return 0;
  return want.filter((t) => have.includes(t) || productName.toLowerCase().includes(t)).length;
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

function pickCandidate(
  ingredient: Ingredient,
  ranked: Candidate[],
  preferred: string[],
): { candidate: Candidate; reason: string } | null {
  const available = ranked.filter((c) => c.available);
  if (!available.length) return null;

  const scored = available
    .map((c) => ({ c, rel: relevance(ingredient.name, c.name) }))
    .sort((a, b) => b.rel - a.rel || a.c.price.amount - b.c.price.amount);

  const withRel = scored.filter((s) => s.rel > 0);
  const pool = withRel.length ? withRel : scored;
  const chosen = pool[0].c;
  const pref = preferredHit(chosen, preferred);
  const reason = pref
    ? `preferred brand match on ${chosen.name}`
    : pool[0].rel > 0
      ? `best name match, then cheapest (${chosen.name})`
      : `cheapest available candidate (${chosen.name})`;
  return { candidate: chosen, reason };
}

function quoteLines(lines: CartLine[]) {
  return lines
    .filter((l) => l.status === "selected" || l.status === "swapped")
    .slice(0, 20)
    .map((l) => ({ variantId: l.candidate.variantId, quantity: l.quantity }));
}

async function quoteCart(lines: CartLine[], emit: Emit): Promise<Quote> {
  const items = quoteLines(lines);
  if (!items.length) throw new Error("No purchasable items left to quote.");

  try {
    const quote = await provider.createQuote(items);
    emit(nowEvent("quote", `Quoted ${items.length} items · S$${quote.finalAmount.amount.toFixed(2)} · locks until ${quote.expiresAt}`));
    return quote;
  } catch (err) {
    if (err instanceof ReapError && err.code === "QUOTE_UNFULFILLABLE") {
      emit(nowEvent("error", "Quote unfulfillable. Dropping the priciest line and retrying."));
      const live = lines.filter((l) => l.status === "selected" || l.status === "swapped");
      const priciest = [...live].sort((a, b) => b.candidate.price.amount - a.candidate.price.amount)[0];
      if (!priciest) throw err;
      priciest.status = "dropped";
      priciest.reason = "dropped after QUOTE_UNFULFILLABLE";
      return quoteCart(lines, emit);
    }
    throw err;
  }
}

export async function planCart(
  needed: Ingredient[],
  guardrails: Guardrails,
  emit: Emit,
): Promise<PlanResult> {
  if (!process.env.REAP_API_KEY) {
    throw new Error("REAP_API_KEY is missing. Put it in .env.local.");
  }
  if (!needed.length) {
    return {
      merchant: { domain: MERCHANTS[0].domain, label: MERCHANTS[0].label, hits: 0, missed: [] },
      scores: [],
      lines: [],
      quote: null,
      events: [],
      guardrails: chips({
        quote: null,
        budget: guardrails.budget.amount,
        delivery: { ok: true, detail: "Nothing to ship" },
        brandsDetail: "n/a",
        windowNotGuaranteed: false,
      }),
      canApprove: false,
      message: "Nothing to buy — every ingredient is marked have.",
    };
  }

  emit(nowEvent("search", `Searching ${MERCHANTS.map((m) => m.label).join(", ")} for ${needed.length} items`));

  type Hit = { ingredient: Ingredient; merchant: Merchant; candidates: Candidate[] };
  const jobs = needed.flatMap((ingredient) =>
    MERCHANTS.map((merchant) => ({ ingredient, merchant })),
  );

  const results = await mapPool(jobs, 2, async ({ ingredient, merchant }) => {
    try {
      const candidates = await provider.search(ingredient.name, merchant.merchantName);
      return { ingredient, merchant, candidates } satisfies Hit;
    } catch (err) {
      const message = err instanceof Error ? err.message : "search failed";
      emit(nowEvent("error", `${merchant.label} search for ${ingredient.name}: ${message}`));
      return { ingredient, merchant, candidates: [] } satisfies Hit;
    }
  });

  const byMerchant = new Map<string, Hit[]>();
  for (const row of results) {
    const list = byMerchant.get(row.merchant.domain) ?? [];
    list.push(row);
    byMerchant.set(row.merchant.domain, list);
  }

  const scores: MerchantScore[] = MERCHANTS.map((m) => {
    const rows = byMerchant.get(m.domain) ?? [];
    const missed: string[] = [];
    let hits = 0;
    for (const ingredient of needed) {
      const row = rows.find((r) => r.ingredient.id === ingredient.id);
      const ok = (row?.candidates ?? []).some((c) => c.available);
      if (ok) hits += 1;
      else missed.push(ingredient.name);
    }
    return { domain: m.domain, label: m.label, hits, missed };
  });

  const maxHits = Math.max(...scores.map((s) => s.hits), 0);
  const winnerScore = scores.find((s) => s.hits === maxHits) ?? scores[0];
  const winner = MERCHANTS.find((m) => m.domain === winnerScore.domain) ?? MERCHANTS[0];

  emit(
    nowEvent(
      "merchant",
      `Locking ${winner.label} (${winnerScore.hits}/${needed.length} hits). Tie-break: Zenxin → Supernature → Fishwives.`,
    ),
  );
  for (const s of scores) {
    emit(nowEvent("search", `${s.label}: ${s.hits}/${needed.length}`));
  }

  const preferred = guardrails.brands?.preferred ?? [];
  const winnerRows = byMerchant.get(winner.domain) ?? [];
  const lines: CartLine[] = [];
  let blockedFlags = 0;
  let missingFlags = 0;

  for (const ingredient of needed) {
    const row = winnerRows.find((r) => r.ingredient.id === ingredient.id);
    const raw = (row?.candidates ?? []).filter((c) => c.available);
    const { allowed, blockedDropped, preferredFirst } = brandFilter(raw, guardrails.brands);
    if (blockedDropped) {
      emit(nowEvent("brand_filter", `Dropped ${blockedDropped} blocked-brand hit(s) for ${ingredient.name}`));
    }

    if (!raw.length) {
      missingFlags += 1;
      lines.push({
        ingredientId: ingredient.id,
        ingredientName: ingredient.name,
        candidate: {
          productId: "none",
          variantId: "none",
          name: "No match",
          merchant: winner.label,
          merchantDomain: winner.domain,
          price: { amount: 0, currency: "SGD" },
          available: false,
        },
        quantity: 1,
        status: "flagged",
        reason: `no available candidate on ${winner.label}`,
        alternatives: [],
      });
      emit(nowEvent("error", `Flagged ${ingredient.name}: no match on ${winner.label}`));
      continue;
    }

    if (!allowed.length) {
      blockedFlags += 1;
      lines.push({
        ingredientId: ingredient.id,
        ingredientName: ingredient.name,
        candidate: raw[0],
        quantity: 1,
        status: "flagged",
        reason: "every candidate was a blocked brand — not swapped silently",
        alternatives: raw,
      });
      emit(nowEvent("brand_filter", `Flagged ${ingredient.name}: no allowed brand left`));
      continue;
    }

    const picked = pickCandidate(ingredient, preferredFirst, preferred);
    if (!picked) {
      missingFlags += 1;
      continue;
    }
    emit(nowEvent("pick", `${ingredient.name} → ${picked.candidate.name} (${picked.reason})`));
    lines.push({
      ingredientId: ingredient.id,
      ingredientName: ingredient.name,
      candidate: picked.candidate,
      quantity: 1,
      status: "selected",
      reason: picked.reason,
      alternatives: preferredFirst.filter((c) => c.variantId !== picked.candidate.variantId),
    });
  }

  const brandsDetail =
    blockedFlags > 0
      ? `${blockedFlags} item(s) flagged — blocked brands never selected`
      : preferred.length
        ? "Preferred brands ranked first when available"
        : "No brand lists set";

  const windowSet = Boolean(guardrails.delivery?.window && guardrails.delivery.window !== "any");

  if (!quoteLines(lines).length) {
    const result: PlanResult = {
      merchant: winnerScore,
      scores,
      lines,
      quote: null,
      events: [],
      guardrails: chips({
        quote: null,
        budget: guardrails.budget.amount,
        delivery: { ok: false, detail: "No items to ship" },
        brandsDetail,
        windowNotGuaranteed: windowSet,
      }),
      canApprove: false,
      message: "No purchasable items on the winning merchant. Relax brands or the recipe.",
    };
    return result;
  }

  let quote = await quoteCart(lines, emit);
  let delivery = checkDelivery(quote.shippingOptions, guardrails.delivery?.latestDate);

  if (delivery.ok && delivery.option && !delivery.option.selected) {
    emit(nowEvent("delivery_check", `Selecting ${delivery.option.name} to meet ${guardrails.delivery?.latestDate}`));
    quote = await provider.selectShippingOption(quote.id, delivery.option.id);
    delivery = checkDelivery(quote.shippingOptions, guardrails.delivery?.latestDate);
  }

  if (!delivery.ok) {
    emit(nowEvent("delivery_check", delivery.detail));
    return {
      merchant: winnerScore,
      scores,
      lines,
      quote,
      events: [],
      guardrails: chips({
        quote,
        budget: guardrails.budget.amount,
        delivery,
        brandsDetail,
        windowNotGuaranteed: windowSet,
      }),
      canApprove: false,
      message: `${delivery.detail} Relax the date to continue.`,
    };
  }

  emit(nowEvent("delivery_check", delivery.detail));

  let requotes = 0;
  while (quote.finalAmount.amount > guardrails.budget.amount && requotes < 5) {
    emit(nowEvent("over_budget", `S$${quote.finalAmount.amount.toFixed(2)} over S$${guardrails.budget.amount.toFixed(2)}`));
    requotes += 1;

    const optionalLive = lines.find(
      (l) =>
        (l.status === "selected" || l.status === "swapped") &&
        needed.find((i) => i.id === l.ingredientId)?.optional,
    );
    if (optionalLive) {
      optionalLive.status = "dropped";
      optionalLive.reason = "dropped optional item to fit budget";
      emit(nowEvent("drop", `Dropped optional ${optionalLive.ingredientName}`));
    } else {
      const live = lines.filter((l) => l.status === "selected" || l.status === "swapped");
      const priciest = [...live].sort((a, b) => b.candidate.price.amount - a.candidate.price.amount)[0];
      const cheaper = priciest?.alternatives
        .filter((c) => c.available && c.price.amount < priciest.candidate.price.amount)
        .sort((a, b) => a.price.amount - b.price.amount)[0];
      if (!priciest || !cheaper) {
        emit(nowEvent("error", "No cheaper swap left. Raise the budget or drop items."));
        break;
      }
      priciest.candidate = cheaper;
      priciest.status = "swapped";
      priciest.reason = `swapped to cheaper ${cheaper.name}`;
      priciest.alternatives = priciest.alternatives.filter((c) => c.variantId !== cheaper.variantId);
      emit(nowEvent("swap", `${priciest.ingredientName} → ${cheaper.name} at S$${cheaper.price.amount.toFixed(2)}`));
    }

    if (!quoteLines(lines).length) break;
    quote = await quoteCart(lines, emit);
    delivery = checkDelivery(quote.shippingOptions, guardrails.delivery?.latestDate);
    if (delivery.ok && delivery.option && !delivery.option.selected) {
      quote = await provider.selectShippingOption(quote.id, delivery.option.id);
      delivery = checkDelivery(quote.shippingOptions, guardrails.delivery?.latestDate);
    }
  }

  const under = quote.finalAmount.amount <= guardrails.budget.amount;
  if (under) emit(nowEvent("ready", `Price lock S$${quote.finalAmount.amount.toFixed(2)} on ${winner.label}`));

  return {
    merchant: winnerScore,
    scores,
    lines,
    quote,
    events: [],
    guardrails: chips({
      quote,
      budget: guardrails.budget.amount,
      delivery,
      brandsDetail,
      windowNotGuaranteed: windowSet,
    }),
    canApprove: under && delivery.ok && Boolean(quote),
    message: under
      ? missingFlags
        ? `${missingFlags} item(s) flagged and omitted from the quote.`
        : undefined
      : "Still over budget after 5 re-quotes. Raise the cap or drop more items.",
  };
}

export async function refreshQuote(
  lines: CartLine[],
  guardrails: Guardrails,
  emit: Emit,
): Promise<{ quote: Quote; guardrails: PlanResult["guardrails"]; canApprove: boolean; message?: string }> {
  const quote = await quoteCart(lines, emit);
  const delivery = checkDelivery(quote.shippingOptions, guardrails.delivery?.latestDate);
  const windowSet = Boolean(guardrails.delivery?.window && guardrails.delivery.window !== "any");
  const under = quote.finalAmount.amount <= guardrails.budget.amount;
  return {
    quote,
    guardrails: chips({
      quote,
      budget: guardrails.budget.amount,
      delivery,
      brandsDetail: "unchanged",
      windowNotGuaranteed: windowSet,
    }),
    canApprove: under && delivery.ok,
    message: under ? undefined : "Refreshed total is over budget. Raise the cap or re-plan.",
  };
}
