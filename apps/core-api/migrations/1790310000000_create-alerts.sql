-- Up Migration

-- Where an account's alerts are sent. One per account: a self-hosted install
-- has one person to tell, and a webhook can fan out to as many places as they
-- like from there.
CREATE TABLE alert_webhooks (
  user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,

  url text NOT NULL,

  -- The outcome of the last attempt, so the settings page can say whether the
  -- address works before an incident is what finds out.
  last_attempt_at timestamptz,
  last_status integer,
  last_error text,

  created_at timestamptz NOT NULL DEFAULT now()
);

-- A condition to watch on a server, or on some of its tools.
CREATE TABLE alert_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  server_id uuid NOT NULL REFERENCES servers (id) ON DELETE CASCADE,

  -- The tools watched, each on its own, or the whole server when absent. By
  -- name rather than by reference, because tools have no table: a tool
  -- exists because calls to it were recorded, and a name renamed away simply
  -- stops matching.
  --
  -- Each tool is judged separately rather than all of them summed, so the
  -- message says which one broke. Summed, a failing tool among healthy ones
  -- would be averaged out of sight - the very thing picking tools is for.
  tool_names text[],

  -- 'error_rate': the share of failed calls over the window reaches the
  -- threshold, given at least min_calls calls.
  -- 'silence': no call at all for the whole window, from a server that has
  -- reported before.
  kind text NOT NULL CHECK (kind IN ('error_rate', 'silence')),

  -- A fraction between 0 and 1 for error_rate. Unused by silence.
  threshold double precision,

  window_minutes integer NOT NULL CHECK (window_minutes BETWEEN 1 AND 10080),

  min_calls integer NOT NULL DEFAULT 1 CHECK (min_calls >= 1),

  enabled boolean NOT NULL DEFAULT true,

  -- Whether the end of an alert is sent as well as its start. Some people
  -- want both; some only want to be woken for the start and will look for
  -- themselves. The end is still recorded either way.
  notify_resolved boolean NOT NULL DEFAULT true,

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX alert_rules_server_idx ON alert_rules (server_id);

-- Whether a rule's condition holds for each thing it watches: each of its
-- tools, or the whole server, written as an empty string.
--
-- Stored, and a notification is sent only when it changes. That is what makes
-- one incident one message: a spike of errors that lasts an hour is a single
-- "firing" and a single "resolved", however many times it was checked in
-- between. No row means "ok", so a rule on a dozen quiet tools costs nothing.
CREATE TABLE alert_states (
  rule_id uuid NOT NULL REFERENCES alert_rules (id) ON DELETE CASCADE,

  target text NOT NULL,

  state text NOT NULL CHECK (state IN ('ok', 'firing')),

  changed_at timestamptz NOT NULL,

  PRIMARY KEY (rule_id, target)
);

-- Every change of state, and whether it reached the webhook.
CREATE TABLE alert_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  rule_id uuid NOT NULL REFERENCES alert_rules (id) ON DELETE CASCADE,

  -- The tool it was about, or an empty string for the whole server.
  target text NOT NULL DEFAULT '',

  kind text NOT NULL CHECK (kind IN ('firing', 'resolved')),

  -- What was measured when the state changed: the error rate, or the minutes
  -- since the last call.
  value double precision,

  occurred_at timestamptz NOT NULL DEFAULT now(),

  -- Delivery. Retried a few times on later checks if the webhook was down;
  -- after that it stays undelivered and the settings page says so.
  delivered_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text
);

CREATE INDEX alert_events_rule_time_idx ON alert_events (rule_id, occurred_at DESC);

CREATE INDEX alert_events_pending_idx ON alert_events (occurred_at)
  WHERE delivered_at IS NULL;

-- Down Migration

DROP TABLE alert_events;
DROP TABLE alert_states;
DROP TABLE alert_rules;
DROP TABLE alert_webhooks;
