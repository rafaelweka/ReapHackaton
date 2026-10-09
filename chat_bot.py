"""Telegram bot: buy ingredients inside a chat, plus weekly autopilot groceries for someone you care for.

Every charge still needs a one-tap approval on Reap's hosted page; the bot sends that link in chat.
Uses Telegram's HTTP API directly (no extra dependency).
"""
import json
import logging
import os
import threading
import time
from datetime import datetime

import requests
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"), override=True)

from planner import place_order, prepare_order, summarize, wait_for_checkout
from reap_client import ReapClient, ReapError
from vision import chat_reply, read_image, read_recipe_text

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("chat_bot")

TG = f"https://api.telegram.org/bot{os.environ.get('TELEGRAM_BOT_TOKEN', '')}"
TG_FILES = f"https://api.telegram.org/file/bot{os.environ.get('TELEGRAM_BOT_TOKEN', '')}"
ALLOWED = {int(c) for c in os.environ.get("TELEGRAM_ALLOWED_CHATS", "").split(",") if c.strip()}
RECIPES_DIR = os.path.join(os.path.dirname(__file__), "recipes")
STANDING_ORDERS = os.environ.get("STANDING_ORDERS_FILE", "standing_orders.json")

client = ReapClient(os.environ["REAP_API_KEY"],
                    base_url=os.environ.get("REAP_BASE_URL", "https://sandbox.api.reap.global"))
DEFAULT_ENROLLMENT = os.environ.get("REAP_ENROLLMENT_ID", "")
ENROLLMENTS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "enrollments.json")
EMAIL = os.environ["REAP_EMAIL"]
CUSTOM_RETURN_URL = os.environ.get("REAP_RETURN_URL", "")
recent_checkouts = {}  # chat_id -> [(merchant, checkout_id)] shown when the user returns from approval


def bot_username():
    return requests.get(f"{TG}/getMe", timeout=30).json()["result"]["username"]


def return_url(kind):
    """Where Reap sends the browser after a hosted page: a t.me deep link back into this bot."""
    if CUSTOM_RETURN_URL and "example.com" not in CUSTOM_RETURN_URL:
        return CUSTOM_RETURN_URL
    return f"https://t.me/{BOT_USERNAME}?start={kind}"
SHIPPING = json.loads(os.environ.get("REAP_SHIPPING_ADDRESS", "null"))
SIMULATE = os.environ.get("REAP_SIMULATE") == "1"

pending = {}  # chat_id -> prepared order awaiting /approve
history = {}  # chat_id -> recent conversation turns
selections = {}  # chat_id -> {dish, items, checked indices} for the ingredient checklist
budgets = {}  # chat_id -> max order total set with /budget
awaiting_card = {}  # chat_id -> ingredient selection to price once a card is saved


def _load_state():
    if not os.path.exists(ENROLLMENTS_FILE):
        return {"active": {}, "pending": {}}
    with open(ENROLLMENTS_FILE) as f:
        data = json.load(f)
    return data if "active" in data else {"active": data, "pending": {}}


state = _load_state()  # active: chat_id -> usable card enrollment; pending: chat_id -> enrollment awaiting card entry
enrollments = state["active"]


def save_state():
    with open(ENROLLMENTS_FILE, "w") as f:
        json.dump(state, f)


activate_lock = threading.Lock()


def card_activated(chat_id, enrollment):
    """Announce the saved card and carry on with the purchase that was waiting for it."""
    try:
        sel = awaiting_card.pop(chat_id, None)
        say(chat_id, f"Card saved: {card_label(enrollment)}." + ("" if sel else " Send a recipe to start."))
        if sel:
            price_selection(chat_id, sel)
    except Exception:
        log.exception("[%s] continuing after card setup failed", chat_id)
        say(chat_id, "Card saved, but I couldn't continue the order. Send the recipe again.")


