package com.mcpspan.internal;

import java.time.Duration;

/** A delivery that did not succeed, and whether sending the same batch again could work. Internal. */
public final class TransportException extends Exception {

    private static final long serialVersionUID = 1L;

    private final int status;
    private final boolean retryable;
    private final transient Duration retryAfter;

    /** A failure: the status (-1 for none), whether a retry could work, and any wait the API asked for. */
    public TransportException(String message, int status, boolean retryable, Duration retryAfter) {
        super(message);
        this.status = status;
        this.retryable = retryable;
        this.retryAfter = retryAfter;
    }

    int status() { return status; }

    boolean retryable() { return retryable; }

    Duration retryAfter() { return retryAfter; }
}
