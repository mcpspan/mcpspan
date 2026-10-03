package com.mcpspan.internal;

import com.mcpspan.McpSpanOptions;
import java.time.Duration;
import java.util.Objects;
import java.util.function.Consumer;

/** The running configuration, shared by everything that records a call. Internal: not part of the package's API. */
public final class Collector {

    /**
     * Said when there is a key and nowhere to send: somebody meant to collect. There is no default endpoint, since
     * mcpspan runs wherever its user runs it, and a default would send their data somewhere they did not choose.
     */
    public static final String NO_ENDPOINT = "mcpspan: an API key is set but no endpoint, so nothing is collected. "
        + "Set MCPSPAN_ENDPOINT (or the endpoint option) to your mcpspan installation, for example "
        + "http://localhost:6271.";

    private static final Object LOCK = new Object();
    private static volatile Reporter reporter;
    private static Settings active;
    private static volatile boolean captureParameterNames;
    private static volatile String serverVersion;
    private static boolean exitHookInstalled;
    private static boolean saidNoEndpoint;

    /** For tests: delivery goes here instead of over HTTP. */
    static volatile Sender senderOverride;

    private record Settings(String apiKey, String endpoint, boolean debug, Consumer<String> onDiagnostic,
                            boolean flushOnExit, Duration flushInterval, int maxBatchSize, int maxQueueSize,
                            boolean captureParameterNames, String serverVersion) {

        @Override
        public boolean equals(Object other) {
            return other instanceof Settings o && debug == o.debug && flushOnExit == o.flushOnExit
                && captureParameterNames == o.captureParameterNames && maxBatchSize == o.maxBatchSize
                && maxQueueSize == o.maxQueueSize && Objects.equals(apiKey, o.apiKey)
                && Objects.equals(endpoint, o.endpoint) && onDiagnostic == o.onDiagnostic
                && flushInterval.equals(o.flushInterval) && Objects.equals(serverVersion, o.serverVersion);
        }

        @Override
        public int hashCode() {
            return Objects.hash(apiKey, endpoint, flushInterval, maxBatchSize, maxQueueSize);
        }
    }

    private Collector() {
    }

    /** Whether a key is configured and calls are being recorded. */
    public static boolean collecting() {
        return reporter != null;
    }

    /** Whether parameter names and types are recorded. */
    public static boolean captureParameterNames() {
        return captureParameterNames;
    }

    /** The version every call is recorded under when one was set, whatever the server gives itself; else null. */
    public static String serverVersion() {
        return serverVersion;
    }

    /** For tests: forgets that the missing endpoint was already mentioned. */
    public static void forgetNoEndpointNotice() {
        synchronized (LOCK) {
            saidNoEndpoint = false;
        }
    }

    /** For tests in other packages of this build: deliver to a function instead of over HTTP. */
    public static void useSender(Sender sender) {
        senderOverride = sender;
    }

    /** Applies settings. Never throws. */
    public static void configure(McpSpanOptions options) {
        try {
            configureCore(options);
        }
        catch (RuntimeException e) {
            if (options.debug()) {
                System.err.println("mcpspan: could not configure (" + e + ")");
            }
        }
    }

