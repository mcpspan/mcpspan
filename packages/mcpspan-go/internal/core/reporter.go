package core

import (
	"context"
	"fmt"
	"math/rand/v2"
	"net/http"
	"os"
	"sync"
	"time"
)

// Delivery defaults, as the contract sets them (section 6.2).
const (
	DefaultFlushInterval = 5 * time.Second
	DefaultMaxBatchSize  = 100
	initialRetryDelay    = time.Second
	maxRetryDelay        = time.Minute
)

// backoff is the wait after the n-th consecutive failure: doubling to a
// ceiling, then spread across the second half of that window, so many
// servers that failed together do not all come back together.
func backoff(failures int, random func() float64) time.Duration {
	ceiling := min(maxRetryDelay, initialRetryDelay<<min(failures-1, 16))
	half := float64(ceiling) / 2

	return time.Duration(half + random()*half)
}

type sender func(events []Event) error

// reporter collects events and delivers them from a goroutine of its own.
//
// Record is the only method a tool call touches, and it only appends to
// memory under a lock. A goroutine does not keep a Go program alive, so
// nothing here can stop a server exiting; what is still queued then is only
// delivered by Shutdown, which is why a server should defer it.
type reporter struct {
	endpoint      string
	send          sender
	flushInterval time.Duration
	maxBatchSize  int
	timeout       time.Duration
	debug         bool
	onDiagnostic  func(string)

	mu            sync.Mutex
	queue         queue
	reportedDrops int
	failures      int
	nextAttempt   time.Time
	rejected      bool
	stopped       bool

	// One delivery at a time, so the same events are never posted twice.
	sending sync.Mutex

	wake chan struct{}
	quit chan struct{}
	once sync.Once
}

type reporterOptions struct {
	endpoint      string
	apiKey        string
	flushInterval time.Duration
	maxBatchSize  int
	maxQueueSize  int
	debug         bool
	onDiagnostic  func(string)
	send          sender
}

func newReporter(options reporterOptions) *reporter {
	r := &reporter{
		endpoint:      options.endpoint,
		send:          options.send,
		flushInterval: options.flushInterval,
		maxBatchSize:  options.maxBatchSize,
		timeout:       DefaultTimeout,
		debug:         options.debug,
		onDiagnostic:  options.onDiagnostic,
		queue:         queue{max: options.maxQueueSize},
		wake:          make(chan struct{}, 1),
		quit:          make(chan struct{}),
	}

	if r.send == nil {
		client := newHTTPClient(r.timeout)
		r.send = func(events []Event) error {
			return sendEvents(client, options.endpoint, options.apiKey, events)
		}
	}

	return r
}

// start begins delivery, announcing the server first (contract, 3.4).
func (r *reporter) start() {
	go r.run()
}

func (r *reporter) run() {
	defer func() {
		// Nothing may escape into the host, not even from a goroutine,
		// where a panic would end the whole program.
		if recovered := recover(); recovered != nil {
			r.log(fmt.Sprintf("mcpspan: delivery stopped (%v)", recovered))
		}
	}()

	r.announce()

	ticker := time.NewTicker(r.flushInterval)
	defer ticker.Stop()

	for {
		select {
		case <-r.quit:
			return
		case <-ticker.C:
		case <-r.wake:
		}
		r.deliver(false)
	}
}

// record queues an event and returns at once.
func (r *reporter) record(event Event) {
	r.mu.Lock()
	if r.stopped || r.rejected {
		r.mu.Unlock()
		return
	}
	r.queue.add(event)
	full := len(r.queue.events) >= r.maxBatchSize
	r.mu.Unlock()

	if full {
		select {
		case r.wake <- struct{}{}:
		default:
		}
	}
}

