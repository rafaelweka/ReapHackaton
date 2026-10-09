import OpenAI from "openai";
import sampleRecipe from "@/lib/fixtures/sample-recipe.json";
import { isStaple } from "@/lib/merchants";
import type { Ingredient, Recipe, RecipeInput, RecipeSource } from "@/lib/types";

const INGREDIENT_RULES = `- ingredients[].name is a shoppable grocery item (e.g. "minced beef", "spaghetti", "canned chopped tomatoes").
- quantity is display-only (e.g. "400 g", "2 cups"). Do not convert units. One pack covers one line.
- optional=true for garnish, "to serve", or nice-to-have items.
- Skip water. Prefer names a Singapore supermarket shopper would search.`;

const TEXT_SCHEMA = `Return JSON only:
{
  "source": "typed_dish" | "typed_recipe",
  "title": string,
  "servings": number,
  "notes": string,
  "method": string[],
  "ingredients": [{ "name": string, "quantity": string, "optional": boolean }]
}
${INGREDIENT_RULES}
- source=typed_dish if the user named a dish. Invent a typical home-cook recipe (at least 6 ingredients, 4–8 short method steps).
- source=typed_recipe if they pasted a recipe or ingredient list. Extract only what they wrote. method may be empty.
- notes is one short sentence for the cook.`;

const PHOTO_SCHEMA = `Return JSON only:
{
  "source": "plated_dish" | "recipe_document",
  "title": string,
  "servings": number,
  "notes": string,
  "method": string[],
  "ingredients": [{ "name": string, "quantity": string, "optional": boolean }]
}
${INGREDIENT_RULES}
- source=plated_dish if the photo is cooked food, a restaurant plate, leftovers, or packaging of a ready dish. Identify the dish (e.g. spaghetti bolognese) and give a typical home-cook recipe someone could shop in Singapore — not a restaurant recreation. At least 6 ingredients and 4–8 short method steps. notes should start with "Looks like …".
- source=recipe_document if the photo is a cookbook page, handwritten recipe, screenshot, or label with an ingredient list. Extract the written title, servings, ingredients, and any visible steps. Do not invent extra ingredients. method may be empty if no steps are shown.
- title is the dish or recipe name, not a description of the photo.`;

const SOURCES = new Set<RecipeSource>([
  "plated_dish",
  "recipe_document",
  "typed_dish",
  "typed_recipe",
  "sample",
]);

function applyDefaults(
  raw: {
    title?: string;
    servings?: number;
    notes?: string;
    method?: string[];
    source?: string;
    ingredients?: Array<{ name?: string; quantity?: string; optional?: boolean }>;
    suggested?: boolean;
  },
  fallbackSource?: RecipeSource,
): Recipe {
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

  const source = SOURCES.has(raw.source as RecipeSource)
    ? (raw.source as RecipeSource)
    : fallbackSource;
  const guessed = source === "plated_dish" || source === "typed_dish" || raw.suggested;

  return {
    title: raw.title?.trim() || "Untitled recipe",
    servings: typeof raw.servings === "number" && raw.servings > 0 ? raw.servings : 2,
    notes: raw.notes?.trim() || undefined,
    method: (raw.method ?? []).map((s) => String(s).trim()).filter(Boolean),
    source,
    ingredients: guessed
      ? ingredients.map((i) => ({ ...i, suggested: true }))
      : ingredients,
  };
}

export function loadSample(): Recipe {
  return applyDefaults(sampleRecipe, "sample");
}

function looksLikeDishName(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && t.length < 80 && !t.includes("\n") && (t.match(/,/g) ?? []).length < 3;
}

async function completeJson(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  fallbackSource?: RecipeSource,
): Promise<Recipe> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const res = await client.chat.completions.create({
    model: messages.some((m) => Array.isArray(m.content)) ? "gpt-4o" : "gpt-4o-mini",
    temperature: 0.3,
    response_format: { type: "json_object" },
    messages,
  });
  const content = res.choices[0]?.message?.content;
  if (!content) throw new Error("Model returned an empty recipe.");
  return applyDefaults(JSON.parse(content) as Parameters<typeof applyDefaults>[0], fallbackSource);
}

export async function parseRecipe(input: RecipeInput): Promise<Recipe> {
  if (input.kind === "sample" || !process.env.OPENAI_API_KEY) {
    return loadSample();
  }

  if (input.kind === "photo") {
    const recipe = await completeJson(
      [
        {
          role: "system",
          content: `You turn a food photo into a shoppable home recipe. ${PHOTO_SCHEMA}`,
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Look at this photo. If it is a plated dish, name it and write a typical home recipe. If it is a written recipe, extract it.",
            },
            { type: "image_url", image_url: { url: input.imageBase64, detail: "high" } },
          ],
        },
      ],
      "plated_dish",
    );
    if (recipe.ingredients.length < 5) {
      throw new Error(
        recipe.source === "recipe_document"
          ? "Could not read at least 5 ingredients from the photo. Try a clearer shot of the recipe, or snap the plated dish instead."
          : "I could not build a shoppable recipe from that dish photo. Try another angle or type the dish name.",
      );
    }
    return recipe;
  }

  const dish = looksLikeDishName(input.text);
  const recipe = await completeJson(
    [
      {
        role: "system",
        content: dish
          ? `The user typed a dish name. Suggest a typical home-cook recipe for Singapore grocery shopping. ${TEXT_SCHEMA}`
          : `Extract a grocery ingredient list from recipe text or a typed list. ${TEXT_SCHEMA}`,
      },
      { role: "user", content: input.text },
    ],
    dish ? "typed_dish" : "typed_recipe",
  );

  if (recipe.ingredients.length < 5) {
    throw new Error("Need at least 5 ingredients. Add more lines or try a dish name.");
  }
  return recipe;
}
