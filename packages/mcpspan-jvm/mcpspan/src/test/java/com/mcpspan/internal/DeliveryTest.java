package com.mcpspan.internal;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.time.Duration;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.function.BooleanSupplier;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

class DeliveryTest {

    static ToolCallEvent event(int id) {
        return new ToolCallEvent(String.valueOf(id), null, "t", 0, true, null, null, null, "unknown", null, null, null, null, null, null, "", "", null, null);
    }

    /** Records each batch and answers from a script, then with success. */
    static final class Script implements Sender {
        final List<long[]> times = new ArrayList<>();
        final List<List<String>> batches = new ArrayList<>();
        private final List<TransportException> answers;

        Script(TransportException... answers) {
            this.answers = new ArrayList<>(java.util.Arrays.asList(answers));
        }

        @Override
        public synchronized void send(List<ToolCallEvent> events) throws TransportException {
            batches.add(events.stream().map(ToolCallEvent::id).toList());
            times.add(new long[] {System.nanoTime(), events.size()});
            if (!answers.isEmpty()) {
                TransportException answer = answers.remove(0);
                if (answer != null) {
                    throw answer;
                }
            }
        }

        synchronized List<List<String>> withEvents() {
            return batches.stream().filter(b -> !b.isEmpty()).toList();
        }

        synchronized int count() {
            return batches.size();
        }
    }

    static Reporter reporter(Script script, Duration interval, int batch, int queue, boolean debug,
                             java.util.function.Consumer<String> notes) {
        return new Reporter("https://ingest.example", script, interval, batch, queue, debug, notes);
    }

    static Reporter reporter(Script script) {
        return reporter(script, Duration.ofMillis(20), 100, 10_000, false, null);
    }

    static void eventually(BooleanSupplier condition) throws InterruptedException {
        long deadline = System.nanoTime() + Duration.ofSeconds(5).toNanos();
        while (!condition.getAsBoolean()) {
            assertTrue(System.nanoTime() < deadline, "timed out");
            Thread.sleep(5);
        }
    }

    static final Duration STOP = Duration.ofSeconds(5);

    @Test
    void writesTheEventAsJsonLeavingAbsentFieldsOut() {
        ToolCallEvent event = new ToolCallEvent("1", null, "say \"hi\"\n", 1.5, false, "result", null, "m", "claude",
            "Claude", "2.3.4", "1.0.0", 48213L, null, null, "2026-01-01T00:00:00.000Z", "0.1.0", null, Map.of("a", "string"));

        String json = Transport.body(List.of(event));

        assertEquals("{\"events\":[{\"id\":\"1\",\"toolName\":\"say \\\"hi\\\"\\n\",\"durationMs\":1.5,"
            + "\"success\":false,\"errorSource\":\"result\",\"errorMessage\":\"m\",\"clientType\":\"claude\","
            + "\"clientName\":\"Claude\",\"clientVersion\":\"2.3.4\",\"serverVersion\":\"1.0.0\",\"responseBytes\":48213,\"timestamp\":\"2026-01-01T00:00:00.000Z\",\"sdkVersion\":\"0.1.0\","
            + "\"parameters\":{\"a\":\"string\"}}]}", json);
        assertEquals("{\"events\":[]}", Transport.body(List.of()));
    }

    @Test
    void readsRetryAfterInBothFormsAndCapsIt() {
        ZonedDateTime now = ZonedDateTime.parse("2026-01-01T00:00:00Z");
        assertEquals(Duration.ofSeconds(12), Transport.retryAfter(Optional.of("12"), now));
        assertEquals(Duration.ofSeconds(30), Transport.retryAfter(Optional.of("Thu, 01 Jan 2026 00:00:30 GMT"), now));
        assertEquals(Transport.MAX_RETRY_AFTER, Transport.retryAfter(Optional.of("99999"), now));
        assertEquals(Duration.ZERO, Transport.retryAfter(Optional.empty(), now));
        assertEquals(Duration.ZERO, Transport.retryAfter(Optional.of("soon"), now));
    }

    @Test
    void backoffDoublesToACeilingWithinTheSpread() {
        assertEquals(Duration.ofMillis(500), Reporter.backoff(1, () -> 0));
        assertEquals(Duration.ofSeconds(1), Reporter.backoff(1, () -> 1));
        assertEquals(Duration.ofSeconds(4), Reporter.backoff(3, () -> 1));
        assertEquals(Duration.ofMinutes(1), Reporter.backoff(30, () -> 1));
    }

