package core

import (
	"context"
	"fmt"
	"os"
	"reflect"
	"strings"
	"sync"
	"time"
)

// NoEndpoint is said when there is a key and nowhere to send: somebody meant
// to collect. There is no default endpoint, since mcpspan runs wherever its
// user runs it, and a default would send their data somewhere they did not
// choose.
const NoEndpoint = "mcpspan: an API key is set but no endpoint, so nothing is collected. " +
	"Set MCPSPAN_ENDPOINT (or the Endpoint option) to your mcpspan installation, for example http://localhost:6271."

// Settings are the configuration, as the public package passes it in.
type Settings struct {
	APIKey                string
	Endpoint              string
	Debug                 bool
	OnDiagnostic          func(string)
	FlushInterval         time.Duration
	MaxBatchSize          int
	MaxQueueSize          int
	CaptureParameterNames bool
	ServerVersion         string

	// For tests: delivery goes here instead of over HTTP.
	send sender
}

var (
	mu      sync.Mutex
	current *reporter
	// What the running reporter was configured with, to recognise the same
	// configuration arriving again.
	active        *resolved
	captureParams bool
	serverVersion string
	// Whether NoEndpoint has been said in this process: once is enough.
	saidNoEndpoint bool
)

type resolved struct {
	apiKey, endpoint string
	debug            bool
	diagnostic       uintptr
	interval         time.Duration
	batch, queue     int
	capture          bool
	serverVersion    string
}

// Configure starts collecting, or stops if there is no key to collect with.
// Called again with the same settings, it changes nothing; with different
// ones, it replaces the running configuration, delivering what it held.
// Never panics.
func Configure(settings Settings) {
	defer func() {
		if recovered := recover(); recovered != nil && settings.Debug {
			fmt.Fprintf(os.Stderr, "mcpspan: could not configure (%v)\n", recovered)
		}
	}()

	debug := settings.Debug || settings.OnDiagnostic != nil
	next := resolve(settings, debug)

	mu.Lock()
	if current != nil && active != nil && *active == *next {
		mu.Unlock()
		return
	}
	previous := current
	current, active, captureParams, serverVersion = nil, nil, false, ""
	mu.Unlock()

	if previous != nil {
		ctx, cancel := context.WithTimeout(context.Background(), DefaultTimeout+time.Second)
		previous.stop(ctx)
		cancel()
	}

	// No key is a normal state, in development and CI, and not reported.
	if next.apiKey == "" {
		return
	}

	// Said unasked, as a refused key is: without it the data goes nowhere and
	// nothing tells anyone.
	if next.endpoint == "" {
		mu.Lock()
		say := !saidNoEndpoint
		saidNoEndpoint = true
		mu.Unlock()
		if say {
			if settings.OnDiagnostic != nil {
				settings.OnDiagnostic(NoEndpoint)
			} else {
				fmt.Fprintln(os.Stderr, NoEndpoint)
			}
		}
		return
	}

	r := newReporter(reporterOptions{
		endpoint:      next.endpoint,
		apiKey:        next.apiKey,
		flushInterval: next.interval,
		maxBatchSize:  next.batch,
		maxQueueSize:  next.queue,
		debug:         debug,
		onDiagnostic:  settings.OnDiagnostic,
		send:          settings.send,
	})

	mu.Lock()
	current, active, captureParams, serverVersion = r, next, next.capture, next.serverVersion
	mu.Unlock()

	// In the background: startup does not wait for the network.
	r.start()
}

func resolve(settings Settings, debug bool) *resolved {
	next := &resolved{
		apiKey:   firstNonEmpty(settings.APIKey, os.Getenv("MCPSPAN_API_KEY")),
		endpoint: firstNonEmpty(settings.Endpoint, os.Getenv("MCPSPAN_ENDPOINT")),
		debug:    debug,
		interval: DefaultFlushInterval,
		batch:    DefaultMaxBatchSize,
		queue:    DefaultMaxQueueSize,
		capture:  settings.CaptureParameterNames,
		// The setting, then the environment; the server's own is read per call.
		serverVersion: firstNonEmpty(settings.ServerVersion, os.Getenv("MCPSPAN_SERVER_VERSION")),
	}

	if settings.OnDiagnostic != nil {
		next.diagnostic = reflect.ValueOf(settings.OnDiagnostic).Pointer()
	}

	// A malformed setting falls back to its default, and says so when asked.
	positive := func(name string, value int64, apply func()) {
		switch {
		case value > 0:
			apply()
		case value < 0 && debug:
			fmt.Fprintf(os.Stderr, "mcpspan: ignoring %s=%d, expected a positive value\n", name, value)
		}
	}
	positive("FlushInterval", int64(settings.FlushInterval), func() { next.interval = settings.FlushInterval })
	// The API takes at most 1,000 events per request.
	positive("MaxBatchSize", int64(settings.MaxBatchSize), func() { next.batch = min(settings.MaxBatchSize, 1_000) })
	positive("MaxQueueSize", int64(settings.MaxQueueSize), func() { next.queue = settings.MaxQueueSize })

	return next
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}

	return ""
}

// Shutdown stops collecting and delivers what is queued, for as long as ctx
// allows. Never panics.
func Shutdown(ctx context.Context) {
	defer func() { _ = recover() }()

	mu.Lock()
	previous := current
	current, active, captureParams, serverVersion = nil, nil, false, ""
	mu.Unlock()

	if previous != nil {
		previous.stop(ctx)
	}
}

// Collecting reports whether an API key is configured and events are being
// recorded.
func Collecting() bool {
	mu.Lock()
	defer mu.Unlock()

	return current != nil
}

// configuredServerVersion is the version every call is recorded under, when
// one was set, whatever the server gives itself.
func configuredServerVersion() string {
	mu.Lock()
	defer mu.Unlock()

	return serverVersion
}

func running() (*reporter, bool) {
	mu.Lock()
	defer mu.Unlock()

	return current, captureParams
}

// UseSender points delivery at a function, for tests in other packages of
// this module.
func UseSender(settings Settings, send func([]Event) error) Settings {
	settings.send = send
	// The function stands in for the endpoint, which only has to be there.
	if settings.Endpoint == "" {
		settings.Endpoint = "http://sender.test"
	}
	return settings
}
