-- Up Migration

-- When each version of each client was first and last seen on a server, kept
-- up to date as calls arrive, like server_versions. A client updates itself,
-- without the server's author knowing; this is what says a version is new to
-- the server, and it outlives raw retention, so a version first seen long ago
-- is still known as old.
--
-- By the name the client gives itself, not its type: one type can hold
-- several clients, each numbering its versions its own way, and a type can
-- change when the rules that give it do.
CREATE TABLE client_versions (
  server_id uuid NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
  client_name text NOT NULL,
  version text NOT NULL,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  PRIMARY KEY (server_id, client_name, version)
);

-- What the raw tables still hold, so the versions already running are known
-- from the start rather than all looking new.
INSERT INTO client_versions (server_id, client_name, version, first_seen_at, last_seen_at)
SELECT server_id, client_name, client_version, min(first_seen_at), max(last_seen_at)
FROM (
  SELECT server_id, client_name, client_version, min(occurred_at) AS first_seen_at, max(occurred_at) AS last_seen_at
  FROM tool_calls
  WHERE coalesce(client_name, '') <> '' AND coalesce(client_version, '') <> ''
  GROUP BY 1, 2, 3
  UNION ALL
  SELECT server_id, client_name, client_version, min(occurred_at), max(occurred_at)
  FROM resource_calls
  WHERE coalesce(client_name, '') <> '' AND coalesce(client_version, '') <> ''
  GROUP BY 1, 2, 3
  UNION ALL
  SELECT server_id, client_name, client_version, min(occurred_at), max(occurred_at)
  FROM prompt_calls
  WHERE coalesce(client_name, '') <> '' AND coalesce(client_version, '') <> ''
  GROUP BY 1, 2, 3
) AS seen
GROUP BY 1, 2, 3;

-- Down Migration

DROP TABLE client_versions;