def recover_active(chat_id):
    """Find the newest ACTIVE card on Reap for this chat, whichever enrollment it was entered on."""
    active = [i for i in client.list_enrollments(str(chat_id)).get("items", []) if i.get("status") == "ACTIVE"]
    if not active:
        return None
    item = max(active, key=lambda i: i.get("createdAt", ""))
    with activate_lock:
        if enrollments.get(str(chat_id)) == item["id"]:
            return item
        enrollments[str(chat_id)] = item["id"]
        state["pending"].pop(str(chat_id), None)
        save_state()
    log.info("[%s] card active on enrollment %s", chat_id, item["id"])
    threading.Thread(target=card_activated, args=(chat_id, item), daemon=True).start()
    return item


def enrollment_for(chat_id):
    if not enrollments.get(str(chat_id)):
        try:
            recover_active(chat_id)
        except ReapError as e:
            log.warning("[%s] card lookup failed: %s", chat_id, e)
    return enrollments.get(str(chat_id)) or DEFAULT_ENROLLMENT


def card_label(enrollment):
    card = enrollment.get("paymentMethod") or {}
    return f"{card.get('network', 'card')} ending {card.get('last4', '????')}"


def show_cards(chat_id):
    try:
        if enrollments.get(str(chat_id)):
            enrollment = client.get_enrollment(enrollments[str(chat_id)])
            return say(chat_id, f"Card on file: {card_label(enrollment)} ({enrollment['status']}).")
        enrollment = recover_active(chat_id)
        if enrollment:
            return  # card_activated has already messaged the user
        items = client.list_enrollments(str(chat_id)).get("items", [])
        enrollment = max(items, key=lambda i: i.get("createdAt", ""), default=None)
    except ReapError as e:
        log.warning("[%s] /cards failed: %s", chat_id, e)
        return say(chat_id, f"Couldn't check your card with Reap: {e.status}. Try again.")
    if not enrollment:
        return say(chat_id, "No card on file. Send /addcard.")
    log.info("[%s] latest enrollment %s status %s", chat_id, enrollment["id"], enrollment["status"])
    action = enrollment.get("nextAction") or {}
    if enrollment["status"] == "REQUIRES_ACTION":
        return say(chat_id, "Reap hasn't received a completed card yet (status REQUIRES_ACTION). "
                            "Finish all steps on the card page, including the one-time password. "
                            "Card pages expire after about 15 minutes; if yours did, send /addcard."
                            + (f"\n{action['url']}" if action.get("url") else ""))
    say(chat_id, f"Card setup is {enrollment['status']}. Send /addcard to try again.")


def add_card(chat_id):
    try:
        if recover_active(chat_id):
            return  # a card is already saved; card_activated tells the user and continues
        pending_id = state["pending"].get(str(chat_id))
        current = client.get_enrollment(pending_id) if pending_id else None
        if current and current["status"] == "REQUIRES_ACTION" and (current.get("nextAction") or {}).get("url"):
            say(chat_id, "Your card page is still open. Finish it here:\n" + current["nextAction"]["url"])
            return
        enrollment = client.create_enrollment(str(chat_id), EMAIL, return_url("card"))
    except ReapError as e:
        log.warning("[%s] enrollment failed: %s", chat_id, e)
        code = (e.body.get("error", {}).get("code") if isinstance(e.body, dict) else None) or ""
        reasons = {
            "AGENTIC_PAYMENTS_NOT_ENABLED": "Agentic Payments isn't enabled on this Reap project. Ask Reap to enable it.",
            "AGENTIC_SERVICE_UNAVAILABLE": "Reap card storage is temporarily unavailable. Try again shortly.",
            "AGENTIC_REQUEST_REJECTED": "Reap rejected the request. Check REAP_EMAIL is a valid email address.",
        }
        return say(chat_id, reasons.get(code, f"Couldn't start card setup: {code or e.status}"))
    action = enrollment.get("nextAction")
    log.info("[%s] enrollment %s created (%s)", chat_id, enrollment["id"], enrollment["status"])
    if not action:
        return say(chat_id, f"Card setup returned no page to open (status {enrollment['status']}). Try /addcard again.")
    say(chat_id, "Add your card on Reap's secure page. The card number never passes through this bot:\n"
                 + action["url"] + "\n\nI'll message you here once it's saved (or send /cards to check).")
    state["pending"][str(chat_id)] = enrollment["id"]
    save_state()
    threading.Thread(target=track_enrollment, args=(chat_id, enrollment["id"]), daemon=True).start()


