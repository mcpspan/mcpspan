-- Up Migration

-- Things an installation knows about itself.
--
-- Deliberately a key and a value rather than a column per fact. What belongs
-- here is small, occasional and not queried in anger: the first entry is a
-- fingerprint of the signing secret, and the diagnostics view will want a
-- couple more. A table per fact would be three tables of one row.
CREATE TABLE settings (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Down Migration

DROP TABLE settings;
