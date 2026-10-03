package core

import (
	"context"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func testReporter(send sender, options ...func(*reporterOptions)) *reporter {
	o := reporterOptions{
		endpoint:      "http://ingest",
		flushInterval: 20 * time.Millisecond,
		maxBatchSize:  DefaultMaxBatchSize,
		maxQueueSize:  DefaultMaxQueueSize,
		send:          send,
	}
	for _, option := range options {
		option(&o)
	}

	return newReporter(o)
}

func event(i int) Event { return Event{ID: strconv.Itoa(i)} }

func stop(r *reporter) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	r.stop(ctx)
}

func TestBackoffDoublesToACeilingWithinTheSpread(t *testing.T) {
	cases := []struct {
		failures int
		random   float64
		want     time.Duration
	}{
		{1, 0, 500 * time.Millisecond},
		{1, 1, time.Second},
		{3, 1, 4 * time.Second},
		{30, 1, time.Minute},
	}

	for _, c := range cases {
		if got := backoff(c.failures, func() float64 { return c.random }); got != c.want {
			t.Errorf("%d: got %v, want %v", c.failures, got, c.want)
		}
	}
}

func TestAnnouncesOnceWithAnEmptyBatch(t *testing.T) {
	sent := &recorder{}
	r := testReporter(sent.send)
	r.start()

	eventually(t, "the announcement", func() bool { return sent.count() == 1 })
	time.Sleep(100 * time.Millisecond)
	stop(r)

	if sent.count() != 1 || len(sent.batches[0].events) != 0 {
		t.Fatalf("sent %d batches", sent.count())
	}
}

func TestDeliversOnTheIntervalWithoutBlockingTheCaller(t *testing.T) {
	sent := &recorder{}
	r := testReporter(sent.send)
	r.start()

	started := time.Now()
	r.record(event(1))
	if elapsed := time.Since(started); elapsed > 5*time.Millisecond {
		t.Fatalf("record took %v", elapsed)
	}

	eventually(t, "delivery", func() bool { return reflect.DeepEqual(sent.withEvents(), [][]string{{"1"}}) })
	stop(r)
}

func TestAFullBatchGoesAtOnce(t *testing.T) {
	sent := &recorder{}
	r := testReporter(sent.send, func(o *reporterOptions) { o.flushInterval = time.Hour; o.maxBatchSize = 2 })
	r.start()

	r.record(event(1))
	r.record(event(2))

	eventually(t, "the full batch", func() bool { return reflect.DeepEqual(sent.withEvents(), [][]string{{"1", "2"}}) })
	stop(r)
}

func TestARefusedKeyStopsForGoodAndSaysSoUnasked(t *testing.T) {
	for _, status := range []int{401, 403} {
		var notes []string
		var notesMu sync.Mutex
		sent := &recorder{answers: []error{&transportError{message: "no", status: status}}}
		r := testReporter(sent.send, func(o *reporterOptions) {
			o.onDiagnostic = func(message string) { notesMu.Lock(); notes = append(notes, message); notesMu.Unlock() }
		})
		r.start()
		// Until the refusal is handled, not only sent.
		eventually(t, "the refusal", func() bool { notesMu.Lock(); defer notesMu.Unlock(); return len(notes) == 1 })

		r.record(event(1))
		stop(r)

		notesMu.Lock()
		if sent.count() != 1 || len(notes) != 1 || !strings.Contains(notes[0], "HTTP "+strconv.Itoa(status)) {
			t.Errorf("%d: sent %d, notes %v", status, sent.count(), notes)
		}
		notesMu.Unlock()
	}
}

func TestDropsAMalformedBatchAndKeepsCollecting(t *testing.T) {
	sent := &recorder{answers: []error{nil, &transportError{message: "bad", status: 400}}}
	r := testReporter(sent.send)
	r.start()

	r.record(event(1))
	eventually(t, "the refused batch", func() bool { return len(sent.withEvents()) == 1 })
	time.Sleep(1100 * time.Millisecond) // past the backoff that followed
	r.record(event(2))

	eventually(t, "the next batch", func() bool { return reflect.DeepEqual(sent.withEvents(), [][]string{{"1"}, {"2"}}) })
	stop(r)
}

func TestKeepsABatchThroughAPassingFailure(t *testing.T) {
	sent := &recorder{answers: []error{nil, &transportError{message: "down", status: 503, retryable: true}}}
	r := testReporter(sent.send)
	r.start()

	r.record(event(1))
	eventually(t, "the retry", func() bool { return reflect.DeepEqual(sent.withEvents(), [][]string{{"1"}, {"1"}}) })
	stop(r)
}

func TestWaitsAtLeastAsLongAsRetryAfterAsks(t *testing.T) {
	sent := &recorder{answers: []error{nil, &transportError{message: "busy", status: 429, retryable: true, retryAfter: 1500 * time.Millisecond}}}
	r := testReporter(sent.send)
	r.start()

	r.record(event(1))
	eventually(t, "the retry", func() bool { return len(sent.withEvents()) == 2 })
	stop(r)

	sent.mu.Lock()
	defer sent.mu.Unlock()

	var times []time.Time
	for _, batch := range sent.batches {
		if len(batch.events) > 0 {
			times = append(times, batch.at)
		}
	}
	if gap := times[1].Sub(times[0]); gap < 1450*time.Millisecond {
		t.Fatalf("retried after %v", gap)
	}
}

func TestStopDeliversWhatIsQueuedDespiteADelay(t *testing.T) {
	sent := &recorder{answers: []error{nil, &transportError{message: "down", status: 500, retryable: true}}}
	r := testReporter(sent.send, func(o *reporterOptions) { o.flushInterval = time.Hour; o.maxBatchSize = 1 })
	r.start()

	r.record(event(1))
	eventually(t, "the failed batch", func() bool { return len(sent.withEvents()) == 1 })
	r.record(event(2))
	stop(r)

	if got := sent.withEvents(); !reflect.DeepEqual(got, [][]string{{"1"}, {"1"}, {"2"}}) {
		t.Fatalf("got %v", got)
	}
}

func TestReportsDiscardedEventsWhenAsked(t *testing.T) {
	var notes []string
	sent := &recorder{}
	r := testReporter(sent.send, func(o *reporterOptions) {
		o.flushInterval = time.Hour
		o.maxQueueSize = 2
		o.debug = true
		o.onDiagnostic = func(message string) { notes = append(notes, message) }
	})

	for i := range 5 {
		r.record(event(i))
	}
	stop(r)

	if got := sent.withEvents(); !reflect.DeepEqual(got, [][]string{{"3", "4"}}) {
		t.Fatalf("got %v", got)
	}
	if len(notes) == 0 || !strings.Contains(notes[0], "discarded 3 events") {
		t.Fatalf("notes %v", notes)
	}
}

func TestSaysNothingAboutPassingTroubleUnlessAsked(t *testing.T) {
	var notes []string
	sent := &recorder{answers: []error{&transportError{message: "down", retryable: true}}}
	r := testReporter(sent.send, func(o *reporterOptions) {
		o.onDiagnostic = func(message string) { notes = append(notes, message) }
	})
	r.start()
	eventually(t, "the announcement", func() bool { return sent.count() == 1 })
	stop(r)

	if len(notes) != 0 {
		t.Fatalf("notes %v", notes)
	}
}