    private static void configureCore(McpSpanOptions options) {
        boolean debug = options.debug() || options.onDiagnostic() != null;
        String apiKey = firstNonEmpty(options.apiKey(), System.getenv("MCPSPAN_API_KEY"));
        String endpoint = firstNonEmpty(options.endpoint(), System.getenv("MCPSPAN_ENDPOINT"));
        Settings settings = new Settings(
            apiKey,
            endpoint,
            debug,
            options.onDiagnostic(),
            options.flushOnExit(),
            positive(options.flushInterval(), Reporter.DEFAULT_FLUSH_INTERVAL, "flushInterval", debug),
            Math.min(positive(options.maxBatchSize(), Reporter.DEFAULT_MAX_BATCH_SIZE, "maxBatchSize", debug), 1_000),
            positive(options.maxQueueSize(), Reporter.DEFAULT_MAX_QUEUE_SIZE, "maxQueueSize", debug),
            options.captureParameterNames(),
            firstNonEmpty(options.serverVersion(), System.getenv("MCPSPAN_SERVER_VERSION")));

        Reporter previous;
        synchronized (LOCK) {
            if (reporter != null && settings.equals(active)) {
                return;
            }
            previous = reporter;
            reporter = null;
            active = null;
            captureParameterNames = false;
            serverVersion = null;
        }
        if (previous != null) {
            previous.stop(Duration.ofSeconds(11));
        }

        // No key is a normal state, in development and CI, and not reported.
        if (settings.apiKey() == null) {
            return;
        }

        // Said unasked, as a refused key is: without it the data goes nowhere and nothing tells anyone. A test's own
        // delivery stands in for the endpoint.
        if (settings.endpoint() == null && senderOverride == null) {
            boolean say;
            synchronized (LOCK) {
                say = !saidNoEndpoint;
                saidNoEndpoint = true;
            }
            if (say) {
                if (settings.onDiagnostic() != null) {
                    settings.onDiagnostic().accept(NO_ENDPOINT);
                }
                else {
                    System.err.println(NO_ENDPOINT);
                }
            }
            return;
        }

        String target = settings.endpoint() != null ? settings.endpoint() : "http://sender.test";
        Sender sender = senderOverride != null ? senderOverride : new Transport(target, settings.apiKey());
        Reporter next = new Reporter(target, sender, settings.flushInterval(), settings.maxBatchSize(),
            settings.maxQueueSize(), settings.debug(), settings.onDiagnostic());

        synchronized (LOCK) {
            reporter = next;
            active = settings;
            captureParameterNames = settings.captureParameterNames();
            serverVersion = settings.serverVersion();
            if (settings.flushOnExit() && !exitHookInstalled) {
                // Runs as the JVM shuts down. It changes nothing about how or when the JVM exits.
                Runtime.getRuntime().addShutdownHook(new Thread(Collector::onExit, "mcpspan-shutdown"));
                exitHookInstalled = true;
            }
        }

        // In the background: startup does not wait for the network.
        next.start();
    }

    /** Stops collecting and delivers what is queued, waiting at most as long as given. Never throws. */
    public static void shutdown(Duration timeout) {
        try {
            Reporter previous;
            synchronized (LOCK) {
                previous = reporter;
                reporter = null;
                active = null;
                captureParameterNames = false;
                serverVersion = null;
            }
            if (previous != null) {
                previous.stop(timeout);
            }
        }
        catch (RuntimeException ignored) {
            // Shutting down never fails.
        }
    }

    /** Queues an event on the running reporter, if there is one. */
    public static void record(ToolCallEvent event) {
        Reporter current = reporter;
        if (current != null) {
            current.record(event);
        }
    }

    private static void onExit() {
        boolean flush;
        synchronized (LOCK) {
            flush = active != null && active.flushOnExit();
        }
        if (flush) {
            shutdown(Duration.ofSeconds(11));
        }
    }

    private static String firstNonEmpty(String... values) {
        for (String value : values) {
            if (value != null && !value.isBlank()) {
                return value.trim();
            }
        }
        return null;
    }

    private static Duration positive(Duration value, Duration fallback, String name, boolean debug) {
        if (value == null) {
            return fallback;
        }
        if (!value.isNegative() && !value.isZero()) {
            return value;
        }
        note(debug, name, value);
        return fallback;
    }

    private static int positive(Integer value, int fallback, String name, boolean debug) {
        if (value == null) {
            return fallback;
        }
        if (value > 0) {
            return value;
        }
        note(debug, name, value);
        return fallback;
    }

    private static void note(boolean debug, String name, Object value) {
        if (debug) {
            System.err.println("mcpspan: ignoring " + name + "=" + value + ", expected a positive value");
        }
    }
}
