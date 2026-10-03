package mcpsdk

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/mcpspan/mcpspan/packages/mcpspan-go/internal/core"
)

// capture configures collection into memory and returns what was delivered
// once the test is done with the server.
func capture(t *testing.T) func() []core.Event {
	t.Helper()
	t.Setenv("MCPSPAN_API_KEY", "")

	var mu sync.Mutex
	var events []core.Event
	core.Configure(core.UseSender(core.Settings{APIKey: "k", FlushInterval: time.Hour}, func(batch []core.Event) error {
		mu.Lock()
		events = append(events, batch...)
		mu.Unlock()
		return nil
	}))

	return func() []core.Event {
		core.Shutdown(context.Background())
		mu.Lock()
		defer mu.Unlock()
		return events
	}
}

type none struct{}

type typedInput struct {
	Destination string  `json:"destination"`
	Passengers  float64 `json:"passengers"`
}

type BookingError struct{}

func (*BookingError) Error() string { return "seat map unavailable" }

func text(value string) *mcp.CallToolResult {
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: value}}}
}

func ok(context.Context, *mcp.CallToolRequest, none) (*mcp.CallToolResult, any, error) {
	return text("ok"), nil, nil
}

func build() *mcp.Server {
	server := mcp.NewServer(&mcp.Implementation{Name: "test", Version: "1.0.0"}, nil)
	mcp.AddTool(server, &mcp.Tool{Name: "ok"}, ok)
	mcp.AddTool(server, &mcp.Tool{Name: "reported_error"},
		func(context.Context, *mcp.CallToolRequest, none) (*mcp.CallToolResult, any, error) {
			result := text("No flights found")
			result.IsError = true
			return result, nil, nil
		})
	mcp.AddTool(server, &mcp.Tool{Name: "throws"},
		func(context.Context, *mcp.CallToolRequest, none) (*mcp.CallToolResult, any, error) {
			return nil, nil, &BookingError{}
		})
	mcp.AddTool(server, &mcp.Tool{Name: "typed"},
		func(context.Context, *mcp.CallToolRequest, typedInput) (*mcp.CallToolResult, any, error) {
			return text("ok"), nil, nil
		})
	mcp.AddTool(server, Exclude(&mcp.Tool{Name: "excluded"}),
		func(context.Context, *mcp.CallToolRequest, typedInput) (*mcp.CallToolResult, any, error) {
			return text("ok"), nil, nil
		})

	return server
}

type call struct {
	name      string
	arguments any
}

