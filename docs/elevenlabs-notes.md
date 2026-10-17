# ElevenLabs as a voice cloning provider (Easy-Voice)

Researched 2026-10-16, not built. Sources: elevenlabs.io docs, pricing pages, Terms of Use (updated 2026-10-09),
Prohibited Use Policy and OEM Terms (updated 2025-02-28); URLs per section. Nothing here has been checked against a
live ElevenLabs account yet.

Conventions: base URL `https://api.elevenlabs.io`, auth header `xi-api-key: <key>`. Regional hosts exist (US, EU,
India, Singapore). Items marked **UNCONFIRMED** were not verified in an official source or on a live call.

Two options are compared: **(A) users bring their own ElevenLabs API key (BYOK)** and **(B) ElevenLabs runs on our
account and is billed through our ledger**.

---

## 1. How it fits our stack

Calls run on Telnyx AI Assistants (SPEC §3), so we never stream TTS ourselves. Telnyx already supports ElevenLabs as
an assistant TTS provider (see telnyx-api-notes §8 and §12):
- `voice_settings.voice` takes `ElevenLabs.<ModelId>.<VoiceId>`, e.g. `ElevenLabs.eleven_multilingual_v2.21m00Tcm4TlvDq8ikWAM`.
  The `ModelId` part is optional. (Confirmed in the Telnyx OpenAPI spec, 2026-10-17.)
- `voice_settings.api_key_ref` is the **identifier** of a Telnyx Integration Secret that holds the ElevenLabs key.
  Telnyx calls ElevenLabs with it, so the TTS characters are billed to that key's ElevenLabs account.
- Create a secret: `POST /v2/integration_secrets` with `{ identifier, type: "bearer", token }`; the response has
  `data.id`. Delete it with `DELETE /v2/integration_secrets/{id}`. List: `GET /v2/integration_secrets`.
- `POST /v2/text-to-speech/speech` accepts `elevenlabs.api_key`, and says "If not provided, the default Telnyx key is
  used". So Telnyx may offer ElevenLabs voices on its own key, billed by Telnyx; that matters for option B
  (**UNCONFIRMED** whether assistants allow this too, and at what price).
- `voice_settings` also takes ElevenLabs tuning: `similarity_boost`, `style`, `use_speaker_boost`, `speed`.
- `GET /v2/text-to-speech/voices?provider=elevenlabs&api_key=...` lists a key's voices through Telnyx.

So the work splits in two:
- **Cloning** goes straight to ElevenLabs (`POST /v1/voices/add`). Telnyx doesn't proxy it.
- **Using the clone on calls** stays on Telnyx: the assistant gets the ElevenLabs voice string plus an `api_key_ref`.

Code impact (rough):
- `VoiceProvider` mixes call/number functions with Telnyx cloning. Cloning would move behind its own
  clone-provider interface, with Telnyx and ElevenLabs implementations.
- `voices` needs a `provider` column, and for BYOK, the key/secret it belongs to.
- `voicePreview` for an ElevenLabs clone would call ElevenLabs TTS, or Telnyx `/text-to-speech/speech` if it accepts
  the key (**UNCONFIRMED**).

**Possible unblocker (UNCONFIRMED):** the Telnyx L2 block (telnyx-api-notes §13, error `10010`) is about *Telnyx*
cloned voices. An ElevenLabs voice is a third-party voice and may not be gated. If so, cloning could ship on live
without waiting for L2 verification (`VOICE_CLONING` is off in live today). This is the first thing to test.

## 2. Cloning API

Instant Voice Cloning (IVC) is the only kind that fits our "upload a sample" flow. Professional Voice Cloning (PVC)
needs at least 30 minutes of audio (2–3 h recommended), takes 3–24 h to train, and needs the speaker to pass a spoken
voice captcha. That captcha can't be bypassed.

- **Create (IVC):** `POST /v1/voices/add`, multipart. Body: `name`, `files[]`, optional `remove_background_noise`,
  `description`, `labels`. Response: `voice_id`, `requires_verification`. The voice can be used right away, with no
  processing state. Doc: https://elevenlabs.io/docs/api-reference/voices/ivc/create
- **Samples:** total length matters, not file count. Aim for 1–2 minutes, no more than 3. One speaker, no noise or
  reverb; MP3 at 192 kbps or higher recommended.
  Doc: https://elevenlabs.io/docs/product-guides/voices/voice-cloning/instant-voice-cloning
- **Delete:** `DELETE /v1/voices/{voice_id}`.
- **Entitlements:** `GET /v1/user/subscription` returns `can_use_instant_voice_cloning`, `voice_limit`,
  `professional_voice_limit` and `max_voice_add_edits`.
  Doc: https://elevenlabs.io/docs/api-reference/user/subscription/get
- IVC needs Starter or higher.
- **Custom voice slots per account:** Free 3, Starter 10, Creator 30, Pro 160, Scale 660, Business 2,200,
  Enterprise custom.
- **Consent:** ElevenLabs only asks for the uploader's own confirmation of consent. We already capture that
  (`voices.consentAt`).

