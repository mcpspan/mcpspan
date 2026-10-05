-- Up Migration

-- How large each answer was, in bytes of its compact JSON (SDK contract, 3.7).
-- Optional: SDKs from before it was measured send none, and calls that ended
-- without an answer (an exception, a refusal) have none.
--
-- On the raw tables only, like the versions: sizes are a question about a
-- window of raw calls (the median and the largest answer of a tool), which the
-- raw rows answer for as long as they are kept.
ALTER TABLE tool_calls ADD COLUMN response_bytes integer;
ALTER TABLE resource_calls ADD COLUMN response_bytes integer;
ALTER TABLE prompt_calls ADD COLUMN response_bytes integer;

-- Down Migration

ALTER TABLE tool_calls DROP COLUMN response_bytes;
ALTER TABLE resource_calls DROP COLUMN response_bytes;
ALTER TABLE prompt_calls DROP COLUMN response_bytes;
