# Cooking ingredients on autopilot, bought inside a chat (Reap)

Two hackathon themes, one build on Reap Agentic Payments:

- **Everyday life:** weekly groceries for someone you care for (e.g. a parent) are priced and sent for payment automatically, with a budget limit and a pantry list so nothing is bought twice.
- **Commerce in chat:** the whole flow runs in Telegram. Message `/cook pad_thai`, see the per-merchant totals, `/approve`, tap Reap's hosted approval link, and get the order confirmation back in the same chat.

Every charge still needs a one-tap approval on Reap's hosted page. Recurring mandates (approve once, charge on a schedule) are "coming soon" in Reap's docs; when they ship, the autopilot can skip the tap.

## Setup

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # fill in values, then: set -a; source .env; set +a
```

One-time card setup: `POST /agentic/enrollments` (source `EXTERNAL`), send the user to `nextAction.url`,
then put the enrollment id in `REAP_ENROLLMENT_ID`. Sandbox test card: 4622 9431 2313 7797, CVC 640, 12/27, OTP 456789.

## Chat bot + autopilot

1. Create a bot with @BotFather and set `TELEGRAM_BOT_TOKEN`.
2. Set `TELEGRAM_ALLOWED_CHATS` to the chat ids allowed to spend (comma-separated); all other chats are ignored.
3. Edit `standing_orders.json` (`weekday` 0=Mon, `budget`, `pantry`, `chat_id` of whoever approves).
4. `python chat_bot.py`

Commands: `/cook <recipe>`, `/approve`, `/cancel`. Add recipes as `recipes/<name>.json`.

## CLI

```bash
python grocery_agent.py recipes/pad_thai.json --budget 40 --simulate
```

`--simulate` (or `REAP_SIMULATE=1` for the bot) completes checkouts in the sandbox without the approval step.

## Notes

- One quote and checkout per merchant; the cheapest in-stock match under each ingredient's `max_price` is chosen.
- Autopilot skips and alerts the chat if the total exceeds the standing order's `budget`.
- Agentic Payments must be enabled on your Reap project and the card must support Visa token services.
# ReapHackaton
