package mcpsdk

import (
	"context"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/mcpspan/mcpspan/packages/mcpspan-go/internal/core"
)

func TestResourcesAndPromptsAreRecordedByWhatTheyAre(t *testing.T) {
	events := captureNamingParameters(t)

	server := build()
	text := func(_ context.Context, req *mcp.ReadResourceRequest) (*mcp.ReadResourceResult, error) {
		return &mcp.ReadResourceResult{Contents: []*mcp.ResourceContents{{URI: req.Params.URI, Text: "ok"}}}, nil
	}
	server.AddResource(&mcp.Resource{Name: "config", URI: "config://app"}, text)
	server.AddResourceTemplate(&mcp.ResourceTemplate{Name: "trip", URITemplate: "trips://{id}"}, text)
	server.AddPrompt(&mcp.Prompt{Name: "plan_trip"}, func(context.Context, *mcp.GetPromptRequest) (*mcp.GetPromptResult, error) {
		return &mcp.GetPromptResult{Messages: []*mcp.PromptMessage{{Role: "user", Content: &mcp.TextContent{Text: "ok"}}}}, nil
	})
	server.AddPrompt(&mcp.Prompt{Name: "broken"}, func(context.Context, *mcp.GetPromptRequest) (*mcp.GetPromptResult, error) {
		return nil, &BookingError{}
	})
	Instrument(server)

	ctx := context.Background()
	clientTransport, serverTransport := mcp.NewInMemoryTransports()
	session, err := server.Connect(ctx, serverTransport, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	client, err := mcp.NewClient(&mcp.Implementation{Name: "cursor", Version: "1.0.0"}, nil).Connect(ctx, clientTransport, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()

	_, _ = client.ReadResource(ctx, &mcp.ReadResourceParams{URI: "config://app"})
	_, _ = client.ReadResource(ctx, &mcp.ReadResourceParams{URI: "trips://secret-4412"})
	_, _ = client.ReadResource(ctx, &mcp.ReadResourceParams{URI: "db://customers/4412"})
	_, _ = client.GetPrompt(ctx, &mcp.GetPromptParams{Name: "plan_trip", Arguments: map[string]string{"destination": "Lisbon"}})
	_, _ = client.GetPrompt(ctx, &mcp.GetPromptParams{Name: "translate"})
	_, _ = client.GetPrompt(ctx, &mcp.GetPromptParams{Name: "broken"})
	_, _ = client.ListResources(ctx, nil)
	_, _ = client.ListPrompts(ctx, nil)

	recorded := events()
	var got [][3]string
	for _, event := range recorded {
		got = append(got, [3]string{event.Kind, event.ToolName, event.ErrorSource})
	}
	want := [][3]string{
		{core.KindResource, "config://app", ""},
		{core.KindResource, "trips://{id}", ""},
		{core.KindResource, "db://", core.SourceUnknownResource},
		{core.KindPrompt, "plan_trip", ""},
		{core.KindPrompt, "translate", core.SourceUnknownPrompt},
		{core.KindPrompt, "broken", core.SourceException},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("recorded %v, want %v", got, want)
	}
	if !reflect.DeepEqual(recorded[1].Parameters, map[string]string{"id": "string"}) {
		t.Errorf("template variables %v", recorded[1].Parameters)
	}
	if recorded[5].ErrorType != "BookingError" {
		t.Errorf("exception type %q", recorded[5].ErrorType)
	}
	for _, event := range recorded {
		if event.ClientType != "cursor" || strings.Contains(event.ToolName+event.ErrorMessage, "4412") {
			t.Errorf("event %+v", event)
		}
	}
}

// captureNamingParameters is capture, with parameter names recorded.
func captureNamingParameters(t *testing.T) func() []core.Event {
	t.Helper()
	t.Setenv("MCPSPAN_API_KEY", "")

	var mu sync.Mutex
	var events []core.Event
	settings := core.Settings{APIKey: "k", FlushInterval: time.Hour, CaptureParameterNames: true}
	core.Configure(core.UseSender(settings, func(batch []core.Event) error {
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

func TestSchemeOfKeepsNothingPastTheScheme(t *testing.T) {
	for uri, want := range map[string]string{
		"db://customers/4412":     "db://",
		"file:///home/ada/cv.pdf": "file://",
		"customers/4412":          "unknown://",
		"4412:secret":             "unknown://",
	} {
		if got := schemeOf(uri); got != want {
			t.Errorf("schemeOf(%q) = %q, want %q", uri, got, want)
		}
	}
}

// The SDK keeps the server's version unexported; this is where it is read.
func TestTheServerVersionIsWhereItIsRead(t *testing.T) {
	if got := serverVersionOf(build()); got != "1.0.0" {
		t.Fatalf("read %q from the server built as 1.0.0", got)
	}
	if got := serverVersionOf(nil); got != "" {
		t.Fatalf("read %q from no server", got)
	}
}