def track_enrollment(chat_id, enrollment_id, timeout=900, interval=5):
    deadline = time.time() + timeout
    last = None
    try:
        while time.time() < deadline:
            if enrollments.get(str(chat_id)) or recover_active(chat_id):
                return  # card_activated messages the user
            status = client.get_enrollment(enrollment_id)["status"]
            if status != last:
                last = status
                log.info("[%s] enrollment %s status: %s", chat_id, enrollment_id, last)
            if status in ("FAILED", "EXPIRED", "REVOKED"):
                state["pending"].pop(str(chat_id), None)
                save_state()
                return say(chat_id, f"Card setup {status.lower()}. Send /addcard to try again.")
            time.sleep(interval)
        say(chat_id, "Still waiting for your card. Send /cards to check, or /addcard to restart.")
    except Exception:
        log.exception("[%s] enrollment tracking failed", chat_id)
        say(chat_id, "I couldn't confirm your card automatically. Send /cards to check.")


def say(chat_id, text):
    resp = requests.post(f"{TG}/sendMessage",
                         json={"chat_id": chat_id, "text": text, "disable_web_page_preview": True}, timeout=30)
    log.info("[%s] sent reply (%s): %s", chat_id, resp.status_code, text[:80].replace("\n", " "))


def load_recipe(name):
    path = os.path.join(RECIPES_DIR, f"{os.path.basename(name)}.json")
    if not os.path.exists(path):
        return None
    with open(path) as f:
        return json.load(f)


def track(chat_id, merchant, checkout_id):
    final = wait_for_checkout(client, checkout_id)
    log.info("[%s] %s checkout %s -> %s", chat_id, merchant, checkout_id, final["status"])
    if final["status"] == "COMPLETED":
        say(chat_id, f"{merchant}: order {final['orderId']} placed, charged {final['finalAmount']['amount']}.")
    else:
        say(chat_id, f"{merchant}: {final['status']}. Nothing was bought; send the request again to retry.")


def show_order_status(chat_id):
    checkouts = recent_checkouts.get(chat_id)
    if not checkouts:
        return say(chat_id, "Welcome back. No recent order to check. Send a recipe to start.")
    say(chat_id, "Welcome back. Checking your order...")
    for merchant, checkout_id in checkouts:
        checkout = client.get_checkout(checkout_id)
        if checkout["status"] == "COMPLETED":
            say(chat_id, f"{merchant}: order {checkout['orderId']} placed, charged {checkout['finalAmount']['amount']}.")
        else:
            say(chat_id, f"{merchant}: {checkout['status']}")


def send_for_approval(chat_id, order):
    enrollment_id = enrollment_for(chat_id)
    if not enrollment_id:
        return say(chat_id, "No card on file yet. Send /addcard first.")
    log.info("[%s] placing %d checkout(s), total %.2f", chat_id, len(order["quotes"]), order["total"])
    recent_checkouts[chat_id] = []
    for merchant, checkout in place_order(client, order, enrollment_id, return_url("order"), SIMULATE):
        if isinstance(checkout, str):
            say(chat_id, f"{merchant}: checkout failed: {checkout}")
            continue
        action = checkout.get("nextAction")
        if action:
            say(chat_id, f"{merchant}: tap to approve payment\n{action['url']}")
        threading.Thread(target=track, args=(chat_id, merchant, checkout["id"]), daemon=True).start()
        recent_checkouts.setdefault(chat_id, []).append((merchant, checkout["id"]))