// stop ends delivery and makes a final attempt at whatever is queued,
// ignoring any retry delay: this is the last chance these events get. It
// waits for a delivery already under way rather than posting its events a
// second time, for as long as ctx allows.
func (r *reporter) stop(ctx context.Context) {
	r.once.Do(func() { close(r.quit) })

	r.mu.Lock()
	r.stopped = true
	r.mu.Unlock()

	done := make(chan struct{})
	go func() {
		defer close(done)
		defer func() { _ = recover() }()
		r.deliver(true)
	}()

	select {
	case <-done:
	case <-ctx.Done():
	}
}

func (r *reporter) announce() {
	err := r.send(nil)
	if err == nil {
		return
	}

	if te, ok := err.(*transportError); ok && (te.status == http.StatusUnauthorized || te.status == http.StatusForbidden) {
		r.reject(te.status)
		return
	}

	r.log(fmt.Sprintf("mcpspan: could not announce this server to %s (%v). "+
		"Events will still be delivered once it answers.", r.endpoint, err))
}

func (r *reporter) deliver(force bool) {
	r.mu.Lock()
	waiting := !force && time.Now().Before(r.nextAttempt)
	rejected := r.rejected
	r.mu.Unlock()

	if waiting || rejected {
		return
	}

	r.sending.Lock()
	defer r.sending.Unlock()

	r.reportDrops()

	for {
		r.mu.Lock()
		if r.rejected {
			r.mu.Unlock()
			return
		}
		batch := r.queue.drain(r.maxBatchSize)
		r.mu.Unlock()

		if len(batch) == 0 {
			return
		}

		if err := r.send(batch); err != nil {
			r.failed(batch, err)
			return
		}

		r.mu.Lock()
		r.failures = 0
		r.nextAttempt = time.Time{}
		r.mu.Unlock()
	}
}

func (r *reporter) reportDrops() {
	r.mu.Lock()
	dropped := r.queue.dropped - r.reportedDrops
	r.reportedDrops = r.queue.dropped
	r.mu.Unlock()

	if dropped > 0 {
		r.log(fmt.Sprintf("mcpspan: discarded %d events, the queue was full", dropped))
	}
}

func (r *reporter) failed(batch []Event, err error) {
	te, ok := err.(*transportError)
	if !ok {
		te = &transportError{message: err.Error(), retryable: true}
	}

	if te.status == http.StatusUnauthorized || te.status == http.StatusForbidden {
		r.reject(te.status)
		return
	}

	r.mu.Lock()
	if te.retryable {
		r.queue.restore(batch)
	}
	r.failures++
	failures := r.failures
	// The longer of our own backoff and what the API asked for: retrying
	// sooner than asked only earns another refusal.
	r.nextAttempt = time.Now().Add(max(backoff(failures, rand.Float64), te.retryAfter))
	r.mu.Unlock()

	if !te.retryable {
		// Refused the same way every time: dropped, and collecting goes on.
		r.log(fmt.Sprintf("mcpspan: dropped %d events, rejected as %d", len(batch), te.status))
	}
	r.log(fmt.Sprintf("mcpspan: delivery failed (%v), attempt %d", te, failures))
}

// reject gives up on a key the endpoint refused, and says so once even with
// diagnostics off: a silent SDK collecting nothing because of a mistyped key
// is the worst way to spend an afternoon.
func (r *reporter) reject(status int) {
	r.mu.Lock()
	if r.rejected {
		r.mu.Unlock()
		return
	}
	r.rejected = true
	r.queue.events = nil
	r.mu.Unlock()

	r.warn(fmt.Sprintf("mcpspan: the ingest endpoint rejected the API key (HTTP %d). "+
		"Telemetry is now disabled for this process.", status))
}

func (r *reporter) log(message string) {
	if r.debug {
		r.warn(message)
	}
}

// warn goes to the developer's callback if there is one, otherwise to
// standard error. Never standard output: on the stdio transport it carries
// the MCP protocol, and a stray line there breaks the server.
func (r *reporter) warn(message string) {
	defer func() { _ = recover() }()

	if r.onDiagnostic != nil {
		r.onDiagnostic(message)
		return
	}

	fmt.Fprintln(os.Stderr, message)
}
