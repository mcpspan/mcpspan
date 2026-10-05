-- Up Migration

-- Whether a call's arguments were the previous call's to the same tool in the
-- same session (SDK contract, 3.9): an agent stuck in a loop. The SDK compares
-- them in its own process and sends only the answer, true or nothing, so this
-- is true or null; null also for calls from SDKs that do not compare.
--
-- On the raw tables only, like sizes and versions.
ALTER TABLE tool_calls ADD COLUMN repeated boolean;
ALTER TABLE resource_calls ADD COLUMN repeated boolean;
ALTER TABLE prompt_calls ADD COLUMN repeated boolean;

-- Down Migration

ALTER TABLE tool_calls DROP COLUMN repeated;
ALTER TABLE resource_calls DROP COLUMN repeated;
ALTER TABLE prompt_calls DROP COLUMN repeated;
