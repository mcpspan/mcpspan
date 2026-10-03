package com.mcpspan.internal;

import java.util.List;

/** Delivers one batch. Internal: not part of the package's API. */
@FunctionalInterface
public interface Sender {

    /** Sends the batch, or throws what went wrong. */
    void send(List<ToolCallEvent> events) throws TransportException;
}
