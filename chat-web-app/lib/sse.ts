import type { AgentEvent, PlanResult } from "@/lib/types";

export type StreamMsg =
  | { type: "event"; event: AgentEvent }
  | { type: "done"; result: PlanResult }
  | { type: "error"; message: string };

export function encodeSse(msg: StreamMsg): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(msg)}\n\n`);
}
