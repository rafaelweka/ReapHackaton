import { provider } from "@/lib/provider";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store, no-cache, must-revalidate" };

export async function GET() {
  try {
    const active = await provider.findActiveEnrollment();
    return Response.json({ active }, { headers: noStore });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Lookup failed";
    return Response.json({ error: message }, { status: 400, headers: noStore });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { token?: string };
    const token = body.token?.trim();
    const returnUrl = token
      ? `${process.env.REAP_RETURN_URL?.replace(/\/$/, "") ?? ""}/?enroll=1&t=${encodeURIComponent(token)}`
      : undefined;
    const enrollment = await provider.createEnrollment(returnUrl);
    return Response.json(enrollment, { headers: noStore });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Enrollment failed";
    return Response.json({ error: message }, { status: 400, headers: noStore });
  }
}
