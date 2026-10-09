"""Shared ordering logic: recipe -> per-merchant quotes -> checkouts."""
import time
from collections import defaultdict

from reap_client import ReapError

FINAL_STATUSES = {"COMPLETED", "FAILED", "EXPIRED"}


def pick_product(client, ingredient, country, currency):
    """Cheapest available product, respecting the ingredient's optional max_price."""
    result = client.search_products(ingredient["name"], country, currency,
                                    merchant_preference=ingredient.get("merchant"))
    max_price = ingredient.get("max_price")
    best = None
    for product in result.get("products", []):
        variant = product.get("previewVariant")
        if not product.get("available") or not variant or not variant.get("available"):
            continue
        price = variant["price"]["amount"]
        if max_price is not None and price > max_price:
            continue
        if best is None or price < best["price"]:
            best = {
                "ingredient": ingredient["name"],
                "product": product["name"],
                "merchant": product["merchant"]["name"],
                "variantId": variant["id"],
                "price": price,
                "quantity": ingredient.get("quantity", 1),
            }
    return best


def prepare_order(client, recipe, email, shipping, country="US", currency="USD", pantry=()):
    """Price the recipe without charging. Ingredients in `pantry` are skipped."""
    have = {p.lower() for p in pantry}
    by_merchant, missing = defaultdict(list), []
    for ingredient in recipe["ingredients"]:
        if ingredient["name"].lower() in have:
            continue
        pick = pick_product(client, ingredient, country, currency)
        if pick:
            by_merchant[pick["merchant"]].append(pick)
        else:
            missing.append(ingredient["name"])

    quotes, total = [], 0.0
    for merchant, picks in by_merchant.items():
        items = [{"variantId": p["variantId"], "quantity": p["quantity"]} for p in picks]
        quote = client.create_quote(items, email, shipping)
        amount = quote["amountBreakdown"]["finalAmount"]["amount"]
        total += amount
        quotes.append({"merchant": merchant, "picks": picks, "quote": quote, "amount": amount})
    return {"recipe": recipe["name"], "quotes": quotes, "missing": missing,
            "total": total, "currency": currency}


def place_order(client, order, enrollment_id, return_url, simulate=False):
    """Open a checkout per quote. Returns [(merchant, checkout | error string)]."""
    results = []
    for q in order["quotes"]:
        try:
            checkout = client.create_checkout(
                q["quote"]["id"], enrollment_id, return_url,
                simulate="COMPLETED" if simulate else None)
            results.append((q["merchant"], checkout))
        except ReapError as e:
            results.append((q["merchant"], str(e)))
    return results


def wait_for_checkout(client, checkout_id, timeout=900, interval=5):
    deadline = time.time() + timeout
    while time.time() < deadline:
        checkout = client.get_checkout(checkout_id)
        if checkout["status"] in FINAL_STATUSES:
            return checkout
        time.sleep(interval)
    raise TimeoutError(f"Checkout {checkout_id} did not reach a final status")


def summarize(order):
    lines = [f"{order['recipe']} - total {order['total']:.2f} {order['currency']}"]
    for q in order["quotes"]:
        lines.append(f"\n{q['merchant']}: {q['amount']}")
        lines += [f"  - {p['ingredient']}: {p['product']} x{p['quantity']}" for p in q["picks"]]
    if order["missing"]:
        lines.append(f"\nNot found / over price cap: {', '.join(order['missing'])}")
    return "\n".join(lines)
