// Package mcpspan is analytics for MCP servers: which tools are called, by
// which client, how long they take, and which ones fail.
//
// Instrumenting a server is one line, in the package for the MCP SDK it is
// built on:
//
//	server := mcp.NewServer(&mcp.Implementation{Name: "flights"}, nil)
//	mcpsdk.Instrument(server, mcpspan.Config{APIKey: os.Getenv("MCPSPAN_API_KEY")})
//	defer mcpspan.Shutdown(context.Background())
//
// github.com/mcpspan/mcpspan/packages/mcpspan-go/mcpsdk serves the official
// SDK, github.com/modelcontextprotocol/go-sdk, and .../mcpspan-go/mcpgo serves
// github.com/mark3labs/mcp-go. Without an API key nothing is collected and
// nothing is sent. Parameter values never leave the process.
package mcpspan

import (
	"context"
	"time"

	"github.com/mcpspan/mcpspan/packages/mcpspan-go/internal/core"
)

// Version is the SDK's own version, reported with every event.
const Version = core.Version

// Config is what the SDK needs to know. Every field is optional.
type Config struct {
	// APIKey identifies the server. Falls back to MCPSPAN_API_KEY; without
	// either, nothing is collected.
	APIKey string

	// Endpoint is the base URL of your mcpspan installation. Falls back to
	// MCPSPAN_ENDPOINT. There is no default: without either, nothing is
	// collected, and the SDK says so once.
	Endpoint string

	// Debug writes delivery diagnostics to standard error.
	Debug bool

	// OnDiagnostic receives diagnostics instead, and implies Debug.
	OnDiagnostic func(message string)

	// FlushInterval is how long a partly filled batch waits. Default 5s.
	FlushInterval time.Duration

	// MaxBatchSize is how many events go in one request. Default 100.
	MaxBatchSize int

	// MaxQueueSize is how many events are held while delivery fails.
	// Default 10,000.
	MaxQueueSize int

	// CaptureParameterNames records which parameters a tool was called with,
	// by name and JSON type. Off by default; values are never read.
	CaptureParameterNames bool

	// OmitErrorMessages leaves out the text of a failure: what a tool returned
	// as an error, cut to 200 characters, or an error's message, cut to 500.
	// That text is sent by default, since it is usually what says why a call
	// failed. Set this when your tools can fail with text you would not send
	// anywhere, as one that runs commands or reads files might quote a path or
	// a token. Failures are still recorded, with where they came from and the
	// error's type.
	OmitErrorMessages bool

	// ServerVersion is the version calls are recorded under: a release, a tag,
	// a commit. Falls back to MCPSPAN_SERVER_VERSION, then to the version the
	// server gives itself (the Implementation it was built with), which is
	// usually all that is needed. The dashboard marks where each one began.
	ServerVersion string
}

// Configure starts collecting, or stops if there is no key to collect with.
//
// Calling it again with the same configuration changes nothing, so a server
// built per request can pass it every time. A different configuration
// replaces the running one, delivering what the old one held.
//
// It never panics: it runs during a server's startup, and a mistyped setting
// must not be why a server fails to start.
func Configure(config Config) {
	core.Configure(settings(config))
}

// Shutdown stops collecting and delivers what is queued, for as long as ctx
// allows, at most a few seconds.
//
// Go has no hook for a program's end, so what is queued when main returns
// is lost unless this runs first. Defer it in main:
//
//	defer mcpspan.Shutdown(context.Background())
func Shutdown(ctx context.Context) {
	core.Shutdown(ctx)
}

func settings(config Config) core.Settings {
	return core.Settings{
		APIKey:                config.APIKey,
		Endpoint:              config.Endpoint,
		Debug:                 config.Debug,
		OnDiagnostic:          config.OnDiagnostic,
		FlushInterval:         config.FlushInterval,
		MaxBatchSize:          config.MaxBatchSize,
		MaxQueueSize:          config.MaxQueueSize,
		CaptureParameterNames: config.CaptureParameterNames,
		OmitErrorMessages:     config.OmitErrorMessages,
		ServerVersion:         config.ServerVersion,
	}
}
