-- Rows written before the interface was translated keep only their English text, so they show in
-- English for everyone. Their wording is exactly the English of a stored.* message today, so match
-- each one back to its message (and values) and they show in the viewer's language. Rows that don't
-- match, such as provider wording, keep falling back to the English text.

-- Ledger descriptions with values.
UPDATE "ledger_entries" SET "description_msg" = jsonb_build_object('key', 'stored.ledgerTopup', 'values', jsonb_build_object('amount', replace((regexp_match("description", '^Top-up \$([0-9,]+\.[0-9]{2})$'))[1], ',', '')::numeric))
WHERE "description_msg" IS NULL AND "description" ~ '^Top-up \$[0-9,]+\.[0-9]{2}$';--> statement-breakpoint
UPDATE "ledger_entries" SET "description_msg" = jsonb_build_object('key', 'stored.ledgerDevCredit', 'values', jsonb_build_object('amount', replace((regexp_match("description", '^Dev credit \$([0-9,]+\.[0-9]{2}) \(no payment\)$'))[1], ',', '')::numeric))
WHERE "description_msg" IS NULL AND "description" ~ '^Dev credit \$[0-9,]+\.[0-9]{2} \(no payment\)$';--> statement-breakpoint
UPDATE "ledger_entries" SET "description_msg" = jsonb_build_object('key', 'stored.ledgerNumberFirstMonth', 'values', jsonb_build_object('number', (regexp_match("description", '^Phone number (\+[0-9]+) — first month$'))[1]))
WHERE "description_msg" IS NULL AND "description" ~ '^Phone number \+[0-9]+ — first month$';--> statement-breakpoint
UPDATE "ledger_entries" SET "description_msg" = jsonb_build_object('key', 'stored.ledgerNumberMonthly', 'values', jsonb_build_object('number', (regexp_match("description", '^Phone number (\+[0-9]+) — monthly rental$'))[1]))
WHERE "description_msg" IS NULL AND "description" ~ '^Phone number \+[0-9]+ — monthly rental$';--> statement-breakpoint
UPDATE "ledger_entries" SET "description_msg" = jsonb_build_object('key', 'stored.ledgerNumberRefund', 'values', jsonb_build_object('number', (regexp_match("description", '^Refund — number (\+[0-9]+) could not be activated$'))[1]))
WHERE "description_msg" IS NULL AND "description" ~ '^Refund — number \+[0-9]+ could not be activated$';--> statement-breakpoint
UPDATE "ledger_entries" SET "description_msg" = jsonb_build_object('key', 'stored.ledgerVoiceClone', 'values', jsonb_build_object('name', (regexp_match("description", '^Voice clone "(.*)"$'))[1]))
WHERE "description_msg" IS NULL AND "description" ~ '^Voice clone ".*"$';--> statement-breakpoint
UPDATE "ledger_entries" SET "description_msg" = jsonb_build_object('key', 'stored.ledgerVoiceCloneRefund', 'values', jsonb_build_object('name', (regexp_match("description", '^Refund — voice clone "(.*)" failed$'))[1]))
WHERE "description_msg" IS NULL AND "description" ~ '^Refund — voice clone ".*" failed$';--> statement-breakpoint
UPDATE "ledger_entries" SET "description_msg" = jsonb_build_object(
  'key', CASE WHEN "description" LIKE 'Inbound %' THEN 'stored.ledgerCallInbound' ELSE 'stored.ledgerCallOutbound' END,
  'values', jsonb_build_object('minutes', (regexp_match("description", '^(?:Inbound|Outbound) call, ([0-9]+) min$'))[1]::int))
WHERE "description_msg" IS NULL AND "description" ~ '^(Inbound|Outbound) call, [0-9]+ min$';--> statement-breakpoint
UPDATE "ledger_entries" SET "description_msg" = jsonb_build_object('key', 'stored.ledgerSms', 'values', jsonb_build_object(
  'from', (regexp_match("description", '^Text from (.+) \(([0-9]+) segments?\)$'))[1],
  'parts', (regexp_match("description", '^Text from (.+) \(([0-9]+) segments?\)$'))[2]::int))
WHERE "description_msg" IS NULL AND "description" ~ '^Text from .+ \([0-9]+ segments?\)$';--> statement-breakpoint

-- Call outcomes: fixed sentences, plus the hangup cause.
UPDATE "calls" SET "outcome_msg" = jsonb_build_object('key', v.key)
FROM (VALUES
  ('Rejected: account balance is empty. Top up to receive calls.', 'stored.outcomeBalanceEmpty'),
  ('Rejected: no agent is assigned to this number.', 'stored.outcomeNoAgent'),
  ('Rejected: the assigned agent is not ready.', 'stored.outcomeAgentNotReady'),
  ('Rejected: ElevenLabs rejected your API key, so the agent''s voice couldn''t speak. Replace it under Account → API keys.', 'stored.outcomeKeyRejected'),
  ('Rejected: another call was already in progress.', 'stored.outcomeBusy'),
  ('Agent was unavailable; call ended. You were not charged.', 'stored.outcomeAgentUnavailable'),
  ('The agent failed to start; call ended. You were not charged.', 'stored.outcomeAgentFailed'),
  ('No answer.', 'stored.outcomeNoAnswer'),
  ('The line was busy.', 'stored.outcomeLineBusy'),
  ('The call was declined.', 'stored.outcomeDeclined'),
  ('The caller hung up before it was answered.', 'stored.outcomeCallerHungUp'),
  ('That number couldn''t be reached.', 'stored.outcomeUnreachable'),
  ('The call could not be placed.', 'stored.outcomeNotPlaced')
) AS v(text, key)
WHERE "calls"."outcome_msg" IS NULL AND "calls"."outcome" = v.text;--> statement-breakpoint
UPDATE "calls" SET "outcome_msg" = jsonb_build_object('key', 'stored.outcomeEndedEarly', 'values', jsonb_build_object('cause', (regexp_match("outcome", '^Call ended before connecting \((.+)\)\.$'))[1]))
WHERE "outcome_msg" IS NULL AND "outcome" ~ '^Call ended before connecting \(.+\)\.$';
