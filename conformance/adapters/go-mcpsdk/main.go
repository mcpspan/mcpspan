// The conformance adapter for the Go SDK, on the official MCP Go SDK.
//
// Build it, then point the suite at the binary:
//
//	go build -o adapter . && CONFORMANCE_ADAPTER='["adapters/go-mcpsdk/adapter"]' ...
package main

import (
	"context"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	mcpspan "github.com/mcpspan/mcpspan/packages/mcpspan-go"
	"github.com/mcpspan/mcpspan/packages/mcpspan-go/mcpsdk"
)

type ConformanceError struct{ message string }

func (e *ConformanceError) Error() string { return e.message }

func text(value string) *mcp.CallToolResult {
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: value}}}
}

type none struct{}

type typedInput struct {
	Destination string  `json:"destination"`
	Passengers  float64 `json:"passengers"`
}

type depthInput struct {
	Depth float64 `json:"depth"`
}

func ok(context.Context, *mcp.CallToolRequest, none) (*mcp.CallToolResult, any, error) {
	return text("ok"), nil, nil
}

func main() {
	flush, _ := strconv.Atoi(os.Getenv("CONFORMANCE_FLUSH_MS"))
	if flush == 0 {
		flush = 200
	}

	server := mcp.NewServer(&mcp.Implementation{Name: "conformance", Version: "1.0.0"}, nil)

	// Before Instrument, as the contract requires an SDK to measure too.
	mcp.AddTool(server, &mcp.Tool{Name: "early"}, ok)

	mcpsdk.Instrument(server, mcpspan.Config{
		Endpoint:              os.Getenv("MCPSPAN_ENDPOINT"),
		FlushInterval:         time.Duration(flush) * time.Millisecond,
		CaptureParameterNames: os.Getenv("CONFORMANCE_CAPTURE_PARAMETERS") == "1",
	})

	mcp.AddTool(server, &mcp.Tool{Name: "ok"}, ok)
	mcp.AddTool(server, &mcp.Tool{Name: "reported_error"},
		func(context.Context, *mcp.CallToolRequest, none) (*mcp.CallToolResult, any, error) {
			result := text("No flights found")
			result.IsError = true
			return result, nil, nil
		})
	mcp.AddTool(server, &mcp.Tool{Name: "throws"},
		func(context.Context, *mcp.CallToolRequest, none) (*mcp.CallToolResult, any, error) {
			return nil, nil, &ConformanceError{message: "boom"}
		})
	mcp.AddTool(server, &mcp.Tool{Name: "typed"},
		func(context.Context, *mcp.CallToolRequest, typedInput) (*mcp.CallToolResult, any, error) {
			return text("ok"), nil, nil
		})
	mcp.AddTool(server, mcpsdk.Exclude(&mcp.Tool{Name: "excluded"}),
		func(context.Context, *mcp.CallToolRequest, depthInput) (*mcp.CallToolResult, any, error) {
			return text("ok"), nil, nil
		})
	mcp.AddTool(server, &mcp.Tool{Name: "long_" + strings.Repeat("x", 295)}, ok)

	// Resources and prompts (contract, 3.5): one resource at a fixed address,
	// one read through a template, one that fails; a prompt with a required
	// argument, and one that fails.
	text := func(_ context.Context, req *mcp.ReadResourceRequest) (*mcp.ReadResourceResult, error) {
		return &mcp.ReadResourceResult{Contents: []*mcp.ResourceContents{{URI: req.Params.URI, Text: "ok"}}}, nil
	}
	server.AddResource(&mcp.Resource{Name: "config", URI: "config://app"}, text)
	server.AddResourceTemplate(&mcp.ResourceTemplate{Name: "trip", URITemplate: "trips://{id}"}, text)
	server.AddResource(&mcp.Resource{Name: "broken", URI: "broken://status"},
		func(context.Context, *mcp.ReadResourceRequest) (*mcp.ReadResourceResult, error) {
			return nil, &ConformanceError{message: "boom"}
		})
	server.AddPrompt(&mcp.Prompt{Name: "plan_trip", Arguments: []*mcp.PromptArgument{{Name: "destination", Required: true}}},
		func(_ context.Context, req *mcp.GetPromptRequest) (*mcp.GetPromptResult, error) {
			return &mcp.GetPromptResult{Messages: []*mcp.PromptMessage{{
				Role: "user", Content: &mcp.TextContent{Text: "Plan a trip to " + req.Params.Arguments["destination"]},
			}}}, nil
		})
	server.AddPrompt(&mcp.Prompt{Name: "broken_prompt"},
		func(context.Context, *mcp.GetPromptRequest) (*mcp.GetPromptResult, error) {
			return nil, &ConformanceError{message: "boom"}
		})

	// Returns when standard input closes, as the client leaves.
	_ = server.Run(context.Background(), &mcp.StdioTransport{})

	// Go has no hook for a program's end: what is queued goes now or never.
	mcpspan.Shutdown(context.Background())
}
