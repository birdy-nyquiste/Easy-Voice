# Telnyx v2 API notes (Easy-Voice)

Researched 2026-10-07. Sources: developers.telnyx.com pages (URLs per section) and the consolidated
OpenAPI spec that the docs index links to
(`https://raw.githubusercontent.com/team-telnyx/openapi/master/openapi/spec3.json`), plus the docs'
webhook catalog `https://developers.telnyx.com/data/webhook-events.json`.

Conventions: base URL `https://api.telnyx.com/v2`, auth `Authorization: Bearer <TELNYX_API_KEY>`.
Most responses are wrapped in `{ "data": ... }`. **AI Assistant endpoints are the exception: they
return the assistant object unwrapped.** List filters use deepObject style: `filter[x]=...`,
`page[number]`, `page[size]`. Items marked **UNCONFIRMED** were not verified in an official source.

---

## 1. Available number search

`GET /v2/available_phone_numbers`
Doc: https://developers.telnyx.com/api-reference/phone-number-search/list-available-phone-numbers

Query filters (all `filter[...]`):
- `filter[country_code]=US`
- `filter[phone_number_type]=local` (enum `local|toll_free|mobile|national|shared_cost`)
- `filter[national_destination_code]=415` (area code filter for US)
- `filter[locality]` (city), `filter[administrative_area]` (US state), `filter[rate_center]` (US/CA only)
- `filter[phone_number][starts_with|ends_with|contains]`
- `filter[features][]=voice` (values incl. `sms`, `mms`, `voice`, `fax`, `emergency`, `hd_voice`, ...)
- `filter[limit]`, `filter[best_effort]` (US/CA), `filter[quickship]`, `filter[reservable]`,
  `filter[exclude_held_numbers]`

Response: `data[]`, `meta`, `metadata` (`meta`/`metadata` both have `total_results`, `best_effort_results`).
Each item: `record_type` (`available_phone_number`), `phone_number` (E.164), `vanity_format`,
`best_effort` (true = not an exact match on your criteria), `quickship`, `reservable`,
`region_information[] {region_type, region_name}`, `cost_information {upfront_cost, monthly_cost, currency}`,
`features[] {name}`.

Only numbers previously returned by a search can be ordered (number-orders guide).

## 2. Number orders

### Create: `POST /v2/number_orders`
Doc: https://developers.telnyx.com/api-reference/phone-number-orders/create-a-number-order
```json
{ "phone_numbers": [{ "phone_number": "+14155550100" }],
  "connection_id": "<call control app id>",
  "customer_reference": "user_123" }
```
- `phone_numbers[]` items: `phone_number` (required), `requirement_group_id`, `bundle_id`.
- Order-level only (no per-number variant): `connection_id`, `messaging_profile_id`, `billing_group_id`,
  `customer_reference`. **Setting `connection_id` here attaches all ordered numbers to the Call
  Control app at order time.**
- Requirement groups are needed "in some countries". Whether US local needs one: **UNCONFIRMED**
  (believed not required; check `requirements_met` in the response).

### Get: `GET /v2/number_orders/{number_order_id}`
Doc: https://developers.telnyx.com/api-reference/phone-number-orders/retrieve-a-number-order
Also list: `GET /v2/number_orders`.

Response `data`: `id` (uuid), `record_type`, `phone_numbers_count`, `connection_id`,
`messaging_profile_id`, `billing_group_id`, `phone_numbers[]`, `sub_number_orders_ids[]`,
`status`, `customer_reference`, `created_at`, `updated_at`, `requirements_met`.
- Order `status` enum (spec): `pending | success | failure`. The guide also lists `cancelled`, `deleted`.
- `phone_numbers[]` item: `id` (uuid, the order-item id, **not** the phone number resource id),
  `phone_number`, `status` (`pending|success|failure`), `requirements_met`, `requirements_status`
  (`pending|approved|cancelled|deleted|requirement-info-exception|requirement-info-pending|requirement-info-under-review`),
  `phone_number_type`, `country_code`, `country_iso_alpha2`, `regulatory_requirements[]`, `bundle_id`.

