-- Up Migration

-- Signed-in browsers.
--
-- Kept in the database rather than folded into a signed cookie, so that
-- signing out actually ends a session instead of only forgetting it locally.
-- The alternative leaves a stolen cookie working until it expires, with no way
-- to stop it short of changing a secret and logging everybody out.
CREATE TABLE sessions (
  -- Hash of the token the browser holds, never the token. Same reasoning as
  -- api_keys: a leaked copy of this table should not be a set of usable
  -- sessions, and a lookup by hash is one index probe.
  token_hash bytea PRIMARY KEY,

  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,

  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

-- Signing out everywhere, and clearing a deleted account's sessions.
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- Expired rows are swept rather than left to accumulate; this is what makes
-- that sweep cheap.
CREATE INDEX sessions_expiry_idx ON sessions (expires_at);

-- Down Migration

DROP TABLE sessions;
