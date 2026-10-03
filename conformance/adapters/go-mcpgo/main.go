// The conformance adapter for the Go SDK, on mcp-go.
//
// Build it, then point the suite at the binary:
//
//	go build -o adapter . && CONFORMANCE_ADAPTER='["adapters/go-mcpgo/adapter"]' ...
package main

import (
	"context"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	mcpspan "github.com/mcpspan/mcpspan/packages/mcpspan-go"
	"github.com/mcpspan/mcpspan/packages/mcpspan-go/mcpgo"
)

type ConformanceError struct{ message string }

func (e *ConformanceError) Error() string { return e.message }

func ok(context.Context, mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return mcp.NewToolResultText("ok"), nil
}

func main() {
	flush, _ := strconv.Atoi(os.Getenv("CONFORMANCE_FLUSH_MS"))
	if flush == 0 {
		flush = 200
	}

	// mcp-go refuses arguments against a tool's schema only when asked to.
	s := server.NewMCPServer("conformance", "1.0.0", server.WithInputSchemaValidation())

	// Before Instrument, as the contract requires an SDK to measure too.
	s.AddTool(mcp.NewTool("early"), ok)

	mcpgo.Instrument(s, mcpspan.Config{
		Endpoint:              os.Getenv("MCPSPAN_ENDPOINT"),
		FlushInterval:         time.Duration(flush) * time.Millisecond,
		CaptureParameterNames: os.Getenv("CONFORMANCE_CAPTURE_PARAMETERS") == "1",
	})

	s.AddTool(mcp.NewTool("ok"), ok)
	s.AddTool(mcp.NewTool("reported_error"), func(context.Context, mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return mcp.NewToolResultError("No flights found"), nil
	})
	s.AddTool(mcp.NewTool("throws"), func(context.Context, mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return nil, &ConformanceError{message: "boom"}
	})
	s.AddTool(mcp.NewTool("typed",
		mcp.WithString("destination", mcp.Required()),
		mcp.WithNumber("passengers", mcp.Required()),
	), ok)
	s.AddTool(mcpgo.Exclude(mcp.NewTool("excluded", mcp.WithNumber("depth", mcp.Required()))), ok)
	s.AddTool(mcp.NewTool("long_"+strings.Repeat("x", 295)), ok)

	// Resources and prompts (contract, 3.5): one resource at a fixed address,
	// one read through a template, one that fails; a prompt with a required
	// argument, and one that fails.
	text := func(_ context.Context, request mcp.ReadResourceRequest) ([]mcp.ResourceContents, error) {
		return []mcp.ResourceContents{mcp.TextResourceContents{URI: request.Params.URI, Text: "ok"}}, nil
	}
	s.AddResource(mcp.NewResource("config://app", "config"), text)
	s.AddResourceTemplate(mcp.NewResourceTemplate("trips://{id}", "trip"), text)
	s.AddResource(mcp.NewResource("broken://status", "broken"),
		func(context.Context, mcp.ReadResourceRequest) ([]mcp.ResourceContents, error) {
			return nil, &ConformanceError{message: "boom"}
		})
	s.AddPrompt(mcp.NewPrompt("plan_trip", mcp.WithArgument("destination", mcp.RequiredArgument())),
		func(_ context.Context, request mcp.GetPromptRequest) (*mcp.GetPromptResult, error) {
			return mcp.NewGetPromptResult("", []mcp.PromptMessage{
				mcp.NewPromptMessage(mcp.RoleUser, mcp.NewTextContent("Plan a trip to "+request.Params.Arguments["destination"])),
			}), nil
		})
	s.AddPrompt(mcp.NewPrompt("broken_prompt"),
		func(context.Context, mcp.GetPromptRequest) (*mcp.GetPromptResult, error) {
			return nil, &ConformanceError{message: "boom"}
		})

	// Returns when standard input closes, as the client leaves.
	_ = server.ServeStdio(s)

	// Go has no hook for a program's end: what is queued goes now or never.
	mcpspan.Shutdown(context.Background())
}
