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

export default function HomePage() {
  const [step, setStep] = useState<Step>("input");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [text, setText] = useState("");
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
  const [now, setNow] = useState(Date.now());

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
    sessionStorage.removeItem("checkoutId");
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

  const persist = useCallback((next: { recipe?: Recipe | null; plan?: PlanResult | null }) => {
    const payload = {
      recipe: next.recipe ?? recipe,
      plan: next.plan ?? plan,
      budget,
      latestDate,
      window: timeWindow,
      preferred,
      blocked,
    };
    sessionStorage.setItem(STORE_KEY, JSON.stringify(payload));
  }, [recipe, plan, budget, latestDate, timeWindow, preferred, blocked]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

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
      sessionStorage.removeItem("checkoutId");
      window.history.replaceState({}, "", "/");
    }
    const checkoutId = params.get("checkoutId") ?? sessionStorage.getItem("checkoutId");
    const raw = sessionStorage.getItem(STORE_KEY);
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
        };
        if (saved.recipe) setRecipe(saved.recipe);
        if (saved.plan) setPlan(saved.plan);
        if (saved.budget) setBudget(saved.budget);
        if (saved.latestDate) setLatestDate(saved.latestDate);
        if (saved.window) setTimeWindow(saved.window);
        if (saved.preferred) setPreferred(saved.preferred);
        if (saved.blocked) setBlocked(saved.blocked);
        if (saved.plan) setStep("plan");
        else if (saved.recipe && !checkoutId) setStep("pantry");
      } catch {
        /* ignore */
      }
    }

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

    if (params.get("paid") === "1") {
      const paidId = sessionStorage.getItem("checkoutId");
      if (paidId) {
        setStep("confirm");
        setBusy(true);
        const load = () =>
          fetch(`/api/checkout/${paidId}`)
            .then(async (res) => {
              const data = await res.json();
              if (!res.ok) throw new Error(data.error ?? "Checkout lookup failed");
              setCheckout(data as Checkout);
              return data as Checkout;
            });
        load()
          .catch((err: unknown) => setError(err instanceof Error ? err.message : "Checkout lookup failed"))
          .finally(() => setBusy(false));
        const poll = setInterval(() => {
          void load().catch(() => undefined);
        }, 2000);
        const stop = setTimeout(() => clearInterval(poll), 60000);
        return () => {
          clearInterval(poll);
          clearTimeout(stop);
        };
      }
    }

    if (!checkoutId) return;
    setStep("confirm");
    setBusy(true);
    const load = () =>
      fetch(`/api/checkout/${checkoutId}`)
        .then(async (res) => {
          const data = await res.json();
          if (!res.ok) throw new Error(data.error ?? "Checkout lookup failed");
          setCheckout(data as Checkout);
          return data as Checkout;
        });
    load()
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Checkout lookup failed"))
      .finally(() => setBusy(false));
    const poll = setInterval(() => {
      void load().catch(() => undefined);
    }, 2000);
    const stop = setTimeout(() => clearInterval(poll), 60000);
    return () => {
      clearInterval(poll);
      clearTimeout(stop);
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

  async function startCheckout(enrollmentId: string, quoteId: string) {
    const res = await fetch("/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quoteId, enrollmentId }),
    });
    const data = (await res.json()) as Checkout & { error?: string };
    if (!res.ok) throw new Error(data.error ?? "Checkout failed");
    sessionStorage.removeItem(PENDING_KEY);
    sessionStorage.setItem("checkoutId", data.id);
    if (data.status === "COMPLETED") {
      setCheckout(data);
      setStep("confirm");
      return;
    }
    if (data.approvalUrl) {
      window.location.href = data.approvalUrl;
      return;
    }
    throw new Error("Checkout did not complete or return an approval URL");
  }

  async function approve() {
    if (!plan?.quote) return;
    setBusy(true);
    setError("");
    persist({ recipe, plan });
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
        await startCheckout(owner.active.id, plan.quote.id);
        return;
      }

      const existing = sessionStorage.getItem(ENROLL_KEY);
      if (existing) {
        const current = await fetchNoStore<Enrollment>(`/api/enrollment/${existing}`);
        setEnrollment(current);
        if (current.status === "ACTIVE") {
          await startCheckout(current.id, plan.quote.id);
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
        await startCheckout(data.id, plan.quote.id);
        return;
      }
      if (!data.approvalUrl) throw new Error("Enrollment did not return a card-entry URL");
      setCardPageUrl(data.approvalUrl);
      window.location.href = data.approvalUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Checkout failed");
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
    void startCheckout(enrollment.id, plan.quote.id).catch((err: unknown) => {
      checkoutStarted.current = false;
      setError(err instanceof Error ? err.message : "Checkout failed");
      setBusy(false);
    });
  }, [resumeAfterCard, enrollment, plan]);

  const expired = plan?.quote ? new Date(plan.quote.expiresAt).getTime() <= now : false;
  const suggested = recipe?.ingredients.some((i) => i.suggested);
  const cardReady = enrollment?.status === "ACTIVE";
  const quoteTotal = plan?.quote ? formatSgd(plan.quote.finalAmount.amount) : "";

  let nextClick = "Click: Use sample recipe";
  if (busy) nextClick = "Wait — working…";
  else if (step === "pantry") nextClick = "Click: Next — set budget";
  else if (step === "guardrails") nextClick = "Click: Shop for missing items";
  else if (step === "plan" && expired) nextClick = "Click: Refresh grocery price (quote expired)";
  else if (step === "plan" && plan && !plan.canApprove) nextClick = "Budget failed — go back and raise the cap, then shop again";
  else if (step === "plan" && plan?.canApprove && !cardReady)
    nextClick = cardPageUrl
      ? "Click: Continue Reap card page (finish OTP / phone passkey). S$0 on that page is normal."
      : "Click: Open Reap card page (it may show S$0 — that only saves the card)";
  else if (step === "plan" && plan?.canApprove && cardReady)
    nextClick = `Click: Pay grocery total ${quoteTotal}`;
  else if (step === "confirm") nextClick = "Done — or click Start a new order";

  return (
    <main>
      <h1>Snap-a-Recipe Cart</h1>
      <p>
        <strong>Next click: {nextClick}</strong>
      </p>
      <p className="muted">
        Card page (S$0) stores the card. Grocery total is charged only after the card is ACTIVE.
        Test card: 4622 9431 2313 7797, CVC 640, expiry 12/27. OTP 456789 if asked. Prefer
        iPhone Safari if the Mac passkey gets stuck.
      </p>
      {error ? <p role="alert">{error}</p> : null}
      {busy ? <p>Working…</p> : null}
      <p>
        <button
          type="button"
          onClick={() => {
            resetLocalCard();
            sessionStorage.removeItem(STORE_KEY);
            window.location.href = "/";
          }}
        >
          Start a new order
        </button>
        <button
          type="button"
          onClick={() => {
            resetLocalCard();
            setError("Card session cleared. Next click is Open Reap card page after you have a quote.");
          }}
        >
          Forget saved card (start enrollment over)
        </button>
      </p>

      {step === "input" ? (
        <fieldset>
          <legend>1. Snap or type</legend>
          <p>
            <strong>Click “Use sample recipe (skip typing)” unless you have your own text.</strong>
          </p>
          <label>
            Recipe photo
            <input
              type="file"
              accept="image/*"
              capture="environment"
              onChange={(e) => void onPhoto(e.target.files?.[0] ?? null)}
              disabled={busy}
            />
          </label>
          <label>
            Recipe text, dish name, or ingredient list
            <textarea
              rows={6}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder='e.g. "chicken rice for 2" or paste a recipe'
              style={{ width: "100%" }}
            />
          </label>
          <button type="button" disabled={busy || !text.trim()} onClick={() => void parse({ kind: "text", text })}>
            Parse this recipe text
          </button>
          <button type="button" disabled={busy} onClick={() => void parse({ kind: "sample" })}>
            Use sample recipe (skip typing)
          </button>
        </fieldset>
      ) : null}

      {recipe && step !== "input" && step !== "confirm" ? (
        <p>
          <strong>{recipe.title}</strong> · {recipe.servings} servings · {needCount(recipe)} to buy
          {suggested ? " · suggested ingredients from dish name" : null}
        </p>
      ) : null}

      {step === "pantry" && recipe ? (
        <fieldset>
          <legend>2. Pantry check</legend>
          <p className="muted">Ticked = already have. Untick anything you still need.</p>
          {recipe.ingredients.map((ing) => (
            <label key={ing.id}>
              <input
                type="checkbox"
                checked={ing.have}
                onChange={() =>
                  setRecipe({
                    ...recipe,
                    ingredients: recipe.ingredients.map((i) =>
                      i.id === ing.id ? { ...i, have: !i.have } : i,
                    ),
                  })
                }
              />{" "}
              {ing.name} ({ing.quantity}){ing.optional ? " — optional" : ""}
              {ing.have ? " · have" : " · need"}
            </label>
          ))}
          <p>Need: {needCount(recipe)}</p>
          <button type="button" onClick={() => setStep("input")}>
            Back to recipe input
          </button>
          <button type="button" onClick={() => setStep("guardrails")}>
            Next — set budget
          </button>
        </fieldset>
      ) : null}

      {step === "guardrails" && recipe ? (
        <fieldset>
          <legend>3. Budget and guardrails</legend>
          <p>Items on the need list: {needCount(recipe)}</p>
          <label>
            Budget cap (SGD, required)
            <input
              type="number"
              min={0.01}
              step={0.01}
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
            />
          </label>
          <label>
            Latest delivery date (optional)
            <input type="date" value={latestDate} onChange={(e) => setLatestDate(e.target.value)} />
          </label>
          <label>
            Time window (not guaranteed on Reap)
            <select value={timeWindow} onChange={(e) => setTimeWindow(e.target.value as DeliveryWindow)}>
              <option value="any">any</option>
              <option value="morning">morning</option>
              <option value="afternoon">afternoon</option>
              <option value="evening">evening</option>
            </select>
          </label>
          <label>
            Preferred brands (comma-separated)
            <input value={preferred} onChange={(e) => setPreferred(e.target.value)} />
          </label>
          <label>
            Blocked brands (comma-separated)
            <input value={blocked} onChange={(e) => setBlocked(e.target.value)} />
          </label>
          <button type="button" onClick={() => setStep("pantry")}>
            Back to pantry
          </button>
          <button type="button" disabled={busy} onClick={() => void runPlan()}>
            Shop for missing items
          </button>
        </fieldset>
      ) : null}

      {step === "plan" ? (
        <section>
          <h2>4–5. Agent shops and price lock</h2>
          <h3>Activity log</h3>
          {events.length === 0 ? <p className="muted">Waiting for the agent…</p> : null}
          <ol>
            {events.map((e, i) => (
              <li key={`${e.ts}-${i}`}>
                {new Date(e.ts).toLocaleTimeString()} [{e.kind}] {e.message}
              </li>
            ))}
          </ol>

          {plan ? (
            <>
              <h3>Merchant lock</h3>
              <p>
                {plan.merchant.label} ({plan.merchant.hits} hits).{" "}
                {plan.scores.map((s) => `${s.label} ${s.hits}`).join(" · ")}
              </p>
              <h3>Cart</h3>
              <table>
                <thead>
                  <tr>
                    <th>Ingredient</th>
                    <th>Product</th>
                    <th>Price</th>
                    <th>Status</th>
                    <th>Why</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.lines.map((line) => (
                    <tr key={line.ingredientId}>
                      <td>{line.ingredientName}</td>
                      <td>{line.candidate.name}</td>
                      <td>{formatSgd(line.candidate.price.amount)}</td>
                      <td>{line.status}</td>
                      <td>{line.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {plan.quote ? (
                <>
                  <h3>Quote</h3>
                  <p>Subtotal {formatSgd(plan.quote.itemsSubtotal.amount)}</p>
                  <p>Shipping {formatSgd(plan.quote.shipping.amount)}</p>
                  <p>Tax {formatSgd(plan.quote.tax.amount)}</p>
                  <p>
                    <strong>Final {formatSgd(plan.quote.finalAmount.amount)}</strong> vs budget{" "}
                    {formatSgd(Number(budget) || 0)}
                  </p>
                  <p>
                    Price lock: <Countdown expiresAt={plan.quote.expiresAt} />{" "}
                    <button type="button" disabled={busy} onClick={() => void refresh()}>
                      Refresh grocery price
                    </button>
                  </p>
                  <p>
                    Shipping options:{" "}
                    {plan.quote.shippingOptions
                      .map(
                        (o) =>
                          `${o.selected ? "*" : ""}${o.name} ${formatSgd(o.price.amount)} est ${o.estimatedDelivery?.latest ?? "n/a"} (${o.estimatedDelivery?.source})`,
                      )
                      .join(" · ")}
                  </p>
                </>
              ) : null}
              <h3>Guardrails</h3>
              <ul>
                {plan.guardrails.map((g) => (
                  <li key={g.id}>
                    {g.ok ? "pass" : "fail"} — {g.label}: {g.detail}
                  </li>
                ))}
              </ul>
              {plan.message ? <p>{plan.message}</p> : null}
              {!plan.canApprove && latestDate ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setLatestDate("");
                    void runPlan({
                      ...guardrails,
                      delivery: { window: timeWindow === "any" ? undefined : timeWindow },
                    });
                  }}
                >
                  Relax delivery date and re-shop
                </button>
              ) : null}
              <button type="button" onClick={() => setStep("guardrails")}>
                Back to budget
              </button>
              {enrollment ? (
                <p>
                  <strong>
                    Card status: {enrollment.status}
                    {enrollment.last4 ? ` · Visa •••• ${enrollment.last4}` : ""}
                  </strong>
                  {cardReady
                    ? " — this is the stored Reap card. Pay the grocery total next."
                    : enrollment.expiresAt
                      ? ` — hosted step still open until ${enrollment.expiresAt}. Redirect back here is not proof of ACTIVE.`
                      : " — card is not ready yet."}
                </p>
              ) : (
                <p>
                  <strong>Card status: checking Reap…</strong> If a Visa is already ACTIVE on this
                  owner, Pay will show without opening Prava again.
                </p>
              )}
              {!plan.canApprove || expired || !plan.quote ? (
                <p className="muted">
                  The pay buttons stay hidden until the quote is valid and under budget.
                </p>
              ) : cardReady ? (
                <p>
                  <button type="button" disabled={busy} onClick={() => void approve()}>
                    {`Pay grocery total ${quoteTotal} now`}
                  </button>
                </p>
              ) : cardPageUrl ? (
                <p>
                  <button type="button" onClick={() => { window.location.href = cardPageUrl; }}>
                    Continue Reap card page (finish OTP or phone passkey — S$0 is OK)
                  </button>
                </p>
              ) : (
                <p>
                  <button type="button" disabled={busy} onClick={() => void approve()}>
                    Open Reap card page (shows S$0 — that only saves the card)
                  </button>
                </p>
              )}
            </>
          ) : null}
        </section>
      ) : null}

      {step === "confirm" ? (
        <section>
          <h2>6. Ready to cook</h2>
          {recipe ? <p>{recipe.title}</p> : null}
          {checkout ? (
            <>
              <p>Status: {checkout.status}</p>
              <p>Order ID: {checkout.orderId ?? "(pending)"}</p>
              <p>
                Amount charged:{" "}
                {checkout.finalAmount ? formatSgd(checkout.finalAmount.amount) : "(pending)"}
              </p>
            </>
          ) : (
            <p>Waiting for Reap checkout…</p>
          )}
          <button
            type="button"
            onClick={() => {
              resetLocalCard();
              sessionStorage.removeItem(STORE_KEY);
              window.location.href = "/";
            }}
          >
            Start a new order
          </button>
        </section>
      ) : null}

      <section>
        <h3>Audit log</h3>
        <p className="muted">Server Reap calls and client enrollment steps. No card numbers or API keys.</p>
        {auditLog.length === 0 ? <p className="muted">No events yet.</p> : null}
        <ol>
          {auditLog
            .slice()
            .reverse()
            .slice(0, 30)
            .map((row, i) => (
              <li key={`${row.ts}-${i}`}>
                {new Date(row.ts).toLocaleTimeString()} [{row.source}/{row.kind}] {row.message}
                {row.enrollmentStatus ? ` · enroll ${row.enrollmentStatus}` : ""}
                {row.last4 ? ` · last4 ${row.last4}` : ""}
                {row.errorCode ? ` · ${row.errorCode}` : ""}
              </li>
            ))}
        </ol>
      </section>
    </main>
  );
}
