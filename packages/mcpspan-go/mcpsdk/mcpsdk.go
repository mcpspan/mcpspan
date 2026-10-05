// Package mcpsdk instruments servers built on the official MCP Go SDK,
// github.com/modelcontextprotocol/go-sdk.
//
//	server := mcp.NewServer(&mcp.Implementation{Name: "flights"}, nil)
//	mcpsdk.Instrument(server, mcpspan.Config{APIKey: os.Getenv("MCPSPAN_API_KEY")})
//	defer mcpspan.Shutdown(context.Background())
//
// Every tool on the server is measured, registered before that line or after,
// through the SDK's receiving middleware.
package mcpsdk

import (
	"context"
	"errors"
	"strings"
	"sync"

	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	mcpspan "github.com/mcpspan/mcpspan/packages/mcpspan-go"
	"github.com/mcpspan/mcpspan/packages/mcpspan-go/internal/core"
)

var instrumented sync.Map // *mcp.Server -> struct{}

// Instrument measures every tool call the server answers, and returns the
// server.
//
// Given a Config, it applies it, as mcpspan.Configure does; given none, it
// configures from the environment unless mcpspan.Configure ran already.
// Instrumenting the same server twice counts each call once. It never
// panics, and a nil server is returned as it came.
func Instrument(server *mcp.Server, config ...mcpspan.Config) *mcp.Server {
	defer func() { _ = recover() }()

	if len(config) > 0 {
		mcpspan.Configure(config[0])
	} else if !core.Collecting() {
		mcpspan.Configure(mcpspan.Config{})
	}

	if server == nil {
		return server
	}

	if _, already := instrumented.LoadOrStore(server, struct{}{}); !already {
		server.AddReceivingMiddleware(middleware(server))
	}

	return server
}

// Exclude leaves a tool out of the numbers entirely, refused calls to it
// included, and returns the tool as given:
//
//	mcp.AddTool(server, mcpsdk.Exclude(&mcp.Tool{Name: "health_check"}), health)
//
// For tools called by machinery rather than agents: a health check polled
// every few seconds would outnumber everything a person did. It reads the
// name from the tool itself, so a rename carries the exclusion with it.
func Exclude(tool *mcp.Tool) *mcp.Tool {
	if tool != nil {
		core.Exclude(tool.Name)
	}

	return tool
}

// Track records every call to one tool handler, for a server Instrument does
// not cover. On an instrumented server it records nothing itself, and the
// call is counted once; what it adds there is certainty that the call
// reached the handler, rather than being refused before it.
func Track(handler mcp.ToolHandler) mcp.ToolHandler {
	return func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		if state := core.CallStateFrom(ctx); state != nil {
			state.Reached = true
			return handler(ctx, req)
		}

		if !core.Recording() {
			return handler(ctx, req)
		}

		call, ok := begin(nil, req)
		if !ok || core.Excluded(call.ToolName) {
			return handler(ctx, req)
		}

		result, err := handler(ctx, req)
		record(call, true, result, err)

		return result, err
	}
}

// TrackFor is Track for a typed handler, as mcp.AddTool takes.
func TrackFor[In, Out any](handler mcp.ToolHandlerFor[In, Out]) mcp.ToolHandlerFor[In, Out] {
	return func(ctx context.Context, req *mcp.CallToolRequest, input In) (*mcp.CallToolResult, Out, error) {
		if state := core.CallStateFrom(ctx); state != nil {
			state.Reached = true
			return handler(ctx, req, input)
		}

		if !core.Recording() {
			return handler(ctx, req, input)
		}

		call, ok := begin(nil, req)
		if !ok || core.Excluded(call.ToolName) {
			return handler(ctx, req, input)
		}

		result, output, err := handler(ctx, req, input)
		record(call, true, result, err)

		return result, output, err
	}
}

