import { refreshQuote } from "@/lib/agent";
import type { AgentEvent, CartLine, Guardrails } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { lines?: CartLine[]; guardrails?: Guardrails };
    if (!body.lines?.length || !body.guardrails) {
      return Response.json({ error: "lines and guardrails are required" }, { status: 400 });
    }
    const events: AgentEvent[] = [];
    const result = await refreshQuote(body.lines, body.guardrails, (event) => {
      events.push(event);
    });
    return Response.json({ ...result, events });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Refresh failed";
    return Response.json({ error: message }, { status: 400 });
  }
}
