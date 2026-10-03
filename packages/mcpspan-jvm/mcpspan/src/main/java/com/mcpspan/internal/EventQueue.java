package com.mcpspan.internal;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;

/**
 * Events waiting to be sent, oldest first, bounded: an unreachable endpoint can never grow it until the host runs
 * out of memory. Not thread-safe on its own; the reporter guards it.
 */
final class EventQueue {

    private final int maxSize;
    private final ArrayDeque<ToolCallEvent> events = new ArrayDeque<>();
    private int dropped;

    EventQueue(int maxSize) {
        this.maxSize = maxSize;
    }

    int size() {
        return events.size();
    }

    int dropped() {
        return dropped;
    }

    /** Queues an event, dropping the oldest when full: what the server does now matters more. */
    void add(ToolCallEvent event) {
        if (events.size() >= maxSize) {
            events.pollFirst();
            dropped++;
        }
        events.addLast(event);
    }

    List<ToolCallEvent> drain(int limit) {
        List<ToolCallEvent> batch = new ArrayList<>(Math.min(limit, events.size()));
        while (batch.size() < limit && !events.isEmpty()) {
            batch.add(events.pollFirst());
        }
        return batch;
    }

    /** Puts a batch that failed back in front. If that overflows, the oldest go as usual. */
    void restore(List<ToolCallEvent> batch) {
        for (int i = batch.size() - 1; i >= 0; i--) {
            events.addFirst(batch.get(i));
        }
        while (events.size() > maxSize) {
            events.pollFirst();
            dropped++;
        }
    }

    void clear() {
        events.clear();
    }
}