def handle_photo(chat_id, file_id, caption):
    say(chat_id, "Looking at your photo...")
    info = requests.get(f"{TG}/getFile", params={"file_id": file_id}, timeout=30).json()["result"]
    image = requests.get(f"{TG_FILES}/{info['file_path']}", timeout=60).content
    seen = read_image(image, caption)
    order_from_seen(chat_id, seen)


def handle_recipe_text(chat_id, text, hint=""):
    say(chat_id, "Reading your recipe...")
    order_from_seen(chat_id, read_recipe_text(text, hint))


def order_from_seen(chat_id, seen):
    log.info("[%s] vision: dish=%s, %d ingredients", chat_id, seen["dish"], len(seen["ingredients"]))
    if not seen["ingredients"]:
        return say(chat_id, "I couldn't find a recipe in that. Send a clear photo or text of the ingredient list.")
    if seen["dish"] == "unknown":
        seen["dish"] = "Your recipe"
    selections[chat_id] = {"dish": seen["dish"], "items": seen["ingredients"],
                           "checked": set(range(len(seen["ingredients"])))}
    resp = requests.post(f"{TG}/sendMessage", json={
        "chat_id": chat_id, "text": checklist_text(selections[chat_id]),
        "reply_markup": checklist_markup(selections[chat_id])}, timeout=30)
    log.info("[%s] sent checklist (%s)", chat_id, resp.status_code)


def checklist_text(sel):
    return f"{sel['dish']}: tap the ingredients you need to buy."


def checklist_markup(sel):
    rows = [[{"text": ("✅ " if i in sel["checked"] else "⬜ ") + f"{it['name']} x{it.get('quantity', 1)}",
              "callback_data": f"t:{i}"}] for i, it in enumerate(sel["items"])]
    rows.append([{"text": "Select all", "callback_data": "all"}, {"text": "Clear", "callback_data": "none"}])
    rows.append([{"text": f"Buy selected ({len(sel['checked'])})", "callback_data": "buy"},
                 {"text": "Cancel", "callback_data": "cancel"}])
    return {"inline_keyboard": rows}


def price_selection(chat_id, sel):
    items = [sel["items"][i] for i in sorted(sel["checked"])]
    say(chat_id, "Searching merchants for your ingredients...")
    order = prepare_order(client, {"name": sel["dish"], "ingredients": items}, EMAIL, SHIPPING,
                          notify=lambda text: say(chat_id, text))
    log.info("[%s] priced %s: total %.2f, missing %s", chat_id, sel["dish"], order["total"], order["missing"])
    if not order["quotes"]:
        selections[chat_id] = sel  # keep the checklist usable so the user can retry
        return say(chat_id, "I couldn't buy any of the selected ingredients.\n\n" + summarize(order)
                   + "\n\nYou can tap Buy selected on the list above to try again.")
    budget = budgets.get(chat_id)
    if budget is not None and order["total"] > budget:
        return say(chat_id, summarize(order) + f"\n\nOver your budget of {budget:.2f}. Nothing charged. "
                                              "Send the recipe again with fewer items, or raise it with /budget <amount>.")
    present_order(chat_id, order)


def present_order(chat_id, order):
    pending[chat_id] = order
    requests.post(f"{TG}/sendMessage", json={
        "chat_id": chat_id, "disable_web_page_preview": True,
        "text": summarize(order) + "\n\nApprove to get the payment link for each merchant.",
        "reply_markup": {"inline_keyboard": [[{"text": "Approve & pay", "callback_data": "approve"},
                                              {"text": "Cancel", "callback_data": "decline"}]]}}, timeout=30)


def approve(chat_id):
    order = pending.pop(chat_id, None)
    if not order:
        return say(chat_id, "Nothing pending.")
    say(chat_id, "Placing order...")
    send_for_approval(chat_id, order)