## 3. TTS for phone calls

- **Models:**
  - `eleven_flash_v2_5`: ~75 ms, 32 languages incl. Mandarin.
  - `eleven_v4_turbo`: ~100 ms.
  - `eleven_v3_conversational`: ~280 ms.
  - Multilingual v2/v3/v4 have no published latency.
  - Flash is the obvious pick for calls.
  - Doc: https://elevenlabs.io/docs/models
- **Concurrent requests per account (Multilingual / Flash):** Free 2/4, Starter 3/6, Creator 5/10, Pro 10/20,
  Scale 15/30, Business 15/30, Enterprise higher. Under option B this is a hard cap on simultaneous calls that use
  ElevenLabs voices, across all users.
- **Phone output formats:** `ulaw_8000`, `alaw_8000`, `pcm_8000`. These only matter if we ever stream directly;
  Telnyx handles the format today.

## 4. Pricing

Plans (https://elevenlabs.io/pricing). The Starter/Creator prices differ between the plan cards and the FAQ/API page,
so re-check before quoting.

| Plan | $/month | Notes |
|---|---|---|
| Starter | 6 (promo 1) | IVC |
| Creator | 22 (promo 11) | |
| Pro | 99 | |
| Scale | 299 | lowest plan the OEM Terms allow for reselling |
| Business | 990 | |
| Enterprise | custom | Zero Retention Mode, higher limits |

- **API price per 1k characters:** Flash / Turbo / v3 Conversational $0.04; Multilingual / v3 / v4 $0.08.
  Doc: https://elevenlabs.io/pricing/api
- **Cloned voices:** no extra charge is listed. Usage analytics has a `voice_multiplier` dimension, so whether our own
  IVC voices bill at a multiplier is **UNCONFIRMED**.
- **What Telnyx charges** for an assistant minute that uses an external ElevenLabs voice, compared with its own TTS,
  is **UNCONFIRMED**.

**Per-minute cost estimate (our assumption, not from docs):** the agent speaks about 40% of a call at ~150 words
(~800 characters) per minute, so roughly 300–450 characters per call-minute.

| Model | Cost per call-minute |
|---|---|
| Flash | ~1.2–1.8¢ |
| Multilingual | ~2.4–3.6¢ |

Compare our flat `PRICE_CALL_PER_MINUTE_CENTS` = 15.

## 5. Option A — users bring their own key (BYOK)

**Terms:** the cleanest option. The user is the ElevenLabs customer, on their own plan and under the ToS.
Third-party use of a user's key is explicitly supported:
https://elevenlabs.io/docs/help-center/account/general/how-can-i-use-eleven-labs-with-third-party-services .
No OEM agreement is needed. There is no OAuth (**UNCONFIRMED**), so users paste a key.

**Flow:**
1. **Connect:** the user pastes a key. Validate it with `GET /v1/user/subscription` and require
   `can_use_instant_voice_cloning`.
2. **Key permissions:** keys are restricted by default. Tell users to enable Voices (read/write) and Text to Speech;
   the exact scope names are **UNCONFIRMED**. Keys can also have a credit quota, IP allowlist and expiry (useful for
   users). Doc: https://elevenlabs.io/docs/overview/administration/workspaces/api-keys
3. **Store the key twice:**
   - Encrypted in our DB, because we call `/v1/voices/add` and `DELETE /v1/voices/{id}` ourselves.
   - As a per-user Telnyx Integration Secret, for `api_key_ref`.
   - Any limit on integration secrets per Telnyx account is **UNCONFIRMED**.
4. **Clone:** `POST /v1/voices/add` with the user's key. The voice lives in their ElevenLabs account and uses their
   slots.
5. **Agent:** set the ElevenLabs voice and the user's `api_key_ref`.

**Billing:**
- No ElevenLabs cost to us. Drop or reduce the 500¢ clone fee for BYOK voices.
- Keep the per-minute call rate. Telnyx's own TTS share may disappear, so a discount is possible later.

**Risks:**
- The user's credits or quota run out mid-call, or they revoke or rotate the key. TTS would fail mid-call (how the
  assistant behaves then is **UNCONFIRMED**). We need a key health check before dialing and a clear error state on the
  voice or agent.
- The user's plan concurrency limit caps that user's simultaneous calls. This only matters for heavy users.
- Friction: the user needs a paid ElevenLabs account. That's fine for power users, but it isn't "easy" for everyone.
- Deleting a key or voice on our side: decide whether we also delete the voice in their ElevenLabs account. It's
  their account, so probably ask.

## 6. Option B — on our account, billed through our ledger

**Terms: a contract with ElevenLabs is needed.** Doc: https://elevenlabs.io/oem-terms
- The ToS makes access non-transferable and non-sublicensable. Offering ElevenLabs inside our product falls under the
  OEM Terms.
- Free, Starter, Creator and Pro are "expressly prohibited from Making Available the Services" to end users. That
  means Scale ($299/month) or higher, and the underlying agreement must expressly allow it. Whether self-serve Scale
  or Business is enough, or a signed contract is needed, is **UNCONFIRMED**; ask ElevenLabs sales.