func middleware(server *mcp.Server) mcp.Middleware {
	return func(next mcp.MethodHandler) mcp.MethodHandler {
		return func(ctx context.Context, method string, req mcp.Request) (mcp.Result, error) {
			if !core.Recording() {
				return next(ctx, method, req)
			}
			if method == "resources/read" || method == "prompts/get" {
				return measurePrimitive(ctx, server, next, method, req)
			}
			if method == "tools/list" {
				result, err := next(ctx, method, req)
				if listing, ok := result.(*mcp.ListToolsResult); ok && err == nil {
					core.NoteListing(listing.Tools)
				}
				return result, err
			}
			if method != "tools/call" {
				return next(ctx, method, req)
			}

			request, isCall := req.(*mcp.CallToolRequest)
			if !isCall {
				return next(ctx, method, req)
			}

			call, ok := begin(server, request)
			if !ok || core.Excluded(call.ToolName) {
				return next(ctx, method, req)
			}

			ctx, state := core.WithCallState(ctx)

			// What the server answers or returns goes back unchanged. This
			// only looks at it on its way past.
			result, err := next(ctx, method, req)

			callResult, _ := result.(*mcp.CallToolResult)
			record(call, state.Reached, callResult, err)

			return result, err
		}
	}
}

// begin reads what is known about a call as it starts. server is nil when
// the call is seen from a tracked handler, which cannot see the connection.
func begin(server *mcp.Server, req *mcp.CallToolRequest) (call core.Call, ok bool) {
	defer func() {
		if recover() != nil {
			ok = false
		}
	}()

	if req == nil || req.Params == nil {
		return core.Call{}, false
	}

	call = core.Begin(req.Params.Name)
	call.Arguments = req.Params.Arguments

	// The request's _meta on 2026-07-28, else this session's handshake: the
	// SDK's own accessor reads them in that order.
	if info := req.ClientInfo(); info != nil {
		call.ClientName, call.ClientVersion = info.Name, info.Version
	}
	call.ServerVersion = serverVersionOf(server)

	if server != nil {
		overHTTP := req.Extra != nil && req.Extra.Header != nil
		transportSession := ""
		if req.Session != nil {
			transportSession = req.Session.ID()
		}
		call.SessionID = core.SessionFor(server, overHTTP, transportSession)
	}

	return call, true
}

// argumentsRefused is how the SDK prefixes a refusal of a call's arguments.
// The refusal reaches the middleware as an error result like any other, with
// the validator's own error wrapped in plain text, so this prefix is the only
// thing that tells it apart from an error the handler returned. It is
// checked only when nothing showed that the handler ran, and the
// conformance suite fails if the SDK ever changes it.
const argumentsRefused = `validating "arguments"`

// record turns how a call ended into an event. It never panics.
func record(call core.Call, reached bool, result *mcp.CallToolResult, err error) {
	defer func() { _ = recover() }()

	if err != nil {
		var wire *jsonrpc.Error
		if !reached && errors.As(err, &wire) && wire.Code == jsonrpc.CodeInvalidParams &&
			strings.HasPrefix(wire.Message, "unknown tool") {
			// No message: the name asked for is already the event's own.
			core.Record(call, core.Outcome{ErrorSource: core.SourceUnknownTool})
			return
		}

		errorType, message := core.DescribeError(err)
		core.Record(call, core.Outcome{ErrorSource: core.SourceException, ErrorType: errorType, ErrorMessage: message})
		return
	}

	if result == nil {
		core.Record(call, core.Outcome{Success: true})
		return
	}

	if result.InputRequests != nil {
		// Asking the client for more first. The call is recorded when a
		// final result settles it.
		return
	}

	if !result.IsError {
		core.Record(call, core.Outcome{Success: true, Response: result})
		return
	}

	if returned := result.GetError(); returned != nil {
		if !reached && strings.HasPrefix(returned.Error(), argumentsRefused) {
			// No message: validation text can quote the value that was sent.
			core.Record(call, core.Outcome{ErrorSource: core.SourceArguments})
			return
		}

		errorType, message := core.DescribeError(returned)
		core.Record(call, core.Outcome{ErrorSource: core.SourceException, ErrorType: errorType, ErrorMessage: message})
		return
	}

	core.Record(call, core.Outcome{ErrorSource: core.SourceResult, ErrorMessage: core.ResultText(texts(result)), Response: result})
}

// texts are the text blocks of a result, and nothing else.
func texts(result *mcp.CallToolResult) []string {
	var found []string
	for _, content := range result.Content {
		if text, ok := content.(*mcp.TextContent); ok {
			found = append(found, text.Text)
		}
	}

	return found
}