def cancel(chat_id):
    for store in (pending, selections, awaiting_card):
        store.pop(chat_id, None)
    say(chat_id, "Cancelled. Nothing charged.")


def handle_callback(cq):
    chat_id, message_id, data = cq["message"]["chat"]["id"], cq["message"]["message_id"], cq["data"]
    requests.post(f"{TG}/answerCallbackQuery", json={"callback_query_id": cq["id"]}, timeout=30)
    log.info("[%s] button: %s", chat_id, data)
    if data == "approve":
        return approve(chat_id)
    if data == "decline":
        return cancel(chat_id)
    sel = selections.get(chat_id)
    if not sel:
        return say(chat_id, "That list has expired. Send the recipe again.")
    if data == "cancel":
        return cancel(chat_id)
    if data == "buy":
        if not sel["checked"]:
            return say(chat_id, "Select at least one ingredient first.")
        selections.pop(chat_id)
        if not enrollment_for(chat_id):
            awaiting_card[chat_id] = sel
            say(chat_id, "First I need a card. I'll carry on with your selection as soon as it's saved.")
            return add_card(chat_id)
        return price_selection(chat_id, sel)
    if data == "all":
        sel["checked"] = set(range(len(sel["items"])))
    elif data == "none":
        sel["checked"] = set()
    elif data.startswith("t:"):
        sel["checked"] ^= {int(data[2:])}
    requests.post(f"{TG}/editMessageReplyMarkup", json={
        "chat_id": chat_id, "message_id": message_id, "reply_markup": checklist_markup(sel)}, timeout=30)


def handle(chat_id, text):
    cmd, _, arg = text.strip().partition(" ")
    if cmd in ("/start", "/help"):
        if arg.strip() == "card":
            say(chat_id, "Welcome back. Checking your card...")
            return show_cards(chat_id)
        if arg.strip() == "order":
            return show_order_status(chat_id)
        say(chat_id, "I buy recipe ingredients for you.\n\n"
                     "/addcard - save a card on Reap's secure page\n"
                     "/budget 40 - set a spending limit\n"
                     "Send a recipe (photo, text or .txt) - tick what you need, then Buy selected\n"
                     "I'll ask for a card if you haven't added one, then continue the order\n"
                     "/cards - check your saved card\n"
                     "/approve or /cancel - confirm or drop the priced order")
    elif cmd == "/addcard":
        add_card(chat_id)
    elif cmd == "/recipe" and arg.strip():
        handle_recipe_text(chat_id, arg)
    elif cmd == "/cards":
        show_cards(chat_id)
    elif cmd == "/budget":
        try:
            budgets[chat_id] = float(arg)
            say(chat_id, f"Budget set: orders over {budgets[chat_id]:.2f} will be blocked.")
        except ValueError:
            say(chat_id, "Usage: /budget 40")
    elif cmd == "/cook":
        recipe = load_recipe(arg.strip())
        if not recipe:
            names = ", ".join(f[:-5] for f in os.listdir(RECIPES_DIR) if f.endswith(".json"))
            return say(chat_id, f"Unknown recipe. Try: {names}")
        order = prepare_order(client, recipe, EMAIL, SHIPPING)
        log.info("[%s] priced %s: total %.2f, missing %s", chat_id, arg.strip(), order["total"], order["missing"])
        if not order["quotes"]:
            return say(chat_id, "Couldn't find any of those ingredients.")
        present_order(chat_id, order)
    elif cmd == "/approve":
        approve(chat_id)
    elif cmd == "/cancel":
        cancel(chat_id)
    else:
        log.info("[%s] chat -> OpenAI", chat_id)
        turns = history.setdefault(chat_id, [])
        turns.append({"role": "user", "content": text})
        reply = chat_reply(turns[-10:])
        turns.append({"role": "assistant", "content": reply})
        del turns[:-20]
        say(chat_id, reply)