- Business entities only.
- Every end user must accept an End User Agreement at least as strict as the ElevenLabs ToS and Prohibited Use
  Policy, naming ElevenLabs as a third-party beneficiary. That is a ToS update plus acceptance on our side.
- We get the consents needed for ElevenLabs to process user data, and we indemnify ElevenLabs for user breaches.
- Prohibited Use Policy (https://elevenlabs.io/use-policy) points that touch us:
  - Explicit and informed consent to clone a living person.
  - No voices of people under 18.
  - No impersonation or fraud.
  - No unlawful automated calls.
  - Disclose AI where the law requires it.
  - We may not offer terms "more permissive" than theirs.

**Capacity:**
- Slots: 660 on Scale, 2,200 on Business, shared by all users. With `CLONED_VOICES_PER_USER` that caps users with
  clones; beyond it we need Enterprise or clone eviction.
- Concurrency: 30 Flash requests at once on Scale and Business.

**Billing on our ledger:**
- **Clone:** keep the `voice_clone` purchase (500¢). It roughly covers a slot.
- **Calls:** add a per-minute surcharge for agents using an ElevenLabs voice, e.g. +3–5¢ on Flash (§4 estimate). This
  fits the flat-rate model and needs no per-character metering at call time.
- **Reconcile monthly:**
  - Use `POST /v1/workspace/analytics/query/usage-by-product-over-time` grouped by `voice_id`. Each clone's voice id
    maps to one user, so usage can be attributed per user.
  - Per-request `character-cost` / `request-id` headers exist on direct TTS calls, but we won't see them when Telnyx
    makes the call.
  - Docs: https://elevenlabs.io/docs/api-reference/introduction ,
    https://elevenlabs.io/docs/api-reference/analytics/workspace/usage
- **Fixed cost:** $299+/month from day one, before any revenue.

## 7. Privacy

- By default ElevenLabs keeps content and may use it for training. Training can be turned off in the account's
  "Data use" settings, and voice models can be deleted on request.
- Zero Retention Mode (`enable_logging=false`) is Enterprise-only and covers TTS endpoints. Whether it covers uploaded
  IVC samples is **UNCONFIRMED**. Doc: https://elevenlabs.io/docs/eleven-api/resources/zero-retention-mode
- Under option B we need to disclose ElevenLabs as a processor of voice samples in our privacy notice, and turn off
  training on our account.

## 8. What we built (option A, 2026-10-17)

- **Connecting:** users connect a key under Account → API keys. Voices → Clone a voice only offers connected services, plus an "Add a service" link to that page. We check it with `GET /v1/user` and `/v1/user/subscription`
  and require `can_use_instant_voice_cloning`. The key is stored AES-GCM encrypted (`elevenlabs_keys`) and as a
  Telnyx integration secret.
- **Replacing the key:** only a key for the same ElevenLabs account (`user_id`) is accepted. Agents are re-synced to
  the new secret, then the old secret is deleted.
- **Cloning:** `POST /v1/voices/add` with the user's key. The voice is ready at once, with
  `voice_ref = ElevenLabs.<ELEVENLABS_TTS_MODEL>.<voice_id>`. It isn't charged and has its own per-user limit,
  separate from Telnyx clones.
- **Agents:** `voice_settings.api_key_ref` is the user's secret identifier for ElevenLabs voices only. Telnyx clones
  stay behind `VOICE_CLONING`; ElevenLabs clones are behind `ELEVENLABS`.
- **Previews:** spoken by ElevenLabs TTS with the user's key, cached per process.
- **Deleting a voice:** also deletes it in the user's ElevenLabs account.
- **Disconnecting:** removes the key, the secret and the ElevenLabs voices here (not in ElevenLabs). It is refused
  while an agent uses one of them.
- **Calls:** billed at the normal per-minute rate.
- **Not built:** a check of key health before calls.

## 9. Recommendation and open questions

Start with **option A (BYOK)**:
- No contract and no fixed cost.
- It reuses Telnyx's existing ElevenLabs support.
- It may get cloning onto live before Telnyx L2 verification.

Move to **option B** once demand justifies the Scale/OEM commitment. The clone-provider abstraction from A carries
over; B mostly adds a platform key, the end-user agreement and a per-minute surcharge.

Check these before building, in order:
1. On a live Telnyx account, does an assistant with an ElevenLabs IVC voice and `api_key_ref` work on a real call,
   and does it avoid the `10010` L2 block?
2. What does Telnyx charge per minute when the TTS is a third-party ElevenLabs voice?
3. How does a Telnyx assistant behave when the ElevenLabs key is out of credits or revoked mid-call?
4. Is there a limit on Integration Secrets per Telnyx account (one per BYOK user)?
5. For option B: ask ElevenLabs sales whether Scale or Business allows OEM use without a custom contract, and confirm
   whether IVC voices bill at a `voice_multiplier`.
