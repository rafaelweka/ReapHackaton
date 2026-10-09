import { parseRecipe } from "@/lib/vision";
import type { RecipeInput } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as RecipeInput;
    if (!body?.kind) {
      return Response.json({ error: "kind is required" }, { status: 400 });
    }
    const recipe = await parseRecipe(body);
    return Response.json(recipe);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Parse failed";
    return Response.json({ error: message }, { status: 400 });
  }
}
