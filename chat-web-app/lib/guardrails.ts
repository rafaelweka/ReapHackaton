import type {
  Candidate,
  GuardrailChip,
  Guardrails,
  Quote,
  ShippingOption,
} from "@/lib/types";

function hay(s: string): string {
  return s.toLowerCase();
}

export function brandFilter(
  candidates: Candidate[],
  brands?: Guardrails["brands"],
): { allowed: Candidate[]; blockedDropped: number; preferredFirst: Candidate[] } {
  const blocked = (brands?.blocked ?? []).map(hay).filter(Boolean);
  const preferred = (brands?.preferred ?? []).map(hay).filter(Boolean);

  const allowed = candidates.filter((c) => {
    const n = hay(c.name);
    return !blocked.some((b) => n.includes(b));
  });

  const preferredFirst = [...allowed].sort((a, b) => {
    const ap = preferred.some((p) => hay(a.name).includes(p)) ? 0 : 1;
    const bp = preferred.some((p) => hay(b.name).includes(p)) ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return a.price.amount - b.price.amount;
  });

  return {
    allowed,
    blockedDropped: candidates.length - allowed.length,
    preferredFirst,
  };
}

export function preferredHit(candidate: Candidate, preferred: string[]): boolean {
  const n = hay(candidate.name);
  return preferred.some((p) => p && n.includes(hay(p)));
}

export function checkDelivery(
  options: ShippingOption[],
  latestDate?: string,
): { ok: boolean; option?: ShippingOption; detail: string } {
  if (!latestDate) {
    const selected = options.find((o) => o.selected) ?? options[0];
    return {
      ok: true,
      option: selected,
      detail: selected
        ? `${selected.name} (estimated ${selected.estimatedDelivery?.latest ?? "n/a"})`
        : "No shipping options returned",
    };
  }

  const matching = options.filter((o) => {
    const latest = o.estimatedDelivery?.latest;
    return latest ? latest <= latestDate : false;
  });

  if (!matching.length) {
    return {
      ok: false,
      detail: `No shipping option arrives by ${latestDate}. Estimates are inferred from option names.`,
    };
  }

  const option = matching[0];
  return {
    ok: true,
    option,
    detail: `${option.name} estimated by ${option.estimatedDelivery?.latest} (estimated)`,
  };
}

export function checkBudget(quote: Quote, cap: number): { ok: boolean; detail: string } {
  const ok = quote.finalAmount.amount <= cap + 1e-9;
  return {
    ok,
    detail: ok
      ? `S$${quote.finalAmount.amount.toFixed(2)} ≤ S$${cap.toFixed(2)}`
      : `S$${quote.finalAmount.amount.toFixed(2)} over S$${cap.toFixed(2)}`,
  };
}

export function chips(args: {
  quote: Quote | null;
  budget: number;
  delivery: ReturnType<typeof checkDelivery>;
  brandsDetail: string;
  windowNotGuaranteed: boolean;
}): GuardrailChip[] {
  const budget = args.quote
    ? checkBudget(args.quote, args.budget)
    : { ok: false, detail: "No quote yet" };

  return [
    { id: "budget", label: "Budget", ok: budget.ok, detail: budget.detail },
    {
      id: "delivery",
      label: "Delivery",
      ok: args.delivery.ok,
      detail: args.windowNotGuaranteed
        ? `${args.delivery.detail}. Time window not guaranteed on Reap.`
        : args.delivery.detail,
    },
    { id: "brands", label: "Brands", ok: true, detail: args.brandsDetail },
  ];
}
