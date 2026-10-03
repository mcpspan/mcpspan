package mcpgo

import (
	"context"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/mark3labs/mcp-go/client"
	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/mcpspan/mcpspan/packages/mcpspan-go/internal/core"
)

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

func primitivesServer() *server.MCPServer {
	s := build()
	text := func(_ context.Context, request mcp.ReadResourceRequest) ([]mcp.ResourceContents, error) {
		return []mcp.ResourceContents{mcp.TextResourceContents{URI: request.Params.URI, Text: "ok"}}, nil
	}
	s.AddResource(mcp.NewResource("config://app", "config"), text)
	s.AddResourceTemplate(mcp.NewResourceTemplate("trips://{id}", "trip"), text)
	s.AddPrompt(mcp.NewPrompt("plan_trip"), func(context.Context, mcp.GetPromptRequest) (*mcp.GetPromptResult, error) {
		return mcp.NewGetPromptResult("", nil), nil
	})
	s.AddPrompt(mcp.NewPrompt("broken"), func(context.Context, mcp.GetPromptRequest) (*mcp.GetPromptResult, error) {
		return nil, &BookingError{}
	})
	return s
}

// The server's templates are read from where mcp-go keeps them, as it offers
// no way to list them. A version that moves them fails here first.
func TestTheServerStillKeepsItsTemplatesWhereTheyAreRead(t *testing.T) {
	templates := serverTemplates(primitivesServer())
	if len(templates) != 1 || templates[0].Raw() != "trips://{id}" {
		t.Fatalf("read %v", templates)
	}
}

func TestResourcesAndPromptsAreRecordedByWhatTheyAre(t *testing.T) {
	events := captureNamingParameters(t)
	s := Instrument(primitivesServer())

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
	initialize.Params.ClientInfo = mcp.Implementation{Name: "cursor", Version: "1.0.0"}
	if _, err := c.Initialize(ctx, initialize); err != nil {
		t.Fatal(err)
	}

	for _, uri := range []string{"config://app", "trips://secret-4412", "db://customers/4412"} {
		request := mcp.ReadResourceRequest{}
		request.Params.URI = uri
		_, _ = c.ReadResource(ctx, request)
	}
	for _, name := range []string{"plan_trip", "translate", "broken"} {
		request := mcp.GetPromptRequest{}
		request.Params.Name = name
		_, _ = c.GetPrompt(ctx, request)
	}

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
		if event.ClientType != "cursor" || strings.Contains(event.ToolName, "4412") {
			t.Errorf("event %+v", event)
		}
	}
}

// mcp-go keeps the server's version unexported; this is where it is read.
func TestTheServerVersionIsWhereItIsRead(t *testing.T) {
	if got := serverVersionOf(build()); got != "1.0.0" {
		t.Fatalf("read %q from the server built as 1.0.0", got)
	}
	if got := serverVersionOf(nil); got != "" {
		t.Fatalf("read %q from no server", got)
	}
}
