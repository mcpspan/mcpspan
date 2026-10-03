/**
 * Most events one request may carry.
 *
 * Ten times what the SDK sends by default, so raising its batch size stays
 * safe. The headroom matters because a refusal here is permanent: the SDK
 * treats "too large" as a verdict on the batch rather than a passing condition
 * and drops it, so a limit set close to the default would turn a bit of tuning
 * into silent data loss.
 */
export const MAX_EVENTS_PER_BATCH = 1_000;

/**
 * Most bytes one request may carry.
 *
 * Enforced while the body is being read, not after. Counting events can only
 * happen once the JSON has been parsed, and by then the memory a hostile
 * sender asked for has already been handed over.
 *
 * Sized to fit the event limit above: a maximal event, with the longest error
 * message and the most parameters the schema allows, comes to roughly 3 kB, so
 * a thousand of them fit inside this with room to spare.
 */
export const MAX_BATCH_BYTES = 4 * 1024 * 1024;
