import { provider } from "@/lib/provider";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      quoteId?: string;
      returnUrl?: string;
      enrollmentId?: string;
    };
    if (!body.quoteId) {
      return Response.json({ error: "quoteId is required" }, { status: 400 });
    }
    const checkout = await provider.createCheckout(
      body.quoteId,
      body.returnUrl,
      body.enrollmentId,
    );
    return Response.json(checkout);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Checkout failed";
    return Response.json({ error: message }, { status: 400 });
  }
}
