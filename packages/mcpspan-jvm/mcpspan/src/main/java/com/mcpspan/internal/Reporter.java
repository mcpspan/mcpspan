package com.mcpspan.internal;

import java.time.Duration;
import java.util.List;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Consumer;
import java.util.function.DoubleSupplier;

/**
 * Collects events and delivers them from a daemon thread of its own.
 *
 * <p>{@link #record} is the only method a tool call touches, and it only appends to memory under a lock. The
 * thread is a daemon, so it never keeps a JVM running that would otherwise exit. Internal: not part of the
 * package's API.
 */
public final class Reporter {

    static final Duration DEFAULT_FLUSH_INTERVAL = Duration.ofSeconds(5);
    static final int DEFAULT_MAX_BATCH_SIZE = 100;
    static final int DEFAULT_MAX_QUEUE_SIZE = 10_000;

    private static final long INITIAL_RETRY_MS = 1_000;
    private static final long MAX_RETRY_MS = 60_000;

    private final String endpoint;
    private final Sender sender;
    private final Duration flushInterval;
    private final int maxBatchSize;
    private final boolean debug;
    private final Consumer<String> onDiagnostic;

    private final ReentrantLock lock = new ReentrantLock();
    private final Condition wake = lock.newCondition();
    // One delivery at a time, so the same events are never posted twice.
    private final ReentrantLock sending = new ReentrantLock();
    private final EventQueue queue;

    private int reportedDrops;
    private int failures;
    // When the next delivery may be attempted, as System.nanoTime(); only meaningful while waiting is set.
    private long nextAttemptNanos;
    private boolean waiting;
    private boolean woken;
    private volatile boolean rejected;
    private volatile boolean stopped;
    private Thread thread;

    Reporter(String endpoint, Sender sender, Duration flushInterval, int maxBatchSize, int maxQueueSize,
             boolean debug, Consumer<String> onDiagnostic) {
        this.endpoint = endpoint;
        this.sender = sender;
        this.flushInterval = flushInterval;
        this.maxBatchSize = maxBatchSize;
        this.debug = debug;
        this.onDiagnostic = onDiagnostic;
        this.queue = new EventQueue(maxQueueSize);
    }

    /** The wait after the n-th consecutive failure: doubling to a ceiling, spread over its second half. */
    static Duration backoff(int failures, DoubleSupplier random) {
        double ceiling = Math.min(MAX_RETRY_MS, INITIAL_RETRY_MS * Math.pow(2, failures - 1));
        return Duration.ofMillis(Math.round(ceiling / 2 + random.getAsDouble() * ceiling / 2));
    }

    /** Starts delivery, announcing the server first (contract, 3.4). */
    void start() {
        thread = new Thread(this::run, "mcpspan-delivery");
        thread.setDaemon(true);
        thread.start();
    }

    /** Queues an event and returns at once. */
    public void record(ToolCallEvent event) {
        if (stopped || rejected) {
            return;
        }
        lock.lock();
        try {
            queue.add(event);
            if (queue.size() >= maxBatchSize) {
                woken = true;
                wake.signal();
            }
        }
        finally {
            lock.unlock();
        }
    }

    /**
     * Stops delivery and makes a final attempt at what is queued, ignoring any retry delay: this is the last chance
     * these events get. Waits for a delivery already under way rather than posting its events twice.
     */
    void stop(Duration timeout) {
        stopped = true;
        lock.lock();
        try {
            woken = true;
            wake.signal();
        }
        finally {
            lock.unlock();
        }
        deliver(true, timeout);
    }

    private void run() {
        try {
            announce();
            while (!stopped && !rejected) {
                lock.lock();
                try {
                    long remaining = flushInterval.toNanos();
                    while (!woken && !stopped && remaining > 0) {
                        remaining = wake.awaitNanos(remaining);
                    }
                    woken = false;
                }
                finally {
                    lock.unlock();
                }
                if (stopped) {
                    return;
                }
                deliver(false, Duration.ZERO);
            }
        }
        catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        catch (RuntimeException e) {
            // Nothing may escape into the host, not even from a thread of our own.
            log("mcpspan: delivery stopped (" + e + ")");
        }
    }

