"""Shared ordering logic: recipe -> per-merchant quotes -> checkouts."""
import time
from collections import defaultdict

from reap_client import ReapError

FINAL_STATUSES = {"COMPLETED", "FAILED", "EXPIRED"}


def confirm_variant(client, pick):
    """Product detail lookup. Returns (pick | None, note): confirms the default variant is purchasable at its live price."""
    try:
        product = client.get_product_details([pick["productId"]])["products"][0]
    except (ReapError, KeyError, IndexError):
        return pick, "details unavailable, keeping search price"
    variant = product.get("defaultVariant")
    if not variant:
        return pick, "no default variant, keeping search price"
    if not variant.get("available"):
        return None, "out of stock, dropped"
    live = variant["price"]["amount"]
    note = "confirmed" if live == pick["price"] else f"confirmed, price changed {pick['price']} -> {live}"
    return {**pick, "variantId": variant["id"], "price": live}, note


def search_ingredient(client, ingredient, country, currency):
    """Merchant catalog search. Returns ({merchant: best in-stock match within max_price}, result count)."""
    max_price = ingredient.get("max_price")
    words = ingredient["name"].lower().split()
    products = []
    for query in dict.fromkeys([ingredient["name"], " ".join(words[1:])]):  # retry without the leading word, e.g. "baby bok choy" -> "bok choy"
        if not query:
            continue
        result = client.search_products(query, country, currency, limit=30,
                                        merchant_preference=ingredient.get("merchant"))
        products = result.get("products", [])
        if products:
            break
    offers = {}
    for product in products:
        variant = product.get("previewVariant")
        if not product.get("available") or not variant or not variant.get("available"):
            continue
        price = variant["price"]["amount"]
        if max_price is not None and price > max_price:
            continue
        match = sum(w in product["name"].lower() for w in words)
        merchant = product["merchant"]["name"]
        current = offers.get(merchant)
        if current is None or (-match, price) < (-current["match"], current["price"]):  # best name match, then cheapest
            offers[merchant] = {
                "ingredient": ingredient["name"],
                "product": product["name"],
                "merchant": merchant,
                "productId": product["id"],
                "variantId": variant["id"],
                "price": price,
                "match": match,
                "quantity": ingredient.get("quantity", 1),
            }
    return offers, len(products)


def choose_merchants(offers, names, excluded=()):
    """Greedy set cover: repeatedly take the merchant stocking the most remaining ingredients.

    Returns ({merchant: [picks]}, [ingredients no allowed merchant stocks]).
    """
    remaining = [n for n in names if any(m not in excluded for m in offers.get(n, {}))]
    left_out = [n for n in names if n not in remaining]
    chosen = {}
    while remaining:
        scores = defaultdict(lambda: [0, 0, 0.0])  # ingredients covered, name-match total, -price total
        for n in remaining:
            for m, pick in offers[n].items():
                if m not in excluded:
                    s = scores[m]
                    s[0] += 1
                    s[1] += pick["match"]
                    s[2] -= pick["price"]
        best = max(scores, key=lambda m: scores[m])
        covered = [n for n in remaining if best in offers[n]]
        chosen[best] = [offers[n][best] for n in covered]
        remaining = [n for n in remaining if n not in covered]
    return chosen, left_out


def _money(value):
    return f"{value['amount']:.2f}" if isinstance(value, dict) and "amount" in value else "0.00"