def run_autopilot(last_run):
    """Weekly standing orders, e.g. groceries for a parent. Skipped if over the budget guardrail."""
    if not os.path.exists(STANDING_ORDERS):
        return
    now = datetime.now()
    with open(STANDING_ORDERS) as f:
        for so in json.load(f):
            key = (so["recipe"], so["chat_id"], now.date())
            if now.weekday() != so["weekday"] or now.hour < so.get("hour", 9) or key in last_run:
                continue
            last_run.add(key)
            log.info("autopilot due: %s for %s", so["recipe"], so["for"])
            recipe = load_recipe(so["recipe"])
            if not recipe:
                continue
            order = prepare_order(client, recipe, EMAIL, SHIPPING, pantry=so.get("pantry", []))
            if not order["quotes"]:
                continue
            if order["total"] > so["budget"]:
                say(so["chat_id"], f"Autopilot for {so['for']} paused: {order['total']:.2f} exceeds "
                                   f"the {so['budget']} limit.\n\n{summarize(order)}")
                continue
            say(so["chat_id"], f"Autopilot groceries for {so['for']}:\n\n{summarize(order)}")
            send_for_approval(so["chat_id"], order)


def main():
    global BOT_USERNAME
    BOT_USERNAME = bot_username()
    log.info("return links go to https://t.me/%s", BOT_USERNAME)
    offset, last_run = None, set()
    log.info("bot started; allowed chats: %s; simulate=%s; default enrollment=%s; saved cards=%d",
             sorted(ALLOWED) or "NONE (all messages ignored)", SIMULATE, DEFAULT_ENROLLMENT or "none", len(enrollments))
    for pending_chat, pending_id in list(state["pending"].items()):
        log.info("resuming card setup tracking for chat %s", pending_chat)
        threading.Thread(target=track_enrollment, args=(int(pending_chat), pending_id), daemon=True).start()
    while True:
        chat_id = None
        try:
            r = requests.get(f"{TG}/getUpdates", params={"timeout": 30, "offset": offset}, timeout=40)
            for update in r.json().get("result", []):
                offset = update["update_id"] + 1
                cq = update.get("callback_query")
                if cq:
                    chat_id = cq["message"]["chat"]["id"]
                    if chat_id in ALLOWED:
                        handle_callback(cq)
                    continue
                msg = update.get("message") or {}
                chat_id, text = msg.get("chat", {}).get("id"), msg.get("text")
                if chat_id not in ALLOWED:
                    log.warning("ignored message from unauthorized chat %s", chat_id)
                    continue
                kind = "photo" if msg.get("photo") else "text"
                log.info("[%s] received %s: %s", chat_id, kind, (text or msg.get("caption") or "")[:80])
                doc = msg.get("document") or {}
                if msg.get("photo"):
                    handle_photo(chat_id, msg["photo"][-1]["file_id"], msg.get("caption", ""))
                elif doc.get("mime_type", "").startswith("image/"):
                    handle_photo(chat_id, doc["file_id"], msg.get("caption", ""))
                elif doc.get("mime_type") == "text/plain":
                    info = requests.get(f"{TG}/getFile", params={"file_id": doc["file_id"]}, timeout=30).json()["result"]
                    body = requests.get(f"{TG_FILES}/{info['file_path']}", timeout=60).content
                    handle_recipe_text(chat_id, body.decode("utf-8", "ignore"), msg.get("caption", ""))
                elif text and not text.startswith("/") and text.count("\n") >= 3:
                    handle_recipe_text(chat_id, text)
                elif text:
                    handle(chat_id, text)
            run_autopilot(last_run)
        except requests.RequestException as e:
            log.warning("network error, retrying: %s", e)
            time.sleep(5)
        except Exception:
            log.exception("error handling update")
            if chat_id in ALLOWED:
                say(chat_id, "Sorry, something went wrong with that. Please try again.")
            time.sleep(1)


if __name__ == "__main__":
    main()
