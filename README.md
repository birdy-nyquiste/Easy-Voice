# Easy Voice

A personal AI voice agent with its own US phone number. A thin web app over Telnyx (numbers, voices, AI Assistants, Call Control) with prepaid billing through Stripe. See [SPEC.md](SPEC.md) for product decisions (§16 lists the MVP decisions).

## Run locally

```bash
pnpm install
createdb easy_voice && createdb easy_voice_test
cp .env.example .env.local
pnpm db:migrate
pnpm dev
```

Open http://localhost:3000 and sign in with any email. With `RESEND_API_KEY` unset, the one-time code is **printed in the dev server console**.

Real top-ups always go through Stripe. In dev (`pnpm dev`), the Billing page also has a **dev-only "+$10 / +$50" credit** that skips payment; it's recorded as an adjustment and is disabled in production builds. To exercise the real payment flow, use Stripe **test mode** keys locally, and run `stripe listen --forward-to localhost:3000/api/webhooks/stripe` so the balance is credited (pay with test card `4242 4242 4242 4242`).

With `TELNYX_MODE=mock` (the default in dev; production builds default to `live`), telephony is simulated. Mock mode never accepts webhooks over HTTP; simulated events are delivered in-process.

- Number search, purchase, voice cloning and assistants run against an in-memory mock.
- **Numbers → Simulate an inbound call** runs a full call through the real webhook handler: answer → hangup → billing → transcript.
- Outbound calls to numbers ending in `0000` never answer, so you can test the failure path. Other numbers answer and hang up after a few seconds.

```bash
pnpm test        # integration tests against the easy_voice_test database
pnpm typecheck && pnpm lint
```

CI (`.github/workflows/ci.yml`) runs typecheck, lint, the tests against a Postgres 16 service, and a production build on every PR and on pushes to `main`.

## Going live with Telnyx

1. In the Telnyx portal, create an **Outbound Voice Profile** and a **Call Control Application**. Set the app's webhook URL to `https://<host>/api/webhooks/telnyx` and **webhook API version to "2"**. Link the outbound profile to the app, and enable **"call cost in webhooks"** (`call_cost_in_webhooks`) so each call's Telnyx cost is recorded for reconciliation.
2. Copy the API key, the app id (`TELNYX_CONNECTION_ID`) and the webhook **public key** (`TELNYX_PUBLIC_KEY`) into `.env.local`, and set `TELNYX_MODE=live`.
3. Optional: create an Insight Group with a summary insight, and set `TELNYX_INSIGHT_GROUP_ID` so call summaries appear.
4. For local development, expose your dev server with `ngrok http 3000` and set `APP_URL` and the Telnyx webhook URL to the ngrok host.

API details and open questions are in [docs/telnyx-api-notes.md](docs/telnyx-api-notes.md).

## Stripe

Stripe only processes one-time top-up payments; there are no subscriptions. Number rental and usage are deducted from the balance. Set `STRIPE_SECRET_KEY`. Point a webhook at `/api/webhooks/stripe` for the `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed` and `checkout.session.expired` events, then set `STRIPE_WEBHOOK_SECRET`. Locally: `stripe listen --forward-to localhost:3000/api/webhooks/stripe`.

## Deploying to Vercel

- Connect a Neon database under Vercel → Storage. It provides `DATABASE_URL` (pooled) and `DATABASE_URL_UNPOOLED`.
- Set the remaining production variables (see `.env.example`). In production the app refuses to start without
  `AUTH_SECRET`, `CRON_SECRET` and `DATABASE_URL`, rather than falling back to dev defaults.
- Vercel runs `vercel-build`, which applies pending migrations (`scripts/migrate.mjs`, using the unpooled URL) and then
  builds. **Only production builds migrate.** Preview deploys share the production database, so they skip migrations.

## Daily jobs

`GET /api/cron/daily` with `Authorization: Bearer $CRON_SECRET` does four things: charges monthly number renewals, releases numbers after the negative-balance grace period, purges recordings, transcripts and the Telnyx AI conversation older than `RETENTION_DAYS`, fetches any transcripts the post-call fetch missed, and finishes number orders still in progress. On Vercel, `vercel.json` schedules it daily.

## Layout

| Path | What |
| --- | --- |
| `src/server/telnyx/` | Provider-neutral `VoiceProvider` interface, plus `live.ts` (Telnyx REST) and `mock.ts` |
| `src/server/calls/events.ts` | Call webhook state machine: answer or reject, start the assistant, bill on hangup |
| `src/server/billing/ledger.ts` | Idempotent balance ledger, the only way the balance changes |
| `src/server/{numbers,voices,agents}.ts` | Resource services (ownership checks, charges, refunds) |
| `src/app/(app)/` | Signed-in pages |
| `src/db/schema.ts` | Drizzle schema; migrations in `drizzle/` |
