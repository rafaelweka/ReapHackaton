"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatSgd } from "@/lib/merchants";
import type {
  AgentEvent,
  AuditEvent,
  Checkout,
  DeliveryWindow,
  Enrollment,
  Guardrails,
  PlanResult,
  Recipe,
} from "@/lib/types";
import type { StreamMsg } from "@/lib/sse";

type Step = "input" | "pantry" | "guardrails" | "plan" | "confirm";

const STORE_KEY = "snapdish-session";
const ENROLL_KEY = "enrollmentId";
const PENDING_KEY = "pendingApprove";
const TOKEN_KEY = "enrollToken";
const CHECKOUT_KEY = "checkoutId";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchCheckout(id: string): Promise<Checkout> {
  const res = await fetch(`/api/checkout/${id}?t=${Date.now()}`, { cache: "no-store" });
  const data = (await res.json()) as Checkout & { error?: string };
  if (!res.ok) throw new Error(data.error ?? "Checkout lookup failed");
  return data;
}

async function pollCheckout(
  id: string,
  onTick: (checkout: Checkout) => void,
  stopped?: () => boolean,
): Promise<Checkout> {
  let last: Checkout | null = null;
  for (let i = 0; i < 45; i++) {
    if (stopped?.()) break;
    last = await fetchCheckout(id);
    onTick(last);
    if (last.status === "COMPLETED" || last.status === "FAILED" || last.status === "EXPIRED") {
      return last;
    }
    await sleep(2000);
  }
  if (!last) throw new Error("Checkout lookup failed");
  return last;
}

async function fetchNoStore<T>(url: string): Promise<T> {
  const sep = url.includes("?") ? "&" : "?";
  const res = await fetch(`${url}${sep}t=${Date.now()}`, { cache: "no-store" });
  const data = await res.json();
  if (!res.ok) throw new Error((data as { error?: string }).error ?? "Request failed");
  return data as T;
}

function hostedStepOpen(e: Enrollment): boolean {
  if (e.status !== "REQUIRES_ACTION" || !e.approvalUrl) return false;
  if (!e.expiresAt) return true;
  return new Date(e.expiresAt).getTime() > Date.now();
}

function needCount(recipe: Recipe | null): number {
  return recipe?.ingredients.filter((i) => !i.have).length ?? 0;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read the photo"));
    reader.readAsDataURL(file);
  });
}

async function readSse(res: Response, onMsg: (msg: StreamMsg) => void) {
  if (!res.body) throw new Error("No response body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const chunks = buf.split("\n\n");
    buf = chunks.pop() ?? "";
    for (const chunk of chunks) {
      const line = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      onMsg(JSON.parse(line.slice(6)) as StreamMsg);
    }
  }
}