### Webhook
Doc: https://developers.telnyx.com/api-reference/callbacks/number-order-status-update
- Only event type in the spec: `number_order.complete`; `data.payload` = the number order object
  above (check `payload.status`, it can still be `pending`/`failure`).
- Where the URL is configured: account "Number Order Notifications" notification setting in the
  portal (guide: https://developers.telnyx.com/docs/numbers/phone-numbers/number-orders). There is
  **no `webhook_url` field on the order request**. Simplest: poll `GET /v2/number_orders/{id}`.

## 3. Phone numbers

Docs: https://developers.telnyx.com/api-reference/phone-number-configurations/list-phone-numbers ,
.../retrieve-a-phone-number , .../update-a-phone-number , .../delete-a-phone-number

- `GET /v2/phone_numbers` with filters `filter[phone_number]` (min 3 digits), `filter[status]`,
  `filter[connection_id]`, `filter[customer_reference]`, `filter[tag]`,
  `filter[number_type][eq]`, `page[number]`, `page[size]` (default 20), `sort`.
- `GET /v2/phone_numbers/{id}`. `{id}` is the phone number resource id, a numeric string such as
  `"1293384261075731499"`. Get it via `GET /v2/phone_numbers?filter[phone_number]=+1415...` after
  the order completes.
- `PATCH /v2/phone_numbers/{id}` with body `{ "connection_id": "<app id>" }`. Other fields:
  `tags`, `customer_reference`, `billing_group_id`, `external_pin`, `hd_voice_enabled`, `address_id`.
- `DELETE /v2/phone_numbers/{id}` releases the number from the account and returns the final
  representation in `data`. Fails if `deletion_lock_enabled` is true.

Response fields: `id`, `record_type`, `phone_number`, `status`, `connection_id`, `connection_name`,
`customer_reference`, `tags`, `phone_number_type`, `purchased_at`, `created_at`, `updated_at`,
`activated_at`, `deletion_lock_enabled`, `billing_group_id`, `messaging_profile_id`, `emergency_enabled`.
`status` enum: `purchase-pending | purchase-failed | port-pending | port-failed | active | deleted |
emergency-only | ported-out | port-out-pending | requirement-info-pending |
requirement-info-under-review | requirement-info-exception | provision-pending`.

## 4. Call Control Application (the `connection_id`)

`POST /v2/call_control_applications` returns **201**.
Doc: https://developers.telnyx.com/api-reference/call-control-applications/create-a-call-control-application
Also `GET|PATCH|DELETE /v2/call_control_applications/{id}`.
```json
{ "application_name": "easy-voice-prod",
  "webhook_event_url": "https://app.example.com/api/telnyx/webhook",
  "webhook_api_version": "2",
  "webhook_event_failover_url": null,
  "webhook_timeout_secs": 10,
  "outbound": { "outbound_voice_profile_id": "<ovp id>" } }
```
- Required: `application_name`, `webhook_event_url`.
- **`webhook_api_version` defaults to `"1"`. Set `"2"`** to get the v2 envelope documented below.
- Other fields: `active` (default true), `anchorsite_override` (default `Latency`), `dtmf_type`,
  `first_command_timeout`, `first_command_timeout_secs` (default 30), `inbound {channel_limit,
  shaken_stir_enabled, sip_subdomain, sip_subdomain_receive_settings}`, `outbound {channel_limit,
  outbound_voice_profile_id}`, `call_cost_in_webhooks`, `redact_dtmf_debug_logging`.
  The docs give the `webhook_timeout_secs` range as 0–30.
- Response `data.id` is the `connection_id` used for `number_orders`, `PATCH /phone_numbers/{id}`,
  and `POST /calls`. `data.record_type` = `call_control_application`.
- Outbound PSTN dialing presumably needs an Outbound Voice Profile (`/v2/outbound_voice_profiles`)
  linked to the app via `outbound.outbound_voice_profile_id`. Whether that is strictly required is
  **UNCONFIRMED**.

## 5. Call Control commands

All commands are `POST /v2/calls/{call_control_id}/actions/<command>`. Every command accepts
`client_state` (**must be Base64**, echoed in later webhooks) and `command_id` (idempotency key,
deduped per `call_control_id`). Command responses: `data.result` (e.g. `"ok"`).

### Dial: `POST /v2/calls`
Doc: https://developers.telnyx.com/api-reference/call-commands/dial
- Required: `connection_id`, `to` (E.164 or SIP URI, or an array), `from` (E.164).
- Useful: `client_state` (Base64), `webhook_url`, `webhook_url_method` (`POST|GET`),
  `timeout_secs` (default 30, 5–600), `time_limit_secs` (default 14400, 30–14400),
  `answering_machine_detection` (`premium|detect|detect_beep|detect_words|greeting_end|disabled|...`),
  `record: "record-from-answer"`, `record_format` (`wav|mp3`, default mp3), `record_channels`
  (`single|dual`, default dual), `record_track`, `record_max_length`, `command_id`,
  `from_display_name`.
- **`assistant` object (CallAssistantRequest) is accepted on Dial**: `{ "id": "<assistant id>", ... }`.
  Fields are the same overrides as in `answer` below. The spec does not say explicitly that the
  assistant starts automatically when the call is answered (it is implied; **UNCONFIRMED**).
- Response `data`: `call_control_id`, `call_leg_id`, `call_session_id`, `is_alive` (always false),
  `record_type` (`call`), `client_state`, `recording_id` (only with `record`), `start_time`.
- Webhooks sent: `call.initiated` (direction `outgoing`), then `call.answered` or `call.hangup`.

### Answer: `.../actions/answer`
Doc: https://developers.telnyx.com/api-reference/call-commands/answer-call
- Body (all optional): `client_state`, `command_id`, `webhook_url`, `webhook_url_method`, `record`,
  `record_format`, `record_channels`, `record_track`, `record_max_length`, `record_trim`,
  `billing_group_id`, `transcription`, `stream_url`, ...
- **`assistant`**: `{ "id" (required), "instructions", "greeting", "voice_settings": { "voice" },
  "transcription": { "model", "language" }, "dynamic_variables", "tools", "model", "name",
  "llm_api_key_ref", "fallback_config", "external_llm", "mcp_servers", "observability_settings" }`.
  Omitted fields use the stored assistant. Supplied `voice_settings` and `transcription` **replace**
  the stored objects (no merge). `dynamic_variables` merge, request wins.
- With `assistant.id`, Telnyx warms up the assistant, answers, and starts it automatically.
  **Do not also send `ai_assistant_start`.** The `conversation_id` arrives in the
  `call.conversation.created` webhook, not in the HTTP response.
- Response `data`: `result`, `recording_id` (if `record`).

### Reject: `.../actions/reject`
Doc: https://developers.telnyx.com/api-reference/call-commands/reject-a-call
- Required `cause`: `CALL_REJECTED` (SIP 603) | `USER_BUSY` (486) | `NOT_FOUND` (404) |
  `TEMPORARILY_UNAVAILABLE` (480). Optional `client_state`, `command_id`.
- Only valid on unanswered inbound calls. Produces `call.hangup` (e.g. `hangup_cause: call_rejected`).

### Hangup: `.../actions/hangup`
Doc: https://developers.telnyx.com/api-reference/call-commands/hangup-call
Body: `client_state`, `command_id`, `custom_headers[] {name, value}`.

### Start AI Assistant: `.../actions/ai_assistant_start` (call must already be answered)
Doc: https://developers.telnyx.com/api-reference/call-commands/start-ai-assistant
Guide: https://developers.telnyx.com/docs/voice/programmable-voice/ai-assistant-start
```json
{ "assistant": { "id": "assistant-<uuid>",
                 "voice_settings": { "voice": "Telnyx.KokoroTTS.af_heart" },
                 "dynamic_variables": { "user_name": "Ada" } },
  "greeting": "Hi, this is ...",
  "transcription": { "model": "deepgram/nova-3", "language": "en" },
  "interruption_settings": { "enable": true },
  "send_message_history_updates": false,
  "client_state": "<base64>", "command_id": "<uuid>" }
```
- Top-level fields: `assistant` (same CallAssistantRequest as answer/dial), `greeting`,
  `interruption_settings {enable}`, `transcription {model, language}`, `message_history[]`
  (seed messages), `send_message_history_updates`, `participants[] {id, role:"user", name, on_hangup}`,
  `client_state`, `command_id`. There is **no top-level `voice`**; the voice goes in
  `assistant.voice_settings.voice`.
- Response `data`: `result`, **`conversation_id`**.
- Webhooks sent: `call.conversation.created`, `call.conversation.ended`,
  `call.conversation_insights.generated`.
- Stop: `.../actions/ai_assistant_stop`. Add a leg: `.../actions/ai_assistant_join`
  (`conversation_id`, `participant {id, role, name, on_hangup}`).

### Record start: `.../actions/record_start`
Doc: https://developers.telnyx.com/api-reference/call-commands/recording-start
- Required: `format` (`wav|mp3`), `channels` (`single|dual`). `dual` puts the first leg on channel A
  and the rest on channel B.
- Optional: `play_beep`, `max_length` (0 = unlimited, max 14400), `timeout_secs`,
  `recording_track` (`both|inbound|outbound`), `trim` (`trim-silence`), `custom_file_name`,
  `transcription` (bool) plus `transcription_engine`/`transcription_language`, `client_state`,
  `command_id`.
- Response `data.result` only (**no `recording_id`**). Stop with `.../actions/record_stop`.
- Alternative: assistant-level `telephony_settings.recording_settings` (§8).

## 6. Call webhooks (Call Control, v2 format)

Guide: https://developers.telnyx.com/docs/voice/programmable-voice/voice-api-webhooks
Envelope:
```json
{ "data": { "record_type": "event", "event_type": "call.initiated", "id": "<uuid>",
            "occurred_at": "2026-...Z", "payload": { ... } },
  "meta": { "attempt": 1, "delivered_to": "https://..." } }
```
Common `payload` fields: `call_control_id`, `call_leg_id`, `call_session_id`, `connection_id`,
`client_state` (Base64, as sent), `from`, `to`.

| event_type | Extra payload fields |
|---|---|
| `call.initiated` | `direction` (`incoming`/`outgoing`), `state` (`parked`/`bridging`), `start_time`, `caller_id_name`, `call_screening_result`, `shaken_stir_attestation`, `shaken_stir_validated`, `custom_headers`, `sip_headers`, `tags`, `offered_codecs`, `connection_codecs` |
| `call.answered` | `start_time`, `state: "answered"`, `tags` |
| `call.hangup` | `start_time`, `state: "hangup"`, `hangup_cause` (`call_rejected|normal_clearing|originator_cancel|timeout|time_limit|user_busy|not_found|no_answer|unspecified`), `hangup_source` (`caller|callee|unknown`), `sip_hangup_cause`, `call_quality_stats` |
| `call.recording.saved` | `recording_started_at`, `recording_ended_at`, `channels`, `recording_urls {mp3, wav}` (**valid 10 minutes**), `public_recording_urls {mp3, wav}` (valid while the file exists; per-account feature) |
| `call.conversation.created` | `conversation_id`, `call_control_id` |
| `call.conversation.start_failed` | `reason`: `invalid_request` or `service_error` (only for `answer` with `assistant.id`; the call stays answered) |
| `call.conversation.ended` | `assistant_id`, `conversation_id`, `duration_sec`, `reason` (nullable), `calling_party_type` (`pstn|sip`), `llm_model`, `stt_model`, `tts_provider`, `tts_model_id`, `tts_voice_id` |
| `call.conversation_insights.generated` | `insight_group_id`, `results[] {insight_id, result}`, `calling_party_type` |
| `call.ai_gather.message_history_updated` | `message_history[] {role, content}`, the full history each time (only if `send_message_history_updates`) |

Notes:
- **`call.hangup` has no `end_time` field.** Use `data.occurred_at` as the end time. Only Dial and
  recording responses expose `end_time`.
- **`call.recording.saved` has no `call_control_id` and no `recording_id` in the schema.** Correlate
  via `call_leg_id`/`call_session_id`, or look it up with `GET /v2/recordings?filter[call_leg_id]=...`.
- Deliveries can be duplicated or out of order. Dedupe on `data.id`. Failover URL is used if the primary fails.
- Callback reference pages: https://developers.telnyx.com/api-reference/callbacks/call-initiated ,
  .../call-hangup , .../call-recording-saved , .../call-conversation-created ,
  .../call-conversation-start-failed , .../call-conversation-ended ,
  .../call-conversation-insights-generated
- `call.conversation.created` and `call.conversation.start_failed` are documented in the guide and
  callback pages but are absent from the OpenAPI webhook schemas, so their exact field list beyond
  the IDs above is **UNCONFIRMED**.

## 7. Webhook signature verification

Docs: https://developers.telnyx.com/docs/development/api-fundamentals/webhooks/receiving-webhooks ,
https://developers.telnyx.com/docs/messaging/messages/receiving-webhooks ,
https://developers.telnyx.com/docs/development/sdk/node/webhooks
- Headers: `telnyx-signature-ed25519` (Base64 Ed25519 signature) and `telnyx-timestamp` (Unix seconds).
- Signed message: `` `${timestamp}|${rawBody}` ``, using the **exact raw body bytes**. Do not
  re-serialize JSON. In Next.js route handlers, read `await req.text()` before parsing.
- Public key: Mission Control Portal → API Keys → Public Key
  (https://portal.telnyx.com/#/api-keys/public-key), stored as `TELNYX_PUBLIC_KEY` (Base64). Docs'
  Go/C#/PHP examples decode it to a raw 32-byte Ed25519 key. For Node `crypto.verify`, wrap it in
  SPKI DER (prefix `302a300506032b6570032100`) or use `tweetnacl`.
- Reject requests whose timestamp is older than 5 minutes (300 s).
- Node SDK: `client.webhooks.unwrap(rawBody, { headers })` verifies and throws on failure.
  `unsafeUnwrap` skips verification.
- Acknowledge with 2xx (use 200) quickly. Process asynchronously and idempotently.

## 8. AI Assistants

Docs: https://developers.telnyx.com/api-reference/assistants/create-an-assistant ,
.../get-an-assistant , .../update-an-assistant , .../delete-an-assistant

| Op | Method + path |
|---|---|
| Create | `POST /v2/ai/assistants` (optional header `Idempotency-Key`) |
| Get | `GET /v2/ai/assistants/{assistant_id}` (opt. `call_control_id`, `fetch_dynamic_variables_from_webhook`) |
| Update | **`POST /v2/ai/assistants/{assistant_id}`** (not PATCH). Body = create fields + `promote_to_main` (default true) |
| Delete | `DELETE /v2/ai/assistants/{assistant_id}` (`?hard_delete=true` skips the soft-delete "Recently Deleted" list). Response `{id, object, deleted}` |
| List | `GET /v2/ai/assistants` |

Create body (required: `name`, `instructions`):
```json
{ "name": "user_123_agent",
  "model": "<model id from models API>",
  "instructions": "You are ... {{user_name}}",
  "greeting": "Hello, ...",
  "voice_settings": { "voice": "Telnyx.KokoroTTS.af_heart", "voice_speed": 1.0 },
  "transcription": { "model": "deepgram/nova-3", "language": "en" },
  "telephony_settings": { "time_limit_secs": 1800, "user_idle_timeout_secs": 60,
     "send_message_history_updates": false,
     "recording_settings": { "enabled": true, "channels": "dual", "format": "mp3",
                             "stop_on_conversation_end": false } },
  "enabled_features": ["telephony"],
  "insight_settings": { "insight_group_id": "<uuid>" },
  "privacy_settings": { "data_retention": true },
  "dynamic_variables": { "user_name": "there" },
  "tags": ["user_123"] }
```
- `voice_settings`: `voice` (required), `voice_speed` (0.6–1.5), `api_key_ref` (ElevenLabs secret),
  `temperature`, `similarity_boost`, `use_speaker_boost`, `style`, `speed`, `language_boost`,
  `expressive_mode`, `background_audio`.
- Voice id formats: Telnyx `Telnyx.<model_id>.<voice_id>` (e.g. `Telnyx.KokoroTTS.af_heart`,
  `Telnyx.Ultra.<voice_id>`), Minimax `Minimax.<ModelId>.<VoiceId>`, AWS `AWS.Polly.<voice_id>`,
  Azure `azure.<voice>`. ElevenLabs needs `api_key_ref`. Mustache templating works
  (`Telnyx.Ultra.{{voice_id}}`). Cloned voices: see §9.
- `transcription`: `model` (enum incl. `deepgram/flux`, `deepgram/nova-3`, `deepgram/nova-2`,
  `azure/fast`, `assemblyai/universal-streaming`, `xai/grok-stt`, `soniox/...`, `nvidia/parakeet-v3`),
  `language` (unset or `auto` = autodetect), `region`, `api_key_ref`, `settings`.
- `telephony_settings`: `default_texml_app_id` (**auto-created TeXML app on create**),
  `supports_unauthenticated_web_calls`, `noise_suppression` (`aicoustics|krisp|deepfilternet|disabled`),
  `time_limit_secs` (default 1800), `user_idle_timeout_secs`, `user_idle_reply_secs` (default 10),
  `fallback_destination`, `send_message_history_updates`, `voicemail_detection`, `disable_dtmf`,
  `recording_settings`.
- Other fields: `description`, `tool_ids`, `tools` (deprecated inline), `mcp_servers`,
  `llm_api_key_ref`, `external_llm`, `fallback_config`, `interruption_settings`,
  `dynamic_variables_webhook_url`, `post_conversation_settings`, `messaging_settings`,
  `websocket_settings`, `conversation_flow`.
- Response (unwrapped): `id` (format `assistant-<uuid>`), `name`, `created_at`, plus all config,
  `version_id`.

### After a call: conversations, transcript, insights
Docs: https://developers.telnyx.com/api-reference/conversations/list-conversations ,
.../get-conversation-messages , .../get-insights-for-a-conversation
- Best: store `conversation_id` from the `ai_assistant_start` response or `call.conversation.created`.
- Lookup by call: `GET /v2/ai/conversations?metadata->call_control_id=eq.<call_control_id>`
  (PostgREST syntax; also `metadata->assistant_id=eq.`, `metadata->telnyx_end_user_target=eq.`,
  `metadata->telnyx_agent_target=eq.`, `metadata->telnyx_conversation_channel=eq.phone_call`,
  `created_at=gte.`, `limit`, `order=created_at.desc`). Returns
  `data[] {id, name, created_at, metadata, last_message_at}`.
- `GET /v2/ai/conversations/{conversation_id}` returns `data {...}` (same fields).
- Transcript: `GET /v2/ai/conversations/{conversation_id}/messages` (`page[size]`, `page[number]`)
  returns `data[] {role: user|assistant|tool, text, tool_calls, created_at, sent_at, metadata}`
  and `meta`. Sort by `sent_at`; the API notes `created_at` is not necessarily send time.
- Insights/summary: `GET /v2/ai/conversations/{conversation_id}/conversations-insights` returns
  `data[] {id, status: pending|in_progress|completed|failed, created_at,
  conversation_insights[] {insight_id, result}}`. `result` is a string (stringified JSON if the
  insight has a schema).
- **A summary only exists if the assistant has an Insight Group with a summary insight.** Create with
  `POST /v2/ai/conversations/insights {name, instructions, json_schema?, webhook?}` and
  `POST /v2/ai/conversations/insight-groups {name, description?, webhook?}`, link with
  `POST /v2/ai/conversations/insight-groups/{group_id}/insights/{insight_id}/assign`, then set
  `insight_settings.insight_group_id`. Telnyx also has "Telnyx-managed" default quality insights.
  Whether those include a summary is **UNCONFIRMED**.
- `privacy_settings.data_retention=false` means no history or insights are stored.

## 9. Voices and cloning

### List TTS voices: `GET /v2/text-to-speech/voices`
Doc: https://developers.telnyx.com/api-reference/text-to-speech-commands/list-available-voices
- Query: `provider` (`aws|telnyx|azure|elevenlabs|minimax|resemble|xai|humain|soniox`), `api_key`
  (needed for ElevenLabs).
- Response is **not** wrapped in `data`: `{ "voices": [ {provider, name, voice_id, language, gender, hosted} ] }`.
- How to build the `voice_settings.voice` string from these fields (e.g. `Telnyx.<model>.<voice_id>`)
  is not specified in the endpoint schema. Exact mapping per provider is **UNCONFIRMED**.

### Clone from audio: `POST /v2/voice_clones/from_upload` (multipart/form-data)
Docs: https://developers.telnyx.com/api-reference/voice-clones/create-a-voice-clone-from-an-audio-file-upload ,
https://developers.telnyx.com/docs/voice/voice-design-lab/clone-voice/parameters ,
https://developers.telnyx.com/docs/voice/voice-design-lab/using-custom-voices
- Fields: `audio_file` (required; WAV/MP3/FLAC/OGG/M4A), `name` (req), `language` (req, ISO 639-1),
  `gender` (req, `male|female|neutral`), `provider` (req, `telnyx` or `minimax`), `model_id`
  (`Qwen3TTS` default for telnyx | `Ultra` | `speech-2.8-turbo` for minimax), `ref_text`
  (optional transcript, improves quality), `label`.
- Limits: Qwen3TTS 3–15 s (auto-trimmed to 10 s), 5 MB, sync **201**. Ultra up to 60 s, 5 MB,
  **async 202** (`status: pending`). Minimax 10 s–5 min, 20 MB, sync 201.
- **No consent fields exist** in the API spec or the clone docs. Consent capture is our responsibility.
- Response `data`: `id` (uuid), `record_type` (`voice_clone`), `name`, `language`, `gender`, `label`,
  `provider`, `provider_supported_models[]`, `provider_voice_id`, `model_id`, `status`
  (`active|pending|failed|expired`; "expired if not kept alive"), `source_voice_design_id`,
  `source_voice_design_version`, `created_at`, `updated_at`.
- Polling Ultra: the docs say `GET /v2/voice_clones/{id}`, but **the OpenAPI spec only defines
  PATCH and DELETE on `/voice_clones/{id}`**. If GET fails, fall back to `GET /v2/voice_clones`
  (`filter[name]`, `filter[provider]`, `page[...]`, `sort`).
- **Voice id for assistants:** `{Provider}.{Model}.{provider_voice_id}`, e.g.
  `Telnyx.Qwen3TTS.<clone uuid>` (for Qwen3TTS `provider_voice_id` = clone `id`),
  `Minimax.speech-2.8-turbo.<minimax id>`. Ultra uses a Cartesia-assigned `provider_voice_id`
  (presumably `Telnyx.Ultra.<provider_voice_id>`, **UNCONFIRMED**).
- Other: `POST /v2/voice_clones` (from a design: `name`, `voice_design_id`, `language`, `gender`,
  `provider`), `PATCH|DELETE /v2/voice_clones/{id}`, `GET /v2/voice_clones/{id}/sample`.
  Design flow: `POST /v2/voice_designs` (text prompt), then `POST /v2/voice_clones`. Designs are not
  usable for TTS directly.
- What keeps a clone "alive" and when it expires is not documented: **UNCONFIRMED**.

## 10. Recordings

Docs: https://developers.telnyx.com/api-reference/call-recordings/retrieve-a-call-recording ,
.../delete-a-call-recording , .../list-all-call-recordings
- `GET /v2/recordings/{recording_id}` returns `data`: `id`, `record_type` (`recording`),
  `call_control_id`, `call_leg_id`, `call_session_id`, `connection_id`, `conference_id`,
  `channels`, `download_urls {mp3, wav}`, `duration_millis`, `recording_started_at`,
  `recording_ended_at`, `source` (`call|conference`), `status` (`completed`), `from`, `to`,
  `initiated_by`, `created_at`, `updated_at`. Expiry of `download_urls` is **UNCONFIRMED**;
  re-fetch before use.
- `GET /v2/recordings?filter[call_leg_id]=...` (also `filter[call_control_id]`,
  `filter[call_session_id]`, `filter[connection_id]`, `filter[from]`, `filter[to]`,
  `filter[created_at]`), `page[...]`.
- `DELETE /v2/recordings/{recording_id}` returns `data`. Bulk: `POST /v2/recordings/actions/delete`.

## 11. Confirmed after review (2026-10-07, OpenAPI spec)

- `call.cost` webhook (sent when the Call Control app has `call_cost_in_webhooks` enabled): payload has
  `call_control_id`, `call_leg_id`, `call_session_id`, `client_state`, `total_cost` (decimal string, e.g.
  `"0.0106"`), `billed_duration_secs`, and `cost_parts[] {call_part, rate, cost, currency, billed_duration_secs}`.
  We store `total_cost` as micro-USD on the call for reconciliation. Whether AI Assistant inference is included
  in `cost_parts` is **UNCONFIRMED**. Check against the Telnyx invoice.
- `DELETE /v2/ai/conversations/{conversation_id}` exists. Retention purge uses it to remove transcripts and insights.
- `GET /v2/text-to-speech/voices?provider=telnyx` (checked against a live account): each entry's `id` is
  already the full assistant voice string (e.g. `Telnyx.KokoroTTS.af_heart`, `Telnyx.Ultra.<uuid>`), along with
  `name`, `language`, `model_id`, `gender`, `label` and an optional `deprecated`. On the live account Mandarin (`zh`)
  exists **only on the Ultra model** (15 voices, 2 deprecated). KokoroTTS has no Mandarin voices, and `NaturalHD.astra`
  does not exist. The app loads the catalog live (English: KokoroTTS; Mandarin: Ultra; deprecated voices excluded)
  instead of using a hard-coded list.
- Local US number search returned `region_information` types `country_code`, `location`, `rate_center` and
  `state`, and `cost_information.monthly_cost` of `"1.00000"` USD for 415 numbers.

## 12. Model choices verified on live calls (2026-10-07)

- **STT:** `deepgram/nova-3` with `language: "auto"` transcribed spoken Mandarin as English words
  ("thirty cents chime"), so Mandarin was effectively not understood. `assemblyai/universal-3-5-pro` with `"auto"`
  correctly transcribed English, Mandarin (`你是谁？`) and mixed sentences (`What message to her. 你好吗？来自Birdie。`).
  One short utterance was detected as Japanese. If that recurs for Mandarin-first agents, try `language: "zh"`.
  Per the transcription-settings doc, AssemblyAI universal-3-5-pro is the only model whose listed languages include `zh`.
- **LLM:** `GET /v2/ai/models` lists 34 models (18 `recommended_for_assistants`), with `pricing` per 1M tokens.
  An empty `model` currently resolves to `moonshotai/Kimi-K2.6`. We pin it explicitly.
- **Bringing other models (not used yet):** assistants accept `llm_api_key_ref` (your own key for a provider),
  `external_llm { base_url, model, llm_api_key_ref, authentication_method, certificate_ref, token_retrieval_url,
  forward_metadata }` (any OpenAI-compatible chat-completions endpoint) and `fallback_config { model | external_llm }`.
  TTS catalog providers include aws, azure, elevenlabs (needs `voice_settings.api_key_ref`), minimax
  (`voice_settings.language_boost`), resemble and xai. STT supports `api_key_ref`/`region` for Azure only. Secrets live in
  Telnyx Integration Secrets (`/v2/integration_secrets`).

## 13. Previews, per-agent models and cloned-voice access (checked live 2026-10-08)

- **TTS preview:** `POST /v2/text-to-speech/speech` `{ text, voice }` (voice = the assistant voice string) returns
  `audio/mpeg` bytes directly. ~0.5 s for a sentence on KokoroTTS and Ultra.
- **Clone sample:** `GET /v2/voice_clones/{id}/sample` returns the uploaded sample as-is (`audio/wav` here).
- **Cloned voices need account verification.** On an unverified account, cloning (`from_upload`, Qwen3TTS) succeeds,
  but using the clone fails: assistants answer 403 `10010` "Your account is not permitted to use cloned voices. Please
  complete L2 verification or use a platform voice", and TTS with `Telnyx.Qwen3TTS.<clone id>` answers 403 `10038`
  "Feature not permitted at this account level". The adapter maps the assistant error to `FeatureNotPermittedError`.
- **Per-agent LLM:** agents may pick any model with `recommended_for_assistants` whose output price is at most
  $15 / 1M tokens (`MAX_OUTPUT_PRICE_PER_M`). Calls are billed at a flat per-minute rate, so pricier models are not
  offered. At this check that excluded only `openai/gpt-5.6-sol`; unpriced entries (`google/gemini-2.5-flash`,
  `openai/gpt-live-1`) are skipped too.
