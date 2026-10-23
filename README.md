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
- **Numbers → Simulate an inbound text** delivers a text through the real handler: stored, billed per segment, shown under **Messages**.
- Outbound calls to numbers ending in `0000` never answer, so you can test the failure path. Other numbers answer and hang up after a few seconds.

```bash
pnpm test        # integration tests against the easy_voice_test database
pnpm typecheck && pnpm lint
```

CI (`.github/workflows/ci.yml`) runs typecheck, lint, the tests against a Postgres 16 service, and a production build on every PR and on pushes to `main`.

## Going live with Telnyx

1. In the Telnyx portal, create an **Outbound Voice Profile** and a **Call Control Application**. Set the app's webhook URL to `https://<host>/api/webhooks/telnyx` and **webhook API version to "2"**. Link the outbound profile to the app, and enable **"call cost in webhooks"** (`call_cost_in_webhooks`) so each call's Telnyx cost is recorded for reconciliation. Allow only US destinations on the outbound profile (`whitelisted_destinations: ["US"]`): users pay one flat per-minute price, so a call elsewhere could cost the platform more than it charges. The app also refuses Canadian, Caribbean, toll-free and premium-rate numbers, but the profile is the safeguard that covers everything.
2. Copy the API key, the app id (`TELNYX_CONNECTION_ID`) and the webhook **public key** (`TELNYX_PUBLIC_KEY`) into `.env.local`, and set `TELNYX_MODE=live`.
3. Optional, to receive texts: create a **Messaging Profile** with webhook URL `https://<host>/api/webhooks/telnyx` and API version 2, and set `TELNYX_MESSAGING_PROFILE_ID`. Texting is **receive only** (SPEC §17). We never send, so no 10DLC registration is needed. Numbers are put on the profile when they activate. Numbers bought earlier are added by the daily cron. Never enable `messaging` on the assistants: they would start replying to texts.
4. Optional: create an Insight Group with a summary insight, and set `TELNYX_INSIGHT_GROUP_ID` so call summaries appear.
5. For local development, expose your dev server with `ngrok http 3000` and set `APP_URL` and the Telnyx webhook URL to the ngrok host.

API details and open questions are in [docs/telnyx-api-notes.md](docs/telnyx-api-notes.md).

## Models

`TELNYX_LLM_MODEL` (default `moonshotai/Kimi-K2.6`) is the language model for agents left on the default. Users can
pick another model per agent from the listed ones (`src/server/telnyx/models.ts`; SPEC §16). Speech-to-text is set for
the whole platform, never per user: `TELNYX_STT_MODEL` (default `assemblyai/universal-3-5-pro`) and
`TELNYX_STT_LANGUAGE` (default `auto`). Voices are picked per agent from the Telnyx catalog (see
`src/server/telnyx/stock-voices.ts`). Each agent records which settings it was synced with. After you change these
variables and deploy, existing agents are re-synced by the daily cron, or when their owner opens the Agents page.
Edits made directly in the Telnyx portal are overwritten the next time the agent syncs.

## ElevenLabs voices (bring your own key)

Users connect their own ElevenLabs API key under **Account → API keys**, then pick ElevenLabs in **Voices → Clone a voice** to clone into their ElevenLabs account.
Cloning is free on our side, and calls with those voices use their ElevenLabs credits. We keep the key encrypted
(`SECRETS_KEY`) to clone, delete and preview voices. We also store it as a Telnyx integration secret, which the agent
references as `voice_settings.api_key_ref`, so Telnyx can speak with the voice on calls. Set `SECRETS_KEY` in production,
or the feature stays off. Details and open questions are in [docs/elevenlabs-notes.md](docs/elevenlabs-notes.md).

## Stripe

Stripe only processes one-time top-up payments; there are no subscriptions. Number rental and usage are deducted from the balance. A top-up is between `MIN_TOPUP_CENTS` (default 1000) and `MAX_TOPUP_CENTS` (default 50000); the billing page offers the $10, $25, $50 and $100 presets that fall within them. Set `STRIPE_SECRET_KEY`. Point a webhook at `/api/webhooks/stripe` for the `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed` and `checkout.session.expired` events, then set `STRIPE_WEBHOOK_SECRET`. Top-ups stay off until both are set. Locally: `stripe listen --forward-to localhost:3000/api/webhooks/stripe`.

## Deploying to Vercel

- Connect a Neon database under Vercel → Storage. It provides `DATABASE_URL` (pooled) and `DATABASE_URL_UNPOOLED`.
- Set the remaining production variables (see `.env.example`). In production (preview deploys included) the app
  refuses to start without `DATABASE_URL`, `AUTH_SECRET`, `CRON_SECRET`, `APP_URL`, `RESEND_API_KEY` and `EMAIL_FROM`
  (`src/instrumentation.ts`), rather than falling back to dev defaults or printing sign-in codes to the logs.
- Vercel runs `vercel-build`, which builds and then applies pending migrations (`scripts/migrate.mjs`, using the
  unpooled URL), so a failed build never leaves the live deployment on a schema it doesn't know. **Only production
  builds migrate.** Preview deploys share the production database, so they skip migrations.

## Daily jobs

`GET /api/cron/daily` with `Authorization: Bearer $CRON_SECRET` charges monthly number renewals, releases numbers after the negative-balance grace period, purges recordings, transcripts, the Telnyx AI conversation and text message content older than `RETENTION_DAYS`, deletes expired sessions and sign-in codes, fetches any transcripts the post-call fetch missed, finishes number orders still in progress, and puts active numbers on the messaging profile if they aren't yet. On Vercel, `vercel.json` schedules it daily.

## Layout

| Path | What |
| --- | --- |
| `src/server/telnyx/` | Provider-neutral `VoiceProvider` interface, plus `live.ts` (Telnyx REST) and `mock.ts` |
| `src/server/calls/events.ts` | Call webhook state machine: answer or reject, start the assistant, bill on hangup |
| `src/server/messages.ts` | Inbound texts (receive only): store, bill per segment, conversations, retention |
| `src/server/billing/ledger.ts` | Idempotent balance ledger, the only way the balance changes |
| `src/server/{numbers,voices,agents}.ts` | Resource services (ownership checks, charges, refunds) |
| `src/app/(app)/` | Signed-in pages |
| `src/db/schema.ts` | Drizzle schema; migrations in `drizzle/` |
