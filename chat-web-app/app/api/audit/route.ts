import { audit, clearAudit, readAudit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const events = await readAudit(100);
  return Response.json({ events });
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      kind?: string;
      message?: string;
      enrollmentId?: string;
      enrollmentStatus?: string;
      detail?: unknown;
    };
    const event = await audit({
      source: "client",
      kind: body.kind ?? "ui",
      message: body.message ?? "client event",
      enrollmentId: body.enrollmentId,
      enrollmentStatus: body.enrollmentStatus,
      detail: body.detail,
    });
    return Response.json(event);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Audit write failed";
    return Response.json({ error: message }, { status: 400 });
  }
}

export async function DELETE() {
  await clearAudit();
  await audit({ source: "server", kind: "audit_reset", message: "Audit log cleared" });
  return Response.json({ ok: true });
}
