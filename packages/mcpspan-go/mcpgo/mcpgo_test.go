package mcpgo

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/mark3labs/mcp-go/client"
	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/mcpspan/mcpspan/packages/mcpspan-go/internal/core"
)

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

type BookingError struct{}

func (*BookingError) Error() string { return "seat map unavailable" }

func ok(context.Context, mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return mcp.NewToolResultText("ok"), nil
}

func build() *server.MCPServer {
	s := server.NewMCPServer("test", "1.0.0", server.WithInputSchemaValidation())
	s.AddTool(mcp.NewTool("ok"), ok)
	s.AddTool(mcp.NewTool("reported_error"), func(context.Context, mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return mcp.NewToolResultError("No flights found"), nil
	})
	s.AddTool(mcp.NewTool("throws"), func(context.Context, mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return nil, &BookingError{}
	})
	s.AddTool(mcp.NewTool("typed",
		mcp.WithString("destination", mcp.Required()),
		mcp.WithNumber("passengers", mcp.Required())), ok)
	s.AddTool(Exclude(mcp.NewTool("excluded", mcp.WithNumber("depth", mcp.Required()))), ok)

	return s
}

type call struct {
	name      string
	arguments map[string]any
}

func run(t *testing.T, s *server.MCPServer, clientName string, calls ...call) []*mcp.CallToolResult {
	t.Helper()
	ctx := context.Background()

	c, err := client.NewInProcessClient(s)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()

	if err := c.Start(ctx); err != nil {
		t.Fatal(err)
	}
	initialize := mcp.InitializeRequest{}
	initialize.Params.ProtocolVersion = mcp.LATEST_PROTOCOL_VERSION
	initialize.Params.ClientInfo = mcp.Implementation{Name: clientName, Version: "1.0.0"}
	if _, err := c.Initialize(ctx, initialize); err != nil {
		t.Fatal(err)
	}

	var results []*mcp.CallToolResult
	for _, cl := range calls {
		request := mcp.CallToolRequest{}
		request.Params.Name = cl.name
		request.Params.Arguments = cl.arguments
		result, _ := c.CallTool(ctx, request)
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
	s := Instrument(build())

	run(t, s, "claude-code", call{"ok", nil}, call{"reported_error", nil}, call{"throws", nil})

	events := byTool(delivered())
	if !events["ok"].Success {
		t.Errorf("ok: %+v", events["ok"])
	}
	if e := events["reported_error"]; e.ErrorSource != "result" || e.ErrorMessage != "No flights found" {
		t.Errorf("reported_error: %+v", e)
	}
	if e := events["throws"]; e.ErrorSource != "exception" || e.ErrorType != "BookingError" ||
		e.ErrorMessage != "seat map unavailable" {
		t.Errorf("throws: %+v", e)
	}
}

func TestRecordsRefusedCallsWithoutAMessage(t *testing.T) {
	delivered := capture(t)
	s := Instrument(build())

	run(t, s, "claude-code",
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
	s := Instrument(build())

	run(t, s, "claude-code",
		call{"excluded", map[string]any{"depth": 1}},
		call{"excluded", map[string]any{"depth": "deep"}},
		call{"ok", nil})

	events := delivered()
	if len(events) != 1 || events[0].ToolName != "ok" {
		t.Fatalf("events %+v", events)
	}
}

func TestMeasuresToolsRegisteredBeforeAndAfter(t *testing.T) {
	delivered := capture(t)
	s := Instrument(build())
	s.AddTool(mcp.NewTool("later"), ok)

	run(t, s, "claude-code", call{"ok", nil}, call{"later", nil})

	if events := delivered(); len(events) != 2 {
		t.Fatalf("events %+v", events)
	}
}

func TestTheClientAndOneSessionPerConnection(t *testing.T) {
	delivered := capture(t)
	s := Instrument(build())

	run(t, s, "Claude Desktop", call{"ok", nil}, call{"typed", map[string]any{}}, call{"no_such_tool", nil})

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

func TestKeepsHooksTheServerAlreadyHad(t *testing.T) {
	delivered := capture(t)
	hooks := &server.Hooks{}
	var seen int
	hooks.AddBeforeCallTool(func(context.Context, any, *mcp.CallToolRequest) { seen++ })
	s := server.NewMCPServer("test", "1.0.0", server.WithHooks(hooks))
	s.AddTool(mcp.NewTool("ok"), ok)
	Instrument(s)

	run(t, s, "claude-code", call{"ok", nil})

	if seen != 1 || len(delivered()) != 1 {
		t.Fatalf("own hook ran %d times", seen)
	}
}

func TestInstrumentingTwiceCountsOnce(t *testing.T) {
	delivered := capture(t)
	s := Instrument(Instrument(build()))

	run(t, s, "claude-code", call{"ok", nil})

	if events := delivered(); len(events) != 1 {
		t.Fatalf("%d events", len(events))
	}
}

func TestTrackAloneRecordsTheCall(t *testing.T) {
	delivered := capture(t)
	s := server.NewMCPServer("untouched", "1.0.0")
	s.AddTool(mcp.NewTool("by_hand"), Track(ok))

	run(t, s, "cursor", call{"by_hand", nil})

	events := delivered()
	if len(events) != 1 || events[0].ClientType != "cursor" {
		t.Fatalf("events %+v", events)
	}
}

func TestTrackOnAnInstrumentedServerCountsOnce(t *testing.T) {
	delivered := capture(t)
	s := Instrument(build())
	s.AddTool(mcp.NewTool("by_hand"), Track(ok))

	run(t, s, "claude-code", call{"by_hand", nil})

	if events := delivered(); len(events) != 1 {
		t.Fatalf("%d events", len(events))
	}
}

func TestLeavesNothingBehindPerCall(t *testing.T) {
	delivered := capture(t)
	s := Instrument(build())

	run(t, s, "claude-code", call{"ok", nil}, call{"typed", map[string]any{}}, call{"no_such_tool", nil}, call{"throws", nil})
	delivered()

	count := 0
	byRequest.Range(func(any, any) bool { count++; return true })
	byContext.Range(func(any, any) bool { count++; return true })
	if count != 0 {
		t.Fatalf("%d entries left", count)
	}
}
