package com.mcpspan.internal;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.mcpspan.McpSpan;
import com.mcpspan.McpSpanOptions;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

class CollectorTest {

    @AfterEach
    void reset() {
        McpSpan.shutdown();
        Collector.useSender(null);
    }

    @Test
    void doesNothingAtAllWithoutAKey() {
        McpSpan.configure(McpSpanOptions.defaults());
        assertFalse(McpSpan.isCollecting());
    }

    @Test
    void withAKeyAndNoEndpointCollectsNothingAndSaysSoOnce() {
        // The environment cannot be changed from here; the check needs it without an endpoint.
        Assumptions.assumeTrue(System.getenv("MCPSPAN_ENDPOINT") == null);
        Collector.forgetNoEndpointNotice();
        List<String> said = new ArrayList<>();
        McpSpanOptions options = McpSpanOptions.builder().apiKey("k").onDiagnostic(said::add).build();

        McpSpan.configure(options);
        McpSpan.configure(options);

        assertFalse(McpSpan.isCollecting());
        assertEquals(List.of(Collector.NO_ENDPOINT), said);
    }

    @Test
    void theSameSettingsAgainChangeNothingAndDifferentOnesReplaceThem() throws InterruptedException {
        AtomicInteger announcements = new AtomicInteger();
        Collector.useSender(events -> {
            if (events.isEmpty()) {
                announcements.incrementAndGet();
            }
        });

        McpSpan.configure(McpSpanOptions.builder().apiKey("k").build());
        McpSpan.configure(McpSpanOptions.builder().apiKey("k").build());
        DeliveryTest.eventually(() -> announcements.get() >= 1);
        Thread.sleep(200);
        assertEquals(1, announcements.get());

        McpSpan.configure(McpSpanOptions.builder().apiKey("other").build());
        DeliveryTest.eventually(() -> announcements.get() == 2);
    }

    @Test
    void aMalformedSettingFallsBackAndNeverThrows() {
        Collector.useSender(events -> { });
        McpSpan.configure(McpSpanOptions.builder().apiKey("k").flushInterval(Duration.ofSeconds(-1))
            .maxBatchSize(0).debug(true).onDiagnostic(note -> { }).build());

        assertTrue(McpSpan.isCollecting());
    }
}
