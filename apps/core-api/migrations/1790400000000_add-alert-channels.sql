-- Up Migration

-- Where each rule's alerts go: the account's webhook, its email address, or
-- both. Email is offered only by an installation that can send mail (an
-- AlertMailer given to createApp); a self-hosted one has none, so its rules
-- stay on the webhook, as they were.
ALTER TABLE alert_rules
  ADD COLUMN notify_webhook boolean NOT NULL DEFAULT true,
  ADD COLUMN notify_email boolean NOT NULL DEFAULT false;

-- Which channels each change of state is owed to, as the rule said when it
-- happened, and how the email went. A channel switched on later does not
-- send what happened before it was: news of an incident from last week is
-- not news. delivered_at, attempts and last_error stay the webhook's.
ALTER TABLE alert_events
  ADD COLUMN webhook_wanted boolean NOT NULL DEFAULT true,
  ADD COLUMN email_wanted boolean NOT NULL DEFAULT false,
  ADD COLUMN email_delivered_at timestamptz,
  ADD COLUMN email_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN email_error text;

CREATE INDEX alert_events_email_pending_idx ON alert_events (occurred_at)
  WHERE email_wanted AND email_delivered_at IS NULL;

-- Down Migration

DROP INDEX alert_events_email_pending_idx;
ALTER TABLE alert_events
  DROP COLUMN email_error,
  DROP COLUMN email_attempts,
  DROP COLUMN email_delivered_at,
  DROP COLUMN email_wanted,
  DROP COLUMN webhook_wanted;
ALTER TABLE alert_rules DROP COLUMN notify_email, DROP COLUMN notify_webhook;
