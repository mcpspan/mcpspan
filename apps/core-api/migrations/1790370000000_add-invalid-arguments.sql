-- Up Migration

-- Which top-level arguments of a refused call did not match the tool's input
-- schema (SDK contract, 3.10), by the names the schema declares: never a
-- value, never a name the client made up. Null when the call was not refused
-- for its arguments, when the SDK found none, or when it is older than 0.5.0.
--
-- On the raw tables only, like sizes and versions. Resource reads and prompt
-- gets never carry it; the column is on their tables too so that one insert
-- serves every kind.
ALTER TABLE tool_calls ADD COLUMN invalid_arguments text[];
ALTER TABLE resource_calls ADD COLUMN invalid_arguments text[];
ALTER TABLE prompt_calls ADD COLUMN invalid_arguments text[];

-- Down Migration

ALTER TABLE tool_calls DROP COLUMN invalid_arguments;
ALTER TABLE resource_calls DROP COLUMN invalid_arguments;
ALTER TABLE prompt_calls DROP COLUMN invalid_arguments;
