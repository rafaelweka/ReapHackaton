# Chat web app (Snap-a-Recipe Cart)

Browser version of the hackathon flow: photograph or type a recipe, pantry check, budget, agent shops one Singapore merchant, then Reap sandbox checkout.

This folder is additive. The Telegram/Python bot at the repo root is unchanged.

## Setup

```bash
cd chat-web-app
npm install
cp .env.example .env.local   # fill OPENAI_API_KEY and REAP_API_KEY
npx next dev -H 127.0.0.1 -p 3000
```

Reap needs an HTTPS `REAP_RETURN_URL` (for example a Cloudflare quick tunnel to port 3000). Sandbox checkout sends `X-Simulate-Checkout: COMPLETED`.