// run connects a client calling itself clientName, makes the calls, and
// leaves.
func run(t *testing.T, server *mcp.Server, clientName string, calls ...call) []*mcp.CallToolResult {
	t.Helper()
	ctx := context.Background()

	clientTransport, serverTransport := mcp.NewInMemoryTransports()
	session, err := server.Connect(ctx, serverTransport, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()

	client := mcp.NewClient(&mcp.Implementation{Name: clientName, Version: "1.0.0"}, nil)
	clientSession, err := client.Connect(ctx, clientTransport, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer clientSession.Close()

	var results []*mcp.CallToolResult
	for _, c := range calls {
		result, _ := clientSession.CallTool(ctx, &mcp.CallToolParams{Name: c.name, Arguments: c.arguments})
		results = append(results, result)
	}

	return results
}

func byTool(events []core.Event) map[string]core.Event {
	found := map[string]core.Event{}
	for _, event := range events {
		found[event.ToolName] = event
	}
	return found
}

func TestRecordsEachKindOfOutcome(t *testing.T) {
	delivered := capture(t)
	server := Instrument(build())

	results := run(t, server, "claude-code", call{"ok", nil}, call{"reported_error", nil}, call{"throws", nil})

	events := byTool(delivered())
	if !events["ok"].Success || events["ok"].ErrorSource != "" {
		t.Errorf("ok: %+v", events["ok"])
	}
	if e := events["reported_error"]; e.ErrorSource != "result" || e.ErrorMessage != "No flights found" {
		t.Errorf("reported_error: %+v", e)
	}
	if e := events["throws"]; e.ErrorSource != "exception" || e.ErrorType != "BookingError" ||
		e.ErrorMessage != "seat map unavailable" {
		t.Errorf("throws: %+v", e)
	}
	// The client still gets its errors, as without mcpspan.
	if !results[1].IsError || !results[2].IsError {
		t.Error("an error result did not reach the client")
	}
}

func TestRecordsRefusedCallsWithoutAMessage(t *testing.T) {
	delivered := capture(t)
	server := Instrument(build())

	run(t, server, "claude-code",
		call{"typed", map[string]any{"destination": "WAW", "passengers": "two"}},
		call{"no_such_tool", nil})

	events := byTool(delivered())
	if e := events["typed"]; e.ErrorSource != "arguments" || e.ErrorMessage != "" {
		t.Errorf("typed: %+v", e)
	}
	if e := events["no_such_tool"]; e.ErrorSource != "unknown_tool" || e.ErrorMessage != "" {
		t.Errorf("no_such_tool: %+v", e)
	}
}

func TestLeavesAnExcludedToolOutEvenWhenRefused(t *testing.T) {
	delivered := capture(t)
	server := Instrument(build())

	run(t, server, "claude-code",
		call{"excluded", map[string]any{"destination": "WAW", "passengers": 1}},
		call{"excluded", map[string]any{"destination": 1}},
		call{"ok", nil})

	events := delivered()
	if len(events) != 1 || events[0].ToolName != "ok" {
		t.Fatalf("events %+v", events)
	}
}

func TestMeasuresToolsRegisteredBeforeAndAfter(t *testing.T) {
	delivered := capture(t)
	server := build()
	Instrument(server)
	mcp.AddTool(server, &mcp.Tool{Name: "later"}, ok)

	run(t, server, "claude-code", call{"ok", nil}, call{"later", nil})

	if events := delivered(); len(events) != 2 || events[0].ToolName != "ok" || events[1].ToolName != "later" {
		t.Fatalf("events %+v", events)
	}
}

func TestTheClientAndOneSessionPerConnection(t *testing.T) {
	delivered := capture(t)
	server := Instrument(build())

	run(t, server, "Claude Desktop", call{"ok", nil}, call{"typed", map[string]any{}}, call{"no_such_tool", nil})

	events := delivered()
	sessions := map[string]bool{}
	for _, event := range events {
		if event.ClientType != "claude" || event.ClientName != "Claude Desktop" {
			t.Errorf("client of %s: %s %q", event.ToolName, event.ClientType, event.ClientName)
		}
		sessions[event.SessionID] = true
	}
	if len(events) != 3 || len(sessions) != 1 || sessions[""] {
		t.Fatalf("sessions %v over %d events", sessions, len(events))
	}
}

func TestInstrumentingTwiceCountsOnce(t *testing.T) {
	delivered := capture(t)
	server := Instrument(Instrument(build()))

	run(t, server, "claude-code", call{"ok", nil})

	if events := delivered(); len(events) != 1 {
		t.Fatalf("%d events", len(events))
	}
}

func TestTrackAloneRecordsTheCall(t *testing.T) {
	delivered := capture(t)
	server := mcp.NewServer(&mcp.Implementation{Name: "untouched"}, nil)
	mcp.AddTool(server, &mcp.Tool{Name: "by_hand"}, TrackFor(ok))

	run(t, server, "cursor", call{"by_hand", nil})

	events := delivered()
	if len(events) != 1 || events[0].ToolName != "by_hand" || events[0].ClientType != "cursor" || events[0].SessionID != "" {
		t.Fatalf("events %+v", events)
	}
}

func TestTrackOnAnInstrumentedServerCountsOnceAndProvesTheHandlerRan(t *testing.T) {
	delivered := capture(t)
	server := Instrument(build())
	// A handler whose own error reads like a refusal: only the proof that it
	// ran keeps it from being counted as refused arguments.
	mcp.AddTool(server, &mcp.Tool{Name: "lookalike"}, TrackFor(
		func(context.Context, *mcp.CallToolRequest, none) (*mcp.CallToolResult, any, error) {
			return nil, nil, errors.New(`validating "arguments": my own words`)
		}))

	run(t, server, "claude-code", call{"lookalike", nil})

	events := delivered()
	if len(events) != 1 || events[0].ErrorSource != "exception" {
		t.Fatalf("events %+v", events)
	}
}

func TestUnconfiguredTheServerWorksAndNothingIsRecorded(t *testing.T) {
	t.Setenv("MCPSPAN_API_KEY", "")
	core.Shutdown(context.Background())
	server := Instrument(build())

	results := run(t, server, "claude-code", call{"ok", nil})

	if results[0] == nil || results[0].IsError {
		t.Fatal("the tool did not answer")
	}
	if core.Collecting() {
		t.Fatal("collecting without a key")
	}
}

func TestANilServerIsReturnedAsItCame(t *testing.T) {
	if Instrument(nil) != nil {
		t.Fatal("not nil")
	}
}