def prepare_order(client, recipe, email, shipping, country="US", currency="USD", pantry=(), notify=None):
    """Price the recipe without charging. `notify(text)` reports each phase as it finishes."""
    notify = notify or (lambda text: None)
    have = {p.lower() for p in pantry}
    missing, offers, lines = [], {}, []

    for ingredient in recipe["ingredients"]:
        name = ingredient["name"]
        if name.lower() in have:
            continue
        try:
            found, count = search_ingredient(client, ingredient, country, currency)
        except ReapError as e:
            lines.append(f"- {name}: search failed ({_reason(e)})")
            missing.append(name)
            continue
        if found:
            offers[name] = found
            lines.append(f"- {name}: {count} results, stocked by {len(found)} merchant(s): {', '.join(found)}")
        else:
            lines.append(f"- {name}: {count} results, none in stock within price cap")
            missing.append(name)
    notify("Step 1/4 - Merchant catalog search\n" + "\n".join(lines))

    select_lines, detail_lines, quote_lines = [], [], []
    quotes, failed, total = [], [], 0.0
    excluded, todo = set(), list(offers)
    while todo:
        chosen, left_out = choose_merchants(offers, todo, excluded)
        missing += left_out
        todo = []
        for merchant, picks in chosen.items():
            select_lines.append(f"- {merchant}: {len(picks)} of {len(offers)} ingredients ({', '.join(p['ingredient'] for p in picks)})")
            confirmed = []
            for pick in picks:
                ok, note = confirm_variant(client, pick)
                detail_lines.append(f"- {pick['product']}: {note}")
                if ok:
                    confirmed.append(ok)
                else:
                    offers[pick["ingredient"]].pop(merchant, None)
                    todo.append(pick["ingredient"])
            if not confirmed:
                continue
            items = [{"variantId": p["variantId"], "quantity": p["quantity"]} for p in confirmed]
            try:
                quote = client.create_quote(items, email, shipping)
            except ReapError as e:
                failed.append(f"{merchant}: {_reason(e)}")
                quote_lines.append(f"- {merchant}: quote failed ({_reason(e)}), trying other merchants")
                excluded.add(merchant)
                todo += [p["ingredient"] for p in confirmed]
                continue
            b = quote["amountBreakdown"]
            amount = b["finalAmount"]["amount"]
            total += amount
            quotes.append({"merchant": merchant, "picks": confirmed, "quote": quote, "amount": amount})
            tax = (b.get("tax") or {}).get("amount")
            quote_lines.append(f"- {merchant}: items {_money(b.get('itemsSubtotal'))} + shipping {_money(b.get('shipping'))} "
                               f"+ tax {_money(tax)} = {amount:.2f} {currency}")
    if select_lines:
        notify("Step 2/4 - Merchant choice (fewest shipments, most ingredients)\n" + "\n".join(select_lines))
    if detail_lines:
        notify("Step 3/4 - Product details\n" + "\n".join(detail_lines))
    if quote_lines:
        notify("Step 4/4 - Live pricing (merchant quotes)\n" + "\n".join(quote_lines))
    quoted = {p["ingredient"] for q in quotes for p in q["picks"]}
    missing += [n for n in offers if n not in quoted and n not in missing]
    return {"recipe": recipe["name"], "quotes": quotes, "missing": missing,
            "failed": [f for f in failed if not any(f.startswith(q["merchant"]) for q in quotes)],
            "total": total, "currency": currency}


def _reason(error):
    err = error.body.get("error", {}) if isinstance(error.body, dict) else {}
    detail = err.get("detail") or {}
    return detail.get("message") or err.get("message") or str(error)


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


def delivery_note(quote):
    """Selected shipping option plus any delivery details the merchant supplies (e.g. an arrival date)."""
    options = quote.get("shippingOptions") or []
    chosen = next((o for o in options if o.get("selected")), options[0] if options else None)
    if not chosen:
        return "no shipping details from the merchant"
    details = ", ".join(f"{d['key']}: {d['value']}" for d in chosen.get("details") or [])
    return f"{chosen['name']} shipping" + (f" ({details})" if details else " (merchant gave no delivery date)")


def summarize(order):
    lines = [f"{order['recipe']} - total {order['total']:.2f} {order['currency']}"]
    for q in order["quotes"]:
        b = q["quote"]["amountBreakdown"]
        tax = (b.get("tax") or {}).get("amount")
        lines.append(f"\n{q['merchant']}: {q['amount']:.2f} {order['currency']} "
                     f"(items {_money(b.get('itemsSubtotal'))} + shipping {_money(b.get('shipping'))} + tax {_money(tax)})")
        lines.append(f"  Delivery: {delivery_note(q['quote'])}")
        lines += [f"  - {p['ingredient']}: {p['product']} x{p['quantity']}" for p in q["picks"]]
    if order["missing"]:
        lines.append(f"\nNot found / over price cap: {', '.join(order['missing'])}")
    if order.get("failed"):
        lines.append("\nCouldn't quote: " + "; ".join(order["failed"]))
    return "\n".join(lines)