    private void announce() {
        try {
            sender.send(List.of());
        }
        catch (TransportException e) {
            if (e.status() == 401 || e.status() == 403) {
                reject(e.status());
                return;
            }
            log("mcpspan: could not announce this server to " + endpoint + " (" + e.getMessage() + "). "
                + "Events will still be delivered once it answers.");
        }
        catch (RuntimeException e) {
            log("mcpspan: could not announce this server (" + e + ")");
        }
    }

    private void deliver(boolean force, Duration wait) {
        if (rejected) {
            return;
        }
        lock.lock();
        try {
            if (!force && waiting && System.nanoTime() - nextAttemptNanos < 0) {
                return;
            }
        }
        finally {
            lock.unlock();
        }

        try {
            // The delivery thread waits its turn; a final delivery waits only as long as it was given.
            if (force) {
                if (!sending.tryLock(wait.toMillis(), TimeUnit.MILLISECONDS)) {
                    return;
                }
            }
            else {
                sending.lockInterruptibly();
            }
        }
        catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return;
        }

        try {
            reportDrops();
            while (!rejected) {
                List<ToolCallEvent> batch;
                lock.lock();
                try {
                    batch = queue.drain(maxBatchSize);
                }
                finally {
                    lock.unlock();
                }
                if (batch.isEmpty()) {
                    return;
                }
                try {
                    sender.send(batch);
                }
                catch (TransportException e) {
                    failed(batch, e);
                    return;
                }
                catch (RuntimeException e) {
                    failed(batch, new TransportException(e.toString(), -1, true, Duration.ZERO));
                    return;
                }
                lock.lock();
                try {
                    failures = 0;
                    waiting = false;
                }
                finally {
                    lock.unlock();
                }
            }
        }
        finally {
            sending.unlock();
        }
    }

    private void reportDrops() {
        int dropped;
        lock.lock();
        try {
            dropped = queue.dropped() - reportedDrops;
            reportedDrops = queue.dropped();
        }
        finally {
            lock.unlock();
        }
        if (dropped > 0) {
            log("mcpspan: discarded " + dropped + " events, the queue was full");
        }
    }

    private void failed(List<ToolCallEvent> batch, TransportException e) {
        if (e.status() == 401 || e.status() == 403) {
            reject(e.status());
            return;
        }
        int attempt;
        lock.lock();
        try {
            if (e.retryable()) {
                queue.restore(batch);
            }
            attempt = ++failures;
            // The longer of our own backoff and what the API asked for.
            Duration own = backoff(attempt, ThreadLocalRandom.current()::nextDouble);
            Duration wait = e.retryAfter().compareTo(own) > 0 ? e.retryAfter() : own;
            nextAttemptNanos = System.nanoTime() + wait.toNanos();
            waiting = true;
        }
        finally {
            lock.unlock();
        }
        if (!e.retryable()) {
            // Refused the same way every time: dropped, and collecting goes on.
            log("mcpspan: dropped " + batch.size() + " events, rejected as " + e.status());
        }
        log("mcpspan: delivery failed (" + e.getMessage() + "), attempt " + attempt);
    }

    /**
     * Gives up on a key the endpoint refused, and says so once even with diagnostics off: a silent SDK collecting
     * nothing because of a mistyped key is the worst way to spend an afternoon.
     */
    private void reject(int status) {
        if (rejected) {
            return;
        }
        rejected = true;
        lock.lock();
        try {
            queue.clear();
            woken = true;
            wake.signal();
        }
        finally {
            lock.unlock();
        }
        warn("mcpspan: the ingest endpoint rejected the API key (HTTP " + status + "). "
            + "Telemetry is now disabled for this process.");
    }

    private void log(String message) {
        if (debug) {
            warn(message);
        }
    }

    /**
     * The developer's callback if given, otherwise standard error. Never standard output: on the stdio transport it
     * carries the MCP protocol, and a stray line there breaks the server.
     */
    private void warn(String message) {
        try {
            if (onDiagnostic != null) {
                onDiagnostic.accept(message);
                return;
            }
            System.err.println(message);
        }
        catch (RuntimeException ignored) {
            // Even reporting a problem must not become one.
        }
    }
}
