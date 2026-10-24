-- Up Migration

-- The address of a server's public badge, while its owner has one switched
-- on: random, so it says nothing about the server's id and no other badge can
-- be guessed from it. Null, as for every server until then, means there is
-- no badge, and whatever is asked under any address is answered with "no data".
ALTER TABLE servers ADD COLUMN badge_id text UNIQUE;

-- Down Migration

ALTER TABLE servers DROP COLUMN badge_id;
