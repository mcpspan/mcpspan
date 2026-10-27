-- Up Migration

-- Signing in to mcpspan from an MCP client (claude.ai, ChatGPT, Claude Code,
-- Cursor...) with OAuth, so it reaches /mcp without anybody copying a read
-- token. The client is the app asking; a grant is one person letting one
-- client read, which they see and can end under Settings.

-- Apps that may ask. Either registered here by the app itself (Dynamic Client
-- Registration, RFC 7591), with an id made here, or known by the address of
-- a document the app publishes about itself (Client ID Metadata Documents),
-- whose address is the id and whose contents are kept here for a day.
CREATE TABLE oauth_clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- What the app sends as client_id: made here, or its document's address.
  client_id text NOT NULL UNIQUE,

  -- Only for an app that registered as able to keep a secret. Hashed, as
  -- every credential here is.
  secret_hash bytea,

  -- As the app calls itself, shown on the page that asks the person. Never
  -- trusted on its own: that page shows where the answer goes too.
  name text NOT NULL,
  client_uri text,

  -- Where an answer may be sent, exactly; checked on every request.
  redirect_uris text[] NOT NULL,

  -- Whether the app registered itself here (and may be forgotten when it never
  -- got used), or is a fetched document (and is fetched again after a day).
  registered boolean NOT NULL,
  fetched_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now()
);

-- One person letting one app read what they can see. What Settings lists as a
-- connected app; ending it ends every token made under it.
CREATE TABLE oauth_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES oauth_clients (id) ON DELETE CASCADE,
  scope text NOT NULL,

  -- The MCP server the tokens are for (RFC 8707), when the app named one.
  resource text,

  created_at timestamptz NOT NULL DEFAULT now(),
  -- To within a minute, like read tokens.
  last_used_at timestamptz,
  revoked_at timestamptz
);

CREATE INDEX oauth_grants_user_idx ON oauth_grants (user_id, created_at);

-- The one-time codes the person's browser carries back to the app, which it
-- trades for tokens within minutes. Kept after use, briefly, so a second use
-- (a stolen code) can end the grant the first one made.
CREATE TABLE oauth_codes (
  code_hash bytea PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES oauth_clients (id) ON DELETE CASCADE,
  redirect_uri text NOT NULL,
  -- PKCE (S256), required of every app.
  code_challenge text NOT NULL,
  scope text NOT NULL,
  resource text,
  expires_at timestamptz NOT NULL,
  grant_id uuid REFERENCES oauth_grants (id) ON DELETE CASCADE
);

-- Access tokens (an hour) and refresh tokens (thirty days, swapped for a new
-- one on every use), by hash.
CREATE TABLE oauth_tokens (
  token_hash bytea PRIMARY KEY,
  grant_id uuid NOT NULL REFERENCES oauth_grants (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('access', 'refresh')),
  expires_at timestamptz NOT NULL,
  -- For a refresh token: when it was swapped. Presented again after that, it
  -- was copied, and the grant ends.
  used_at timestamptz
);

CREATE INDEX oauth_tokens_grant_idx ON oauth_tokens (grant_id);
CREATE INDEX oauth_tokens_expiry_idx ON oauth_tokens (expires_at);

-- Down Migration

DROP TABLE oauth_tokens;
DROP TABLE oauth_codes;
DROP TABLE oauth_grants;
DROP TABLE oauth_clients;
