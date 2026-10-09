import { audit } from "@/lib/audit";
import { DEMO_SHIPPING, MERCHANTS, sgd } from "@/lib/merchants";
import type {
  Candidate,
  Checkout,
  Enrollment,
  Money,
  Quote,
  ShippingOption,
} from "@/lib/types";

const BASE = process.env.REAP_API_BASE ?? "https://sg.sandbox.api.reap.global";
const VERSION = process.env.REAP_VERSION ?? "2025-02-14";
const SANDBOX = BASE.includes("sandbox");

/** Docs: POST /agentic/checkouts header X-Simulate-Checkout: COMPLETED (sandbox only; rejected in production). */
function simulateCheckoutHeader(method: string, path: string): string | undefined {
  if (!SANDBOX) return undefined;
  if (method !== "POST") return undefined;
  if (path.split("?")[0] !== "/agentic/checkouts") return undefined;
  return "COMPLETED";
}

export class ReapError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public body: unknown,
  ) {
    super(message);
    this.name = "ReapError";
  }
}

function apiKey(): string {
  const key = process.env.REAP_API_KEY;
  if (!key) throw new Error("REAP_API_KEY is missing. Put it in .env.local.");
  return key;
}

function resolveEnrollmentId(override?: string): string {
  const id = override?.trim();
  if (!id) throw new Error("No enrollment ID from this session. Add a card first.");
  return id;
}

function demoEmail(): string {
  return process.env.REAP_DEMO_EMAIL ?? "demo.cook@example.com";
}

/** Public HTTPS origin (Cloudflare tunnel). Reap rejects http://localhost return URLs. */
export function publicOrigin(): string {
  return (process.env.REAP_RETURN_URL ?? "https://example.com").replace(/\/$/, "");
}

export function sandboxReturnUrl(): string {
  return `${publicOrigin()}/?paid=1`;
}

export function enrollmentReturnUrl(): string {
  return `${publicOrigin()}/?enroll=1`;
}

function formatReapError(json: unknown, fallback: string): string {
  const err = json as { error?: { code?: string; message?: string; detail?: unknown } } | null;
  const e = err?.error;
  if (!e) return fallback;
  const detail =
    e.detail == null
      ? ""
      : typeof e.detail === "string"
        ? e.detail
        : JSON.stringify(e.detail);
  return [e.code, e.message, detail].filter(Boolean).join(" — ");
}

