-- Up Migration

-- Tokens that read what an account can see, without a browser: what an MCP
-- server, a script or a notebook holds to ask about the account's servers.
--
-- Separate from api_keys on purpose. A key belongs to a server and writes its
-- events; a token belongs to a person and reads. One table for both would
-- let a key from a server's environment open the dashboard's data.
CREATE TABLE read_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Hash of the token, never the token, as for sessions: it is 32 random
  -- bytes made here, so a plain SHA-256 is enough to keep a leaked copy of
  -- this table from being a set of working tokens.
  token_hash bytea NOT NULL UNIQUE,

  -- Whose view the token reads: the servers that user reaches, as the
  -- dashboard shows them, so it follows them as they change.
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,

  -- Given by the person who made it, to tell their tokens apart.
  name text NOT NULL,

  created_at timestamptz NOT NULL DEFAULT now(),

  -- To within a minute: so a token nobody uses any more can be spotted and
  -- revoked, without a write on every request.
  last_used_at timestamptz
);

CREATE INDEX read_tokens_user_idx ON read_tokens (user_id, created_at);

-- Down Migration

DROP TABLE read_tokens;
