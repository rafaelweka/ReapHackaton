import OpenAI from "openai";
import sampleRecipe from "@/lib/fixtures/sample-recipe.json";
import { isStaple } from "@/lib/merchants";
import type { Ingredient, Recipe, RecipeInput } from "@/lib/types";

const SCHEMA_HINT = `Return JSON only:
{
  "title": string,
  "servings": number,
  "ingredients": [{ "name": string, "quantity": string, "optional": boolean }]
}
Rules:
- At least 5 ingredients when possible.
- quantity is display-only (e.g. "2 cups").
- optional=true for garnish, "to serve", or nice-to-have items.
- Do not convert units. One pack will cover one line.`;

function applyDefaults(raw: {
  title?: string;
  servings?: number;
  ingredients?: Array<{ name?: string; quantity?: string; optional?: boolean }>;
  suggested?: boolean;
}): Recipe {
  const ingredients: Ingredient[] = (raw.ingredients ?? [])
    .filter((i) => i.name && i.name.trim())
    .map((i, idx) => {
      const name = i.name!.trim();
      return {
        id: `ing-${idx}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 24)}`,
        name,
        quantity: (i.quantity ?? "").trim() || "1",
        optional: Boolean(i.optional),
        have: isStaple(name),
        suggested: raw.suggested,
      };
    });

  return {
    title: raw.title?.trim() || "Untitled recipe",
    servings: typeof raw.servings === "number" && raw.servings > 0 ? raw.servings : 2,
    ingredients,
  };
}

export function loadSample(): Recipe {
  return applyDefaults(sampleRecipe);
}

function looksLikeDishName(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && t.length < 80 && !t.includes("\n") && (t.match(/,/g) ?? []).length < 3;
}

async function completeJson(messages: OpenAI.Chat.ChatCompletionMessageParam[]): Promise<Recipe> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const res = await client.chat.completions.create({
    model: messages.some((m) => Array.isArray(m.content)) ? "gpt-4o" : "gpt-4o-mini",
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages,
  });
  const content = res.choices[0]?.message?.content;
  if (!content) throw new Error("Model returned an empty recipe.");
  return applyDefaults(JSON.parse(content) as Parameters<typeof applyDefaults>[0]);
}

export async function parseRecipe(input: RecipeInput): Promise<Recipe> {
  if (input.kind === "sample" || !process.env.OPENAI_API_KEY) {
    return loadSample();
  }

  if (input.kind === "photo") {
    const recipe = await completeJson([
      {
        role: "system",
        content: `You extract a grocery ingredient list from a recipe photo. ${SCHEMA_HINT}`,
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Read this recipe photo and extract the title, servings, and ingredients." },
          { type: "image_url", image_url: { url: input.imageBase64 } },
        ],
      },
    ]);
    if (recipe.ingredients.length < 5) {
      throw new Error("Could not read at least 5 ingredients from the photo. Try a clearer shot or paste the text.");
    }
    return recipe;
  }

  const dish = looksLikeDishName(input.text);
  const recipe = await completeJson([
    {
      role: "system",
      content: dish
        ? `The user typed a dish name. Suggest a typical home-cook ingredient list for Singapore grocery shopping. Mark all ingredients as typical suggestions. ${SCHEMA_HINT}`
        : `Extract a grocery ingredient list from recipe text or a typed list. ${SCHEMA_HINT}`,
    },
    { role: "user", content: input.text },
  ]);

  if (dish) {
    recipe.ingredients = recipe.ingredients.map((i) => ({ ...i, suggested: true }));
  }
  if (recipe.ingredients.length < 5) {
    throw new Error("Need at least 5 ingredients. Add more lines or try a dish name.");
  }
  return recipe;
}