function Countdown({ expiresAt }: { expiresAt: string }) {
  const [left, setLeft] = useState("");
  useEffect(() => {
    const tick = () => {
      const ms = new Date(expiresAt).getTime() - Date.now();
      if (ms <= 0) {
        setLeft("expired");
        return;
      }
      const s = Math.floor(ms / 1000);
      const m = Math.floor(s / 60);
      setLeft(`${m}m ${String(s % 60).padStart(2, "0")}s`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);
  return <span>{left}</span>;
}

function Icon({
  d,
  size = 16,
  stroke = "currentColor",
}: {
  d: string;
  size?: number;
  stroke?: string;
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

function Mascot({ size = 42 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden className="rtb-wobble" style={{ display: "block" }}>
      <circle cx="20" cy="20" r="20" fill="#2e503d" />
      <path d="M11 24a5 5 0 0 1-1.2-9.8A6.5 6.5 0 0 1 20 9a6.5 6.5 0 0 1 10.2 5.2A5 5 0 0 1 29 24z" fill="#ffffff" />
      <path d="M16 23v-5M20 23v-7M24 23v-5" stroke="#d3e2d6" strokeWidth="1.3" strokeLinecap="round" fill="none" />
      <rect x="11" y="23" width="18" height="8" rx="2.5" fill="#ffffff" />
      <circle className="rtb-eye" cx="16.5" cy="27" r="1.2" fill="#2e503d" />
      <circle className="rtb-eye" cx="23.5" cy="27" r="1.2" fill="#2e503d" />
      <path d="M18.6 28.4q1.4 1.3 2.8 0" stroke="#2e503d" strokeWidth="1.1" strokeLinecap="round" fill="none" />
      <circle cx="14.3" cy="28.6" r="1.2" fill="#f4b9a7" opacity="0.85" />
      <circle cx="25.7" cy="28.6" r="1.2" fill="#f4b9a7" opacity="0.85" />
    </svg>
  );
}

const I = {
  refresh: "M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5",
  wallet: "M3 7h15a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7zM3 7l12-3v3M17 14h.01",
  truck: "M1 6h13v10H1zM14 10h4l4 3v3h-8zM5 19a2 2 0 1 0 4 0 2 2 0 1 0-4 0M16 19a2 2 0 1 0 4 0 2 2 0 1 0-4 0",
  tag: "M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8zM7 7h.01",
  camera: "M3 8a2 2 0 0 1 2-2h2l1.5-2h7L17 6h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  hat: "M7 20h10v-4H7zM6.5 16a4 4 0 0 1-.5-7.9A5 5 0 0 1 12 4a5 5 0 0 1 6 4.1 4 4 0 0 1-.5 7.9",
  check: "M20 6 9 17l-5-5",
  send: "M22 2 11 13M22 2l-7 20-4-9-9-4z",
  lock: "M7 11V8a5 5 0 0 1 10 0v3M6 11h12v10H6z",
};

const GREETING =
  "What are we cooking? Snap a plated dish or a written recipe, paste the text, or name the dish. I will work out the ingredients and shop for what is missing.";

export default function HomePage() {
  const [step, setStep] = useState<Step>("input");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [budget, setBudget] = useState("25");
  const [latestDate, setLatestDate] = useState("");
  const [timeWindow, setTimeWindow] = useState<DeliveryWindow>("any");
  const [preferred, setPreferred] = useState("");
  const [blocked, setBlocked] = useState("");
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [checkout, setCheckout] = useState<Checkout | null>(null);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [cardPageUrl, setCardPageUrl] = useState("");
  const [resumeAfterCard, setResumeAfterCard] = useState(false);
  const [auditLog, setAuditLog] = useState<AuditEvent[]>([]);
  const checkoutStarted = useRef(false);
  const photoRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(Date.now());
  const [draft, setDraft] = useState("");
  const [lastUser, setLastUser] = useState("");
  const [ask, setAsk] = useState<"budget" | "delivery" | "brand" | null>(null);

  function logClient(
    kind: string,
    message: string,
    extra: { enrollmentId?: string; enrollmentStatus?: string; detail?: unknown } = {},
  ) {
    void fetch("/api/audit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, message, ...extra }),
    }).catch(() => undefined);
  }

  function resetLocalCard() {
    sessionStorage.removeItem(ENROLL_KEY);
    sessionStorage.removeItem(PENDING_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(CHECKOUT_KEY);
    setEnrollment(null);
    setCardPageUrl("");
    setResumeAfterCard(false);
    checkoutStarted.current = false;
    logClient("reset", "Cleared local enrollment and checkout ids");
  }

  function loadAudit() {
    fetch("/api/audit")
      .then(async (res) => {
        const data = await res.json();
        if (res.ok) setAuditLog((data.events as AuditEvent[]) ?? []);
      })
      .catch(() => undefined);
  }

  const guardrails: Guardrails = useMemo(() => {
    const g: Guardrails = {
      budget: { amount: Number(budget) || 0, currency: "SGD" },
    };
    if (latestDate || timeWindow !== "any") {
      g.delivery = {
        latestDate: latestDate || undefined,
        window: timeWindow,
      };
    }
    const pref = preferred
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const blk = blocked
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (pref.length || blk.length) g.brands = { preferred: pref, blocked: blk };
    return g;
  }, [budget, latestDate, timeWindow, preferred, blocked]);

  const persist = useCallback((next: { recipe?: Recipe | null; plan?: PlanResult | null; checkoutId?: string }) => {
    const payload = {
      recipe: next.recipe ?? recipe,
      plan: next.plan ?? plan,
      budget,
      latestDate,
      window: timeWindow,
      preferred,
      blocked,
      checkoutId: next.checkoutId ?? sessionStorage.getItem(CHECKOUT_KEY) ?? undefined,
    };
    sessionStorage.setItem(STORE_KEY, JSON.stringify(payload));
  }, [recipe, plan, budget, latestDate, timeWindow, preferred, blocked]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [step, busy, plan, events.length, lastUser, error, checkout]);

  useEffect(() => {
    loadAudit();
    const id = setInterval(loadAudit, 3000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("reset") === "1") {
      sessionStorage.removeItem(STORE_KEY);
      sessionStorage.removeItem(ENROLL_KEY);
      sessionStorage.removeItem(PENDING_KEY);
      sessionStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(CHECKOUT_KEY);
      window.history.replaceState({}, "", "/");
    }
    const raw = sessionStorage.getItem(STORE_KEY);
    let savedCheckoutId = "";
    if (raw) {
      try {
        const saved = JSON.parse(raw) as {
          recipe?: Recipe;
          plan?: PlanResult;
          budget?: string;
          latestDate?: string;
          window?: DeliveryWindow;
          preferred?: string;
          blocked?: string;
          checkoutId?: string;
        };
        if (saved.recipe) setRecipe(saved.recipe);
        if (saved.plan) setPlan(saved.plan);
        if (saved.budget) setBudget(saved.budget);
        if (saved.latestDate) setLatestDate(saved.latestDate);
        if (saved.window) setTimeWindow(saved.window);
        if (saved.preferred) setPreferred(saved.preferred);
        if (saved.blocked) setBlocked(saved.blocked);
        savedCheckoutId = saved.checkoutId ?? "";
        if (saved.plan) setStep("plan");
        else if (saved.recipe && !params.get("paid") && !params.get("checkoutId")) setStep("pantry");
      } catch {
        /* ignore */
      }
    }
    const checkoutId =
      params.get("checkoutId") ?? sessionStorage.getItem(CHECKOUT_KEY) ?? savedCheckoutId;

    const token = params.get("t");
    const eid =
      (token ? sessionStorage.getItem(`enroll:${token}`) : null) ||
      sessionStorage.getItem(ENROLL_KEY);

    const adopt = (data: Enrollment) => {
      sessionStorage.setItem(ENROLL_KEY, data.id);
      setEnrollment(data);
      if (data.approvalUrl) setCardPageUrl(data.approvalUrl);
    };

    const resolveCard = async (useOwnerList: boolean): Promise<Enrollment | null> => {
      if (eid) {
        const current = await fetchNoStore<Enrollment>(`/api/enrollment/${eid}`);
        if (current.status === "ACTIVE") {
          adopt(current);
          return current;
        }
        if (!useOwnerList) {
          adopt(current);
          return current;
        }
      }
      const owner = await fetchNoStore<{ active: Enrollment | null }>("/api/enrollment");
      if (owner.active?.status === "ACTIVE") {
        adopt(owner.active);
        return owner.active;
      }
      if (!eid) return null;
      const current = await fetchNoStore<Enrollment>(`/api/enrollment/${eid}`);
      adopt(current);
      return current;
    };

    void resolveCard(true).catch(() => undefined);

    if (params.get("enroll") === "1") {
      setResumeAfterCard(true);
      setBusy(true);
      let ticks = 0;
      let done = false;
      let poll = 0;
      let stop = 0;
      const finish = (message?: string) => {
        if (done) return;
        done = true;
        window.clearInterval(poll);
        window.clearTimeout(stop);
        setBusy(false);
        if (message) setError(message);
        else {
          setError("");
          window.history.replaceState({}, "", "/");
        }
      };
      const pollCard = () =>
        resolveCard(++ticks === 1 || ticks % 3 === 0).then((data) => {
          if (data) {
            logClient("enroll_return", `GET enrollment ${data.id} status ${data.status}`, {
              enrollmentId: data.id,
              enrollmentStatus: data.status,
              detail: { last4: data.last4, expiresAt: data.expiresAt, updatedAt: data.updatedAt },
            });
          }
          return data;
        });
      void pollCard()
        .then((data) => {
          if (data?.status === "ACTIVE") finish();
        })
        .catch((err: unknown) => {
          finish(err instanceof Error ? err.message : "Enrollment lookup failed");
        });
      poll = window.setInterval(() => {
        void pollCard()
          .then((data) => {
            if (!data) return;
            if (data.status === "ACTIVE") {
              finish();
              return;
            }
            if (data.status === "FAILED" || data.status === "EXPIRED" || data.status === "REVOKED") {
              finish(`Card enrollment ${data.status}. Forget the saved card and open a new Reap card page.`);
              return;
            }
            const windowGone = data.expiresAt && new Date(data.expiresAt).getTime() <= Date.now();
            if (windowGone) {
              finish(
                "This enrollment’s nextAction.expiresAt has passed, so Reap will not flip it to ACTIVE. Start a new enrollment.",
              );
            }
          })
          .catch(() => undefined);
      }, 2000);
      stop = window.setTimeout(() => {
        finish(
          "Redirect is not proof of success. Fresh GET /agentic/enrollments/:id still was not ACTIVE. If Prava said complete, we now also look up any ACTIVE card for this owner — refresh this page. Sandbox OTP is 456789 if a code was asked.",
        );
      }, 120000);
      return () => {
        done = true;
        window.clearInterval(poll);
        window.clearTimeout(stop);
      };
    }

    const returningPaid = params.get("paid") === "1" || Boolean(checkoutId);
    if (!returningPaid) return;

    window.history.replaceState({}, "", "/");
    setStep("confirm");
    if (!checkoutId) {
      setError("Reap finished, but this tab lost the checkout id. Keep this chat open next time — checkout now stays here while Reap opens in another tab.");
      return;
    }
    sessionStorage.setItem(CHECKOUT_KEY, checkoutId);
    setBusy(true);
    let cancelled = false;
    void pollCheckout(checkoutId, (data) => {
      if (!cancelled) setCheckout(data);
    }, () => cancelled)
      .then((data) => {
        if (cancelled) return;
        if (data.status !== "COMPLETED") {
          setError(`Checkout is ${data.status}. If Reap said it succeeded, wait a moment or open the Reap tab again.`);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Checkout lookup failed");
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function parse(input: { kind: "sample" } | { kind: "text"; text: string } | { kind: "photo"; imageBase64: string }) {
    setError("");
    setBusy(true);
    try {
      const res = await fetch("/api/recipe/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Parse failed");
      setRecipe(data as Recipe);
      setStep("pantry");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Parse failed");
    } finally {
      setBusy(false);
    }
  }

  async function onPhoto(file: File | null) {
    if (!file) return;
    const imageBase64 = await readFileAsDataUrl(file);
    await parse({ kind: "photo", imageBase64 });
  }

  async function runPlan(nextGuardrails: Guardrails = guardrails) {
    if (!recipe) return;
    const amount = nextGuardrails.budget.amount;
    if (!(amount > 0)) {
      setError("Enter a positive budget in SGD before the agent starts.");
      return;
    }
    setError("");
    setEvents([]);
    setPlan(null);
    setStep("plan");
    setBusy(true);
    try {
      const res = await fetch("/api/cart/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          needed: recipe.ingredients.filter((i) => !i.have),
          guardrails: nextGuardrails,
        }),
      });
      if (!res.ok && res.headers.get("content-type")?.includes("application/json")) {
        const data = await res.json();
        throw new Error(data.error ?? "Plan failed");
      }
      await readSse(res, (msg) => {
        if (msg.type === "event") setEvents((prev) => [...prev, msg.event]);
        if (msg.type === "done") {
          setPlan(msg.result);
          persist({ recipe, plan: msg.result });
        }
        if (msg.type === "error") setError(msg.message);
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Plan failed");
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    if (!plan) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/cart/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lines: plan.lines, guardrails }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Refresh failed");
      const next: PlanResult = {
        ...plan,
        quote: data.quote,
        guardrails: data.guardrails,
        canApprove: data.canApprove,
        message: data.message,
        events: [...plan.events, ...(data.events ?? [])],
      };
      setPlan(next);
      setEvents((prev) => [...prev, ...(data.events ?? [])]);
      persist({ plan: next });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Refresh failed");
    } finally {
      setBusy(false);
    }
  }

  async function startCheckout(enrollmentId: string, quoteId: string, hostedWindow?: Window | null) {
    const res = await fetch("/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quoteId, enrollmentId }),
    });
    const data = (await res.json()) as Checkout & { error?: string };
    if (!res.ok) throw new Error(data.error ?? "Checkout failed");
    sessionStorage.removeItem(PENDING_KEY);
    sessionStorage.setItem(CHECKOUT_KEY, data.id);
    persist({ recipe, plan, checkoutId: data.id });
    setCheckout(data);
    setStep("confirm");

    if (data.status === "COMPLETED") {
      hostedWindow?.close();
      return;
    }

    if (data.approvalUrl) {
      setCardPageUrl(data.approvalUrl);
      if (hostedWindow && !hostedWindow.closed) {
        hostedWindow.location.href = data.approvalUrl;
      }
    }

    const final = await pollCheckout(data.id, setCheckout);
    if (final.status === "COMPLETED") {
      hostedWindow?.close();
      setCardPageUrl("");
      return;
    }
    throw new Error(
      final.approvalUrl || data.approvalUrl
        ? `Checkout is ${final.status}. Finish it in the Reap tab, or tap Open Reap checkout.`
        : `Checkout is ${final.status} and Reap did not return an approval URL`,
    );
  }

  async function approve() {
    if (!plan?.quote) return;
    setBusy(true);
    setError("");
    persist({ recipe, plan });
    const hosted = window.open("about:blank", "reap-checkout");
    try {
      const owner = await fetchNoStore<{ active: Enrollment | null }>("/api/enrollment");
      if (owner.active?.status === "ACTIVE") {
        sessionStorage.setItem(ENROLL_KEY, owner.active.id);
        setEnrollment(owner.active);
        logClient("enroll_reuse", `Using existing ACTIVE enrollment ${owner.active.id}`, {
          enrollmentId: owner.active.id,
          enrollmentStatus: owner.active.status,
          detail: { last4: owner.active.last4 },
        });
        await startCheckout(owner.active.id, plan.quote.id, hosted);
        return;
      }

      hosted?.close();

      const existing = sessionStorage.getItem(ENROLL_KEY);
      if (existing) {
        const current = await fetchNoStore<Enrollment>(`/api/enrollment/${existing}`);
        setEnrollment(current);
        if (current.status === "ACTIVE") {
          await startCheckout(current.id, plan.quote.id, window.open("about:blank", "reap-checkout"));
          return;
        }
        if (hostedStepOpen(current)) {
          setCardPageUrl(current.approvalUrl ?? "");
          window.location.href = current.approvalUrl ?? "";
          return;
        }
      }

      const token = crypto.randomUUID();
      sessionStorage.setItem(TOKEN_KEY, token);
      const res = await fetch("/api/enrollment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = (await res.json()) as Enrollment & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Could not start card enrollment");
      sessionStorage.setItem(ENROLL_KEY, data.id);
      sessionStorage.setItem(`enroll:${token}`, data.id);
      sessionStorage.setItem(PENDING_KEY, "1");
      setEnrollment(data);
      logClient("enroll_start", `Enrollment ${data.id} status ${data.status}`, {
        enrollmentId: data.id,
        enrollmentStatus: data.status,
        detail: { last4: data.last4 },
      });
      if (data.status === "ACTIVE") {
        await startCheckout(data.id, plan.quote.id, window.open("about:blank", "reap-checkout"));
        return;
      }
      if (!data.approvalUrl) throw new Error("Enrollment did not return a card-entry URL");
      setCardPageUrl(data.approvalUrl);
      window.location.href = data.approvalUrl;
    } catch (err) {
      hosted?.close();
      setError(err instanceof Error ? err.message : "Checkout failed");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!resumeAfterCard) return;
    if (enrollment?.status !== "ACTIVE") return;
    if (!plan?.quote || !plan.canApprove) return;
    if (checkoutStarted.current) return;
    checkoutStarted.current = true;
    setBusy(true);
    void startCheckout(enrollment.id, plan.quote.id)
      .catch((err: unknown) => {
        checkoutStarted.current = false;
        setError(err instanceof Error ? err.message : "Checkout failed");
      })
      .finally(() => setBusy(false));
  }, [resumeAfterCard, enrollment, plan]);

  const expired = plan?.quote ? new Date(plan.quote.expiresAt).getTime() <= now : false;
  const suggested = recipe?.ingredients.some((i) => i.suggested);
  const cardReady = enrollment?.status === "ACTIVE";
  const quoteTotal = plan?.quote ? formatSgd(plan.quote.finalAmount.amount) : "";
  const budgetAmt = Number(budget) || 0;
  const spent = plan?.quote?.finalAmount.amount ?? 0;
  const meterPct = budgetAmt > 0 ? Math.min(100, (spent / budgetAmt) * 100) : 0;
  const overBudget = budgetAmt > 0 && spent > budgetAmt;
  const ship = plan?.quote?.shippingOptions.find((o) => o.selected);

  function newOrder() {
    resetLocalCard();
    sessionStorage.removeItem(STORE_KEY);
    window.location.href = "/?reset=1";
  }

  function markHave(id: string) {
    if (!recipe) return;
    setRecipe({
      ...recipe,
      ingredients: recipe.ingredients.map((i) => (i.id === id ? { ...i, have: !i.have } : i)),
    });
  }

  function applyHaveFromText(raw: string) {
    if (!recipe) return;
    const lower = raw.toLowerCase();
    setRecipe({
      ...recipe,
      ingredients: recipe.ingredients.map((ing) => {
        const hit = ing.name
          .toLowerCase()
          .split(/\s+/)
          .some((w) => w.length > 3 && lower.includes(w));
        return hit ? { ...ing, have: true } : ing;
      }),
    });
  }

  async function handleSend(raw?: string) {
    const t = (raw ?? draft).trim();
    if (!t || busy) return;
    setDraft("");
    setLastUser(t);
    if (step === "input") {
      await parse({ kind: "text", text: t });
      return;
    }
    if (step === "pantry") {
      if (/have|got|already/i.test(t)) applyHaveFromText(t);
      else setStep("guardrails");
      return;
    }
    const money = t.replace(/,/g, "").match(/(\d+(?:\.\d+)?)/);
    if (ask === "budget" || /budget|under|sgd|\$/i.test(t)) {
      if (money) setBudget(money[1]);
      setAsk(null);
      if (step === "input" && !recipe) return;
      if (step === "pantry") setStep("guardrails");
      return;
    }
    if (ask === "delivery" || /\bby\b|deliver/i.test(t)) {
      const iso = t.match(/\d{4}-\d{2}-\d{2}/);
      if (iso) setLatestDate(iso[0]);
      setAsk(null);
      return;
    }
    if (ask === "brand" || /avoid|prefer|brand/i.test(t)) {
      const avoid = t.match(/avoid\s+(.+)/i);
      const pref = t.match(/prefer\s+(.+)/i);
      if (avoid) setBlocked(avoid[1].trim());
      if (pref) setPreferred(pref[1].trim());
      setAsk(null);
      return;
    }
    if (step === "guardrails") {
      if (money) setBudget(money[1]);
      void runPlan();
    }
  }

  const chips: { label: string; ghost?: boolean; onClick: () => void; icon?: string }[] = [];
  if (step === "input") {
    chips.push(
      { label: "Use sample recipe", icon: I.hat, onClick: () => { setLastUser("Use the sample recipe"); void parse({ kind: "sample" }); } },
      { label: "Scan a dish or recipe", icon: I.camera, ghost: true, onClick: () => photoRef.current?.click() },
    );
  } else if (step === "pantry") {
    chips.push({ label: "Looks good — set budget", onClick: () => setStep("guardrails") });
  } else if (step === "guardrails") {
    chips.push(
      { label: "Shop missing items", onClick: () => void runPlan() },
      { label: "Under S$25", ghost: true, onClick: () => { setBudget("25"); setLastUser("under $25"); } },
      { label: "Under S$40", ghost: true, onClick: () => { setBudget("40"); setLastUser("under $40"); } },
    );
  } else if (step === "plan" && plan) {
    if (expired) chips.push({ label: "Refresh price", icon: I.refresh, onClick: () => void refresh() });
    if (!plan.canApprove && latestDate) {
      chips.push({
        label: "Relax delivery date",
        ghost: true,
        onClick: () => {
          setLatestDate("");
          void runPlan({ ...guardrails, delivery: { window: timeWindow === "any" ? undefined : timeWindow } });
        },
      });
    }
    if (plan.canApprove && !expired && plan.quote) {
      if (cardReady) chips.push({ label: `Pay ${quoteTotal}`, onClick: () => void approve() });
      else if (cardPageUrl) chips.push({ label: "Continue card page", onClick: () => { window.location.href = cardPageUrl; } });
      else chips.push({ label: "Add sandbox card", onClick: () => void approve() });
    }
  } else if (step === "confirm") {
    if (cardPageUrl && checkout?.status !== "COMPLETED") {
      chips.push({
        label: "Open Reap checkout",
        onClick: () => {
          window.open(cardPageUrl, "reap-checkout");
        },
      });
    }
    chips.push({ label: "New recipe", icon: I.refresh, ghost: true, onClick: newOrder });
  }

  let agentText = GREETING;
  if (step === "pantry") {
    agentText =
      recipe?.source === "plated_dish"
        ? `${recipe.notes || `Looks like ${recipe.title}.`} I filled in a typical home recipe — tap anything you already have.`
        : suggested
          ? `${recipe?.notes || "I guessed the ingredients from the dish name."} Tap a row if you already have it.`
          : "Tick what is already in the pantry. Unticked items go in the basket.";
  } else if (step === "guardrails") {
    agentText = ask === "budget"
      ? "What is the most you want to spend, including delivery? Try “under $25”."
      : ask === "delivery"
        ? "When do you need it by? Pick a date or type one, like 2026-10-14."
        : ask === "brand"
          ? "Which brands should I prefer or avoid? Try “avoid XYZ”."
          : `I need ${needCount(recipe)} items. Set a budget, then I will shop one Singapore merchant.`;
  } else if (step === "plan" && !plan) {
    agentText = "Shopping now. I will lock one merchant and hold the price.";
  } else if (step === "plan" && plan) {
    agentText = plan.message || `Locked ${plan.merchant.label}. Approve on Reap when you are ready — the agent never sees your card.`;
  } else if (step === "confirm") {
    agentText =
      checkout?.status === "COMPLETED"
        ? "Approved. You are ready to cook."
        : "Finish checkout in the Reap tab. This chat stays open and will show the receipt when Reap marks it complete.";
  }

  const placeholder =
    step === "input"
      ? "Type a dish, paste a recipe, or snap a photo…"
      : ask === "budget"
        ? "e.g. under $25"
        : "Type a reply or a rule…";


  return (
    <main className="phone">
      <input
        ref={photoRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0] ?? null;
          if (file) {
            setLastUser("Here's a photo");
            void onPhoto(file);
          }
        }}
      />

      <header className="phone-head">
        <div className="phone-brand">
          <Mascot />
          <div>
            <div className="phone-title">Recipe to basket</div>
            <div className="phone-sub">REAP sandbox demo</div>
          </div>
        </div>
        <button type="button" className="ghost" onClick={newOrder}>
          <Icon d={I.refresh} stroke="#606c62" />
          <span>New recipe</span>
        </button>
      </header>

      <div className="rules" role="group" aria-label="Your rules">
        <button type="button" className={`rule${ask === "budget" || budgetAmt > 0 ? " on" : ""}`} onClick={() => setAsk("budget")}>
          <Icon d={I.wallet} stroke="#2e503d" />
          <span>
            <span className="rule-k">Budget</span>
            <span className="rule-v">{budgetAmt > 0 ? `S$${budget}` : "Not set"}</span>
          </span>
        </button>
        <button type="button" className={`rule${ask === "delivery" || latestDate ? " on" : ""}`} onClick={() => setAsk("delivery")}>
          <Icon d={I.truck} stroke="#2e503d" />
          <span>
            <span className="rule-k">Delivery</span>
            <span className="rule-v">{latestDate || timeWindow !== "any" ? latestDate || timeWindow : "Any day"}</span>
          </span>
        </button>
        <button type="button" className={`rule${ask === "brand" || preferred || blocked ? " on" : ""}`} onClick={() => setAsk("brand")}>
          <Icon d={I.tag} stroke="#2e503d" />
          <span>
            <span className="rule-k">Brands</span>
            <span className="rule-v">{preferred || blocked ? [preferred && `prefer ${preferred}`, blocked && `avoid ${blocked}`].filter(Boolean).join(" · ") : "Any"}</span>
          </span>
        </button>
      </div>

      <div className="log" ref={logRef} role="log" aria-live="polite" aria-label="Conversation">
        <div className="log-inner">
          {step === "input" ? (
            <div className="hero">
              <div className="hero-art">
                <div className="rtb-float">
                  <Mascot size={96} />
                </div>
                <svg className="rtb-twinkle twinkle a" width="18" height="18" viewBox="0 0 24 24" aria-hidden>
                  <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" fill="#f2c14e" />
                </svg>
                <svg className="rtb-twinkle twinkle b" width="14" height="14" viewBox="0 0 24 24" aria-hidden>
                  <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" fill="#f08a6b" />
                </svg>
              </div>
              <div className="hero-shadow rtb-shadow" />
            </div>
          ) : null}

          <div className="row">
            <div className="rtb-hop">
              <Mascot size={30} />
            </div>
            <div className="bubble">{agentText}</div>
          </div>

          {lastUser ? <div className="bubble user">{lastUser}</div> : null}

          {error ? <p className="alert" role="alert">{error}</p> : null}

          {step === "pantry" && recipe ? (
            <div className="card">
              <div className="card-head">
                <div className="card-title">
                  <Icon d={I.hat} stroke="#2e503d" />
                  <span>{recipe.title}</span>
                </div>
                <div className="ing-meta">{recipe.servings} servings · {needCount(recipe)} to buy</div>
              </div>
              {recipe.ingredients.map((ing) => (
                <button type="button" className="ing" key={ing.id} onClick={() => markHave(ing.id)}>
                  <span>
                    <span className="ing-name">{ing.name}</span>
                    <span className="ing-meta">{ing.quantity}{ing.optional ? " · optional" : ""}</span>
                  </span>
                  <span className={`ing-tag ${ing.have ? "have" : "need"}`}>
                    {ing.have ? "in pantry" : "need"}
                  </span>
                </button>
              ))}
              {recipe.method && recipe.method.length > 0 ? (
                <div className="note">
                  <div style={{ fontWeight: 600, color: "#24372c", marginBottom: 4 }}>How to cook</div>
                  {recipe.method.map((step, i) => (
                    <div className="shop-step" key={`${i}-${step.slice(0, 24)}`}>
                      <span>{i + 1}.</span>
                      <span>{step}</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {step === "guardrails" ? (
            <div className="card">
              <div className="card-head">
                <div className="card-title">Your rules</div>
                <div className="ing-meta">{recipe ? `${needCount(recipe)} to buy` : ""}</div>
              </div>
              <label className="ing">
                <span>
                  <span className="ing-name">Budget cap (SGD)</span>
                  <span className="ing-meta">Required before shopping</span>
                </span>
                <input type="number" min={0.01} step={0.01} value={budget} onChange={(e) => setBudget(e.target.value)} style={{ width: 88, height: 36, borderRadius: 10, border: "1px solid #cfd9d0", padding: "0 8px" }} />
              </label>
              <label className="ing">
                <span>
                  <span className="ing-name">Latest delivery</span>
                  <span className="ing-meta">Optional</span>
                </span>
                <input type="date" value={latestDate} onChange={(e) => setLatestDate(e.target.value)} style={{ height: 36, borderRadius: 10, border: "1px solid #cfd9d0", padding: "0 8px" }} />
              </label>
            </div>
          ) : null}

          {step === "plan" ? (
            <div className="card">
              <div className="card-head">
                <div className="card-title">
                  <div className="rtb-wobble"><Mascot size={28} /></div>
                  <span>Shopping{plan ? ` at ${plan.merchant.label}` : ""}</span>
                </div>
                <div className="ing-meta">{plan ? `${plan.merchant.hits} hits` : "live catalog"}</div>
              </div>
              {events.slice(-6).map((e, i) => (
                <div className="shop-step" key={`${e.ts}-${i}`}>
                  <Icon d={I.check} size={14} stroke="#2e503d" />
                  <span>{e.message.length > 88 ? `${e.message.slice(0, 85)}…` : e.message}</span>
                </div>
              ))}
              {busy && events.length === 0 ? (
                <div className="shop-step"><span>Waiting for the agent…</span></div>
              ) : null}
            </div>
          ) : null}

          {step === "plan" && plan ? (
            <div className="card">
              <div className="card-head">
                <div className="card-title">Your basket</div>
                {plan.quote ? (
                  <div className="ing-meta" style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <Icon d={I.lock} size={14} stroke="#606c62" />
                    Price held <Countdown expiresAt={plan.quote.expiresAt} />
                  </div>
                ) : null}
              </div>
              {plan.lines.map((line) => (
                <div className="line" key={line.ingredientId}>
                  <div>
                    <div className="ing-name">{line.candidate.name}</div>
                    <div className="ing-meta">{line.ingredientName} · {line.status}</div>
                  </div>
                  <div style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{formatSgd(line.candidate.price.amount)}</div>
                </div>
              ))}
              {plan.quote ? (
                <div className="totals">
                  <div><span>Items</span><span>{formatSgd(plan.quote.itemsSubtotal.amount)}</span></div>
                  <div><span>{ship?.name ?? "Shipping"}</span><span>{formatSgd(plan.quote.shipping.amount)}</span></div>
                  <div><span>Tax</span><span>{formatSgd(plan.quote.tax.amount)}</span></div>
                  <div className="grand"><span>Total</span><span>{formatSgd(plan.quote.finalAmount.amount)}</span></div>
                </div>
              ) : null}
              {budgetAmt > 0 && plan.quote ? (
                <div style={{ padding: "4px 0 10px" }}>
                  <div className="meter">
                    <span style={{ width: `${meterPct}%`, background: overBudget ? "#8f3a2a" : "#2e503d" }} />
                  </div>
                  <div className="ing-meta" style={{ marginTop: 4 }}>
                    {overBudget ? "Over budget" : `${formatSgd(spent)} of ${formatSgd(budgetAmt)}`}
                  </div>
                </div>
              ) : null}
              <div style={{ paddingTop: 8, borderTop: "1px solid #e8eee8" }}>
                <div style={{ fontSize: 11, letterSpacing: "0.6px", textTransform: "uppercase", color: "#606c62", paddingBottom: 4 }}>Rule checks</div>
                {plan.guardrails.map((g) => (
                  <div className="check" key={g.id}>
                    <Icon d={g.ok ? I.check : "M18 6 6 18M6 6l12 12"} size={14} stroke={g.ok ? "#2e503d" : "#8f3a2a"} />
                    <div>
                      <span style={{ fontWeight: 600 }}>{g.label}</span>
                      <span style={{ color: "#606c62" }}> · {g.detail}</span>
                    </div>
                  </div>
                ))}
              </div>
              {enrollment?.last4 ? (
                <div className="note"><span style={{ fontWeight: 600, color: "#24372c" }}>Card:</span> Visa •••• {enrollment.last4} · {enrollment.status}</div>
              ) : (
                <div className="note"><span style={{ fontWeight: 600, color: "#24372c" }}>Card:</span> {enrollment?.status ?? "none stored yet"}</div>
              )}
              {plan.canApprove && plan.quote && !expired ? (
                <button type="button" className="primary" disabled={busy} onClick={() => void approve()}>
                  {cardReady ? `Approve ${quoteTotal}` : cardPageUrl ? "Continue Reap card page" : "Add sandbox card (S$0 is OK)"}
                </button>
              ) : (
                <button type="button" className="primary" disabled>
                  {expired ? "Price lock expired" : "Cannot approve yet"}
                </button>
              )}
              <div className="fine">
                <Icon d={I.lock} size={12} stroke="#606c62" />
                <span>You approve on REAP&apos;s page. The agent never sees your card.</span>
              </div>
            </div>
          ) : null}

          {step === "confirm" ? (
            <div className="card receipt">
              <div className="card-head">
                <div className="card-title">
                  <div className="rtb-hop"><Mascot size={28} /></div>
                  <div>
                    <div style={{ fontWeight: 700 }}>
                      {checkout?.status === "COMPLETED" ? "Approved" : "Waiting for Reap"}
                    </div>
                    <div className="ing-meta">Order {checkout?.orderId ?? checkout?.id ?? "pending"}</div>
                  </div>
                </div>
              </div>
              {recipe ? <div className="ing-meta" style={{ paddingBottom: 6 }}>{recipe.title}</div> : null}
              {(plan?.lines ?? []).filter((l) => l.status === "selected" && l.candidate).map((l) => (
                <div className="line" key={l.ingredientId} style={{ borderColor: "#d3e0d3", fontSize: 13 }}>
                  <span>{l.candidate.name}</span>
                  <span style={{ fontVariantNumeric: "tabular-nums" }}>{formatSgd(l.candidate.price.amount)}</span>
                </div>
              ))}
              <div className="line" style={{ borderColor: "#d3e0d3", fontWeight: 600 }}>
                <span>Total charged</span>
                <span>
                  {checkout?.finalAmount
                    ? formatSgd(checkout.finalAmount.amount)
                    : quoteTotal || "pending"}
                </span>
              </div>
              <div className="ing-meta">{checkout?.status ?? "Waiting for Reap checkout…"}</div>
              {enrollment?.last4 ? <div className="ing-meta">Visa •••• {enrollment.last4}</div> : null}
              {cardPageUrl && checkout?.status !== "COMPLETED" ? (
                <button
                  type="button"
                  className="primary"
                  style={{ marginTop: 10 }}
                  onClick={() => {
                    window.open(cardPageUrl, "reap-checkout");
                  }}
                >
                  Open Reap checkout
                </button>
              ) : null}
            </div>
          ) : null}

          {busy ? (
            <div className="row">
              <div className="rtb-hop"><Mascot size={30} /></div>
              <div className="typing" role="status" aria-label="The assistant is typing">
                <span className="rtb-dot" />
                <span className="rtb-dot" style={{ animationDelay: "0.15s" }} />
                <span className="rtb-dot" style={{ animationDelay: "0.3s" }} />
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="composer">
        <div className="chips" role="group" aria-label="Quick replies">
          {chips.map((c) => (
            <button key={c.label} type="button" className={`chip${c.ghost ? " ghost" : ""}`} disabled={busy} onClick={c.onClick}>
              {c.icon ? <Icon d={c.icon} size={16} stroke="#2e503d" /> : null}
              <span>{c.label}</span>
            </button>
          ))}
        </div>
        <div className="send-row">
          <input
            type="text"
            value={draft}
            placeholder={placeholder}
            aria-label="Message"
            autoComplete="off"
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleSend();
              }
            }}
          />
          <button type="button" className="send-btn" aria-label="Send" disabled={busy || !draft.trim()} onClick={() => void handleSend()}>
            <Icon d={I.send} size={18} stroke="#ffffff" />
          </button>
        </div>
        <div className="foot">
          REAP sandbox · you approve on Reap&apos;s page · the agent never sees your card
          <details className="audit">
            <summary>Audit log</summary>
            {auditLog.length === 0 ? <p>No events yet.</p> : null}
            <ol>
              {auditLog.slice().reverse().slice(0, 20).map((row, i) => (
                <li key={`${row.ts}-${i}`}>
                  {new Date(row.ts).toLocaleTimeString()} [{row.source}/{row.kind}] {row.message}
                  {row.enrollmentStatus ? ` · ${row.enrollmentStatus}` : ""}
                </li>
              ))}
            </ol>
          </details>
        </div>
      </div>
    </main>
  );
}
