"""Vision LLM: extract the ingredient list from a recipe (photo or text)."""
import base64
import json
import logging
import os

from openai import OpenAI

log = logging.getLogger("vision")

PROMPT = (
    "Extract the ingredient list from the recipe in the photo. Reply with JSON only: "
    '{"dish": str, "ingredients": [{"name": str, "quantity": int}]}. '
    "List every ingredient the recipe calls for as a simple searchable grocery product name "
    "without amounts or preparation notes. 'quantity' is how many retail packs to buy "
    "(usually 1), never grams or tablespoons. Do not invent ingredients. If the recipe has no "
    "title, use a short descriptive one. If the photo has no ingredient list, use an empty list."
)


def _extract(parts):
    resp = OpenAI().chat.completions.create(
        model=os.environ.get("OPENAI_MODEL", "gpt-4o"),
        response_format={"type": "json_object"},
        messages=[{"role": "user", "content": parts}],
    )
    message = resp.choices[0].message
    try:
        result = json.loads(message.content or "")
    except ValueError:
        log.warning("model gave no usable JSON (refusal=%r, content=%r)", message.refusal, message.content)
        result = {}
    return {
        "dish": result.get("dish") or "unknown",
        "ingredients": [i for i in result.get("ingredients") or [] if isinstance(i, dict) and i.get("name")],
    }


def read_image(image_bytes, hint="", mime="image/jpeg"):
    data_url = f"data:{mime};base64,{base64.b64encode(image_bytes).decode()}"
    return _extract([
        {"type": "text", "text": PROMPT + (f" User note: {hint}" if hint else "")},
        {"type": "image_url", "image_url": {"url": data_url}},
    ])


def read_recipe_text(text, hint=""):
    return _extract([{"type": "text", "text": PROMPT.replace("in the photo", "below")
                      + (f" User note: {hint}" if hint else "") + "\n\nRecipe:\n" + text[:8000]}])


SYSTEM = (
    "You are a friendly cooking and grocery assistant inside a Telegram chat. Help with recipes, "
    "meal ideas and substitutions, and keep replies short. Tell users they can send a photo of a "
    "dish, recipe or fridge, or use /cook <recipe>, to get ingredients priced and bought. "
    "Never claim an order was placed; ordering only happens through /approve."
)


def chat_reply(turns):
    resp = OpenAI().chat.completions.create(
        model=os.environ.get("OPENAI_MODEL", "gpt-4o"),
        messages=[{"role": "system", "content": SYSTEM}, *turns],
    )
    return resp.choices[0].message.content