async function reapFetch<T>(
  path: string,
  init: {
    method?: string;
    body?: unknown;
    idempotency?: boolean;
  } = {},
): Promise<T> {
  const method = init.method ?? "GET";
  const started = Date.now();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey()}`,
    "Reap-Version": VERSION,
  };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.idempotency) headers["Idempotency-Key"] = crypto.randomUUID();
  const simulate = simulateCheckoutHeader(method, path);
  if (simulate) headers["X-Simulate-Checkout"] = simulate;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });

  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
  }

  const payload = json as {
    id?: string;
    status?: string;
    updatedAt?: string;
    nextAction?: { type?: string; expiresAt?: string } | null;
    paymentMethod?: { last4?: string } | null;
    items?: Array<{ id?: string; status?: string; paymentMethod?: { last4?: string } }>;
    error?: { code?: string; message?: string; detail?: unknown };
  } | null;
  const reqBody = init.body as
    | {
        enrollmentId?: string;
        quoteId?: string;
        presentation?: { returnUrl?: string };
        query?: string;
      }
    | undefined;

  await audit({
    source: "server",
    kind: "reap",
    message: `${method} ${path} → ${res.status}`,
    method,
    path,
    httpStatus: res.status,
    ok: res.ok,
    durationMs: Date.now() - started,
    enrollmentId:
      payload?.id && path.includes("enrollment")
        ? payload.id
        : payload?.items?.find((i) => i.status === "ACTIVE")?.id ?? reqBody?.enrollmentId,
    enrollmentStatus: path.includes("enrollment")
      ? payload?.status ?? payload?.items?.find((i) => i.status === "ACTIVE")?.status
      : undefined,
    checkoutId: path.includes("checkout") ? payload?.id : reqBody?.quoteId,
    checkoutStatus: path.includes("checkout") ? payload?.status : undefined,
    last4: payload?.paymentMethod?.last4 ?? payload?.items?.find((i) => i.status === "ACTIVE")?.paymentMethod?.last4,
    nextAction: payload?.nextAction?.type,
    returnUrl: reqBody?.presentation?.returnUrl,
    errorCode: payload?.error?.code,
    detail: res.ok
      ? {
          query: reqBody?.query,
          "X-Simulate-Checkout": simulate ?? null,
          expiresAt: payload?.nextAction?.expiresAt,
          updatedAt: payload?.updatedAt,
        }
      : payload?.error ?? json,
  });

  if (!res.ok) {
    throw new ReapError(
      res.status,
      payload?.error?.code ?? "HTTP_ERROR",
      formatReapError(json, `Reap ${res.status} on ${path}`),
      json,
    );
  }

  return json as T;
}

type ReapMoney = { amount: number; currency: string };

function asSgd(m?: ReapMoney | null, fallback = 0): Money {
  return sgd(typeof m?.amount === "number" ? m.amount : fallback);
}

type ReapSearchResponse = {
  products: Array<{
    id: string;
    name: string;
    available?: boolean;
    imageUrl?: string;
    merchant: { name: string };
    previewVariant?: {
      id: string;
      name?: string;
      available?: boolean;
      price: ReapMoney;
    };
  }>;
};

async function searchOnce(query: string, merchantName: string, domain: string): Promise<Candidate[]> {
  const data = await reapFetch<ReapSearchResponse>("/agentic/products/search", {
    method: "POST",
    body: {
      query,
      merchantPreference: { mode: "ONLY", merchantName },
      context: { country: "SG", currency: "SGD" },
      filters: { availability: "AVAILABLE_ONLY" },
      pagination: { limit: 8 },
    },
  });

  const out: Candidate[] = [];
  for (const p of data.products ?? []) {
    const variant = p.previewVariant;
    if (!variant?.id) continue;
    out.push({
      productId: p.id,
      variantId: variant.id,
      name: variant.name || p.name,
      merchant: p.merchant?.name ?? merchantName,
      merchantDomain: domain,
      price: asSgd(variant.price),
      available: (p.available ?? true) && (variant.available ?? true),
      imageUrl: p.imageUrl,
    });
  }
  return out;
}

export async function search(query: string, merchantName: string): Promise<Candidate[]> {
  const known = MERCHANTS.find(
    (m) => m.merchantName === merchantName || m.domain === merchantName || m.label === merchantName,
  );
  const aliases = [...new Set([merchantName, known?.merchantName, known?.domain, known?.label].filter(Boolean))] as string[];
  const domain = known?.domain ?? merchantName;
  let lastErr: unknown;
  for (const name of aliases) {
    try {
      return await searchOnce(query, name, domain);
    } catch (err) {
      lastErr = err;
      if (err instanceof ReapError && err.code === "MERCHANT_NOT_RESOLVED") continue;
      throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`Could not search ${merchantName}`);
}

type ReapQuote = {
  id: string;
  expiresAt: string;
  shippingOptions: Array<{
    id: string;
    name: string;
    selected: boolean;
    price: ReapMoney;
    details?: Array<{ key: string; value: string }>;
  }>;
  amountBreakdown: {
    itemsSubtotal: ReapMoney;
    shipping?: ReapMoney;
    tax?: { amount: ReapMoney; includedInPrices?: boolean };
    finalAmount: ReapMoney;
  };
};

function inferDelivery(name: string): ShippingOption["estimatedDelivery"] {
  const n = name.toLowerCase();
  const start = new Date();
  const addDays = (d: number) => {
    const x = new Date(start);
    x.setDate(x.getDate() + d);
    return x.toISOString().slice(0, 10);
  };

  if (n.includes("same")) {
    return { earliest: addDays(0), latest: addDays(0), source: "inferred" };
  }
  if (n.includes("express") || n.includes("next day") || n.includes("priority")) {
    return { earliest: addDays(1), latest: addDays(1), source: "inferred" };
  }
  return { earliest: addDays(2), latest: addDays(5), source: "inferred" };
}

function deliveryFromDetails(
  details?: Array<{ key: string; value: string }>,
): ShippingOption["estimatedDelivery"] | undefined {
  if (!details?.length) return undefined;
  const blob = details.map((d) => `${d.key} ${d.value}`).join(" ");
  const dates = blob.match(/\d{4}-\d{2}-\d{2}/g);
  if (!dates?.length) return undefined;
  return {
    earliest: dates[0],
    latest: dates[dates.length - 1],
    source: "merchant",
  };
}

function mapQuote(raw: ReapQuote): Quote {
  const taxNested = raw.amountBreakdown.tax?.amount;
  return {
    id: raw.id,
    itemsSubtotal: asSgd(raw.amountBreakdown.itemsSubtotal),
    shipping: asSgd(raw.amountBreakdown.shipping),
    tax: asSgd(taxNested),
    finalAmount: asSgd(raw.amountBreakdown.finalAmount),
    expiresAt: raw.expiresAt,
    shippingOptions: (raw.shippingOptions ?? []).map((opt) => ({
      id: opt.id,
      name: opt.name,
      price: asSgd(opt.price),
      selected: opt.selected,
      estimatedDelivery: deliveryFromDetails(opt.details) ?? inferDelivery(opt.name),
    })),
  };
}

export async function createQuote(
  lines: { variantId: string; quantity: number }[],
): Promise<Quote> {
  const raw = await reapFetch<ReapQuote>("/agentic/quotes", {
    method: "POST",
    idempotency: true,
    body: {
      items: lines,
      email: demoEmail(),
      shippingAddress: DEMO_SHIPPING,
    },
  });
  return mapQuote(raw);
}

export async function selectShippingOption(
  quoteId: string,
  shippingOptionId: string,
): Promise<Quote> {
  const raw = await reapFetch<ReapQuote>(
    `/agentic/quotes/${encodeURIComponent(quoteId)}/shipping-option`,
    {
      method: "POST",
      body: { shippingOptionId },
    },
  );
  return mapQuote(raw);
}

type ReapCheckout = {
  id: string;
  status: Checkout["status"];
  orderId?: string | null;
  finalAmount?: ReapMoney | null;
  amount?: ReapMoney | null;
  nextAction?: { type: string; url?: string } | null;
};

function mapCheckout(raw: ReapCheckout): Checkout {
  const charged = raw.finalAmount ?? raw.amount;
  const n = charged?.amount;
  const amount = typeof n === "number" ? n : n != null ? Number(n) : undefined;
  return {
    id: raw.id,
    status: raw.status,
    approvalUrl: raw.nextAction?.url,
    orderId: raw.orderId ?? undefined,
    finalAmount: amount != null && Number.isFinite(amount) ? sgd(amount) : undefined,
  };
}

type ReapEnrollment = {
  id: string;
  status: Enrollment["status"];
  updatedAt?: string;
  nextAction?: { type: string; url?: string; expiresAt?: string } | null;
  paymentMethod?: { last4?: string } | null;
};

function mapEnrollment(raw: ReapEnrollment): Enrollment {
  return {
    id: raw.id,
    status: raw.status,
    approvalUrl: raw.nextAction?.url,
    last4: raw.paymentMethod?.last4 ?? undefined,
    expiresAt: raw.nextAction?.expiresAt,
    updatedAt: raw.updatedAt,
  };
}

const OWNER_ID = "snapdish-demo";

export async function listEnrollments(): Promise<Enrollment[]> {
  const raw = await reapFetch<{ items: ReapEnrollment[] }>(
    `/agentic/enrollments?ownerType=CLIENT_REFERENCE&ownerId=${encodeURIComponent(OWNER_ID)}&limit=100`,
  );
  return (raw.items ?? []).map(mapEnrollment);
}

export async function findActiveEnrollment(): Promise<Enrollment | null> {
  try {
    const items = await listEnrollments();
    const actives = items.filter((e) => e.status === "ACTIVE");
    if (!actives.length) return null;
    return actives.sort((a, b) => (a.updatedAt ?? "").localeCompare(b.updatedAt ?? "")).at(-1) ?? null;
  } catch {
    return null;
  }
}

export async function createEnrollment(returnUrl?: string): Promise<Enrollment> {
  const ready = await findActiveEnrollment();
  if (ready) return ready;
  const raw = await reapFetch<ReapEnrollment>("/agentic/enrollments", {
    method: "POST",
    idempotency: true,
    body: {
      source: "EXTERNAL",
      owner: {
        type: "CLIENT_REFERENCE",
        id: OWNER_ID,
        email: demoEmail(),
      },
      presentation: { type: "REDIRECT", returnUrl: returnUrl || enrollmentReturnUrl() },
    },
  });
  return mapEnrollment(raw);
}

export async function getEnrollment(id: string): Promise<Enrollment> {
  const raw = await reapFetch<ReapEnrollment>(`/agentic/enrollments/${encodeURIComponent(id)}`);
  return mapEnrollment(raw);
}

export async function createCheckout(
  quoteId: string,
  returnUrl?: string,
  enrollmentOverride?: string,
): Promise<Checkout> {
  const raw = await reapFetch<ReapCheckout>("/agentic/checkouts", {
    method: "POST",
    idempotency: true,
    body: {
      quoteId,
      enrollmentId: resolveEnrollmentId(enrollmentOverride),
      presentation: { type: "REDIRECT", returnUrl: returnUrl || sandboxReturnUrl() },
    },
  });
  return mapCheckout(raw);
}

export async function getCheckout(id: string): Promise<Checkout> {
  const raw = await reapFetch<ReapCheckout>(`/agentic/checkouts/${encodeURIComponent(id)}`);
  return mapCheckout(raw);
}
