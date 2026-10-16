/**
 * Whether a batch from a known server may be stored at all.
 *
 * Asked once per batch, after the key is checked and the events are counted,
 * and before the rate limit. It is a question, not a charge: nothing is
 * counted against anything here, so a batch that is admitted and then slowed
 * down by the rate limit is not paid for twice when the SDK sends it again.
 */
export interface AdmissionRequest {
  serverId: string;
  /** How many events the batch carries. */
  events: number;
}

export type AdmissionVerdict =
  | { allowed: true }
  | {
      allowed: false;
      /** Shown to whoever reads the SDK's diagnostics, so it should say what to do. */
      error: string;
      /**
       * Set when the same batch would be admitted later. The SDK is answered
       * 429 and keeps the batch; without it, 402, and the SDK drops this batch
       * but keeps collecting (contract, 6.4). Never 403: that stops the SDK
       * for the life of its process, which is right for a bad key and wrong
       * for anything a person can fix without restarting their server.
       */
      retryAfterSeconds?: number;
    };

export type Admission = (request: AdmissionRequest) => Promise<AdmissionVerdict>;

/** A self-hosted installation stores everything its own servers send. */
export const admitEverything: Admission = async () => ({ allowed: true });
