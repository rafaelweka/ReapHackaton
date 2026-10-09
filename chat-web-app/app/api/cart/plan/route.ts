import { planCart } from "@/lib/agent";
import { encodeSse } from "@/lib/sse";
import type { AgentEvent, Guardrails, Ingredient } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = (await req.json()) as { needed?: Ingredient[]; guardrails?: Guardrails };
  const needed = body.needed ?? [];
  const guardrails = body.guardrails;

  if (!guardrails?.budget?.amount || guardrails.budget.amount <= 0) {
    return Response.json({ error: "A positive SGD budget is required" }, { status: 400 });
  }

  const events: AgentEvent[] = [];
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: AgentEvent) => {
        events.push(event);
        controller.enqueue(encodeSse({ type: "event", event }));
      };
      try {
        const result = await planCart(needed, guardrails, emit);
        result.events = events;
        controller.enqueue(encodeSse({ type: "done", result }));
      } catch (err) {
        const message = err instanceof Error ? err.message : "Plan failed";
        controller.enqueue(encodeSse({ type: "error", message }));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
