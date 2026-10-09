"""Telegram bot: buy ingredients inside a chat, plus weekly autopilot groceries for someone you care for.

Every charge still needs a one-tap approval on Reap's hosted page; the bot sends that link in chat.
Uses Telegram's HTTP API directly (no extra dependency).
"""
import json
import os
import threading
import time
from datetime import datetime

import requests

from planner import place_order, prepare_order, summarize, wait_for_checkout
from reap_client import ReapClient

TG = f"https://api.telegram.org/bot{os.environ.get('TELEGRAM_BOT_TOKEN', '')}"
ALLOWED = {int(c) for c in os.environ.get("TELEGRAM_ALLOWED_CHATS", "").split(",") if c.strip()}
RECIPES_DIR = os.path.join(os.path.dirname(__file__), "recipes")
STANDING_ORDERS = os.environ.get("STANDING_ORDERS_FILE", "standing_orders.json")

client = ReapClient(os.environ["REAP_API_KEY"],
                    base_url=os.environ.get("REAP_BASE_URL", "https://sandbox.api.reap.global"))
ENROLLMENT_ID = os.environ["REAP_ENROLLMENT_ID"]
EMAIL = os.environ["REAP_EMAIL"]
RETURN_URL = os.environ["REAP_RETURN_URL"]
SHIPPING = json.loads(os.environ.get("REAP_SHIPPING_ADDRESS", "null"))
SIMULATE = os.environ.get("REAP_SIMULATE") == "1"

pending = {}  # chat_id -> prepared order awaiting /approve


def say(chat_id, text):
    requests.post(f"{TG}/sendMessage",
                  json={"chat_id": chat_id, "text": text, "disable_web_page_preview": True}, timeout=30)


def load_recipe(name):
    path = os.path.join(RECIPES_DIR, f"{os.path.basename(name)}.json")
    if not os.path.exists(path):
        return None
    with open(path) as f:
        return json.load(f)


def track(chat_id, merchant, checkout_id):
    final = wait_for_checkout(client, checkout_id)
    if final["status"] == "COMPLETED":
        say(chat_id, f"{merchant}: order {final['orderId']} placed, charged {final['finalAmount']['amount']}.")
    else:
        say(chat_id, f"{merchant}: {final['status']}. Nothing was bought; send the request again to retry.")


def send_for_approval(chat_id, order):
    for merchant, checkout in place_order(client, order, ENROLLMENT_ID, RETURN_URL, SIMULATE):
        if isinstance(checkout, str):
            say(chat_id, f"{merchant}: checkout failed: {checkout}")
            continue
        action = checkout.get("nextAction")
        if action:
            say(chat_id, f"{merchant}: tap to approve payment\n{action['url']}")
        threading.Thread(target=track, args=(chat_id, merchant, checkout["id"]), daemon=True).start()


def handle(chat_id, text):
    cmd, _, arg = text.strip().partition(" ")
    if cmd == "/cook":
        recipe = load_recipe(arg.strip())
        if not recipe:
            names = ", ".join(f[:-5] for f in os.listdir(RECIPES_DIR) if f.endswith(".json"))
            return say(chat_id, f"Unknown recipe. Try: {names}")
        order = prepare_order(client, recipe, EMAIL, SHIPPING)
        if not order["quotes"]:
            return say(chat_id, "Couldn't find any of those ingredients.")
        pending[chat_id] = order
        say(chat_id, summarize(order) + "\n\nReply /approve to buy or /cancel.")
    elif cmd == "/approve":
        order = pending.pop(chat_id, None)
        say(chat_id, "Nothing pending." if not order else "Placing order...")
        if order:
            send_for_approval(chat_id, order)
    elif cmd == "/cancel":
        pending.pop(chat_id, None)
        say(chat_id, "Cancelled. Nothing charged.")
    else:
        say(chat_id, "Commands: /cook <recipe>, /approve, /cancel")


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
    offset, last_run = None, set()
    while True:
        try:
            r = requests.get(f"{TG}/getUpdates", params={"timeout": 30, "offset": offset}, timeout=40)
            for update in r.json().get("result", []):
                offset = update["update_id"] + 1
                msg = update.get("message") or {}
                chat_id, text = msg.get("chat", {}).get("id"), msg.get("text")
                if text and chat_id in ALLOWED:
                    handle(chat_id, text)
            run_autopilot(last_run)
        except requests.RequestException:
            time.sleep(5)


if __name__ == "__main__":
    main()