    @Test
    void announcesOnceWithAnEmptyBatch() throws InterruptedException {
        Script script = new Script();
        Reporter reporter = reporter(script);
        reporter.start();

        eventually(() -> script.count() == 1);
        Thread.sleep(100);
        reporter.stop(STOP);

        assertEquals(List.of(List.of()), script.batches);
    }

    @Test
    void deliversOnTheIntervalWithoutBlockingTheCaller() throws InterruptedException {
        Script script = new Script();
        Reporter reporter = reporter(script);
        reporter.start();

        long started = System.nanoTime();
        reporter.record(event(1));
        assertTrue(System.nanoTime() - started < Duration.ofMillis(5).toNanos());

        eventually(() -> script.withEvents().equals(List.of(List.of("1"))));
        reporter.stop(STOP);
    }

    @Test
    void aFullBatchGoesAtOnce() throws InterruptedException {
        Script script = new Script();
        Reporter reporter = reporter(script, Duration.ofHours(1), 2, 10_000, false, null);
        reporter.start();

        reporter.record(event(1));
        reporter.record(event(2));

        eventually(() -> script.withEvents().equals(List.of(List.of("1", "2"))));
        reporter.stop(STOP);
    }

    @ParameterizedTest
    @ValueSource(ints = {401, 403})
    void aRefusedKeyStopsForGoodAndSaysSoUnasked(int status) throws InterruptedException {
        ConcurrentLinkedQueue<String> notes = new ConcurrentLinkedQueue<>();
        Script script = new Script(new TransportException("no", status, false, Duration.ZERO));
        Reporter reporter = reporter(script, Duration.ofMillis(20), 100, 10_000, false, notes::add);
        reporter.start();
        // Until the refusal is handled, not only sent.
        eventually(() -> !notes.isEmpty());

        reporter.record(event(1));
        reporter.stop(STOP);

        assertEquals(1, script.count());
        assertEquals(1, notes.size());
        assertTrue(notes.peek().contains("HTTP " + status));
    }

    @Test
    void keepsABatchThroughAPassingFailureAndWaitsAsAsked() throws InterruptedException {
        Script script = new Script(null, new TransportException("busy", 429, true, Duration.ofMillis(1500)));
        Reporter reporter = reporter(script);
        reporter.start();

        reporter.record(event(1));
        eventually(() -> script.withEvents().size() == 2);
        reporter.stop(STOP);

        List<long[]> withEvents = script.times.stream().filter(t -> t[1] > 0).toList();
        assertTrue(withEvents.get(1)[0] - withEvents.get(0)[0] >= Duration.ofMillis(1450).toNanos());
        assertEquals(script.withEvents().get(0), script.withEvents().get(1));
    }

    @Test
    void dropsAMalformedBatchAndKeepsCollecting() throws InterruptedException {
        Script script = new Script(null, new TransportException("bad", 400, false, Duration.ZERO));
        Reporter reporter = reporter(script);
        reporter.start();

        reporter.record(event(1));
        eventually(() -> script.withEvents().size() == 1);
        Thread.sleep(1100);
        reporter.record(event(2));
        eventually(() -> script.withEvents().size() == 2);
        reporter.stop(STOP);

        assertEquals(List.of("2"), script.withEvents().get(1));
    }

    @Test
    void stopDeliversWhatIsQueuedDespiteADelay() throws InterruptedException {
        Script script = new Script(null, new TransportException("down", 500, true, Duration.ZERO));
        Reporter reporter = reporter(script, Duration.ofHours(1), 1, 10_000, false, null);
        reporter.start();

        reporter.record(event(1));
        eventually(() -> script.withEvents().size() == 1);
        reporter.record(event(2));
        reporter.stop(STOP);

        assertEquals(List.of(List.of("1"), List.of("1"), List.of("2")), script.withEvents());
    }

    @Test
    void reportsDiscardedEventsOnlyWhenAsked() {
        List<String> notes = new ArrayList<>();
        Script script = new Script();
        Reporter reporter = reporter(script, Duration.ofHours(1), 100, 2, true, notes::add);

        for (int i = 0; i < 5; i++) {
            reporter.record(event(i));
        }
        reporter.stop(STOP);

        assertEquals(List.of(List.of("3", "4")), script.withEvents());
        assertTrue(notes.get(0).contains("discarded 3 events"));
    }
}
