// Package mcpgo instruments servers built on mcp-go,
// github.com/mark3labs/mcp-go.
//
//	s := server.NewMCPServer("flights", "1.0.0")
//	mcpgo.Instrument(s, mcpspan.Config{APIKey: os.Getenv("MCPSPAN_API_KEY")})
//	defer mcpspan.Shutdown(context.Background())
//
// Every tool on the server is measured, registered before that line or
// after. Calls that reach a tool are seen through mcp-go's tool middleware;
// calls it refuses first, through its hooks.
package mcpgo

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"sync"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	mcpspan "github.com/mcpspan/mcpspan/packages/mcpspan-go"
	"github.com/mcpspan/mcpspan/packages/mcpspan-go/internal/core"
)

var instrumented sync.Map // *server.MCPServer -> struct{}

// pending holds each call in flight on an instrumented server, from the hook
// that sees it start. The hooks are handed the same request pointer, and the
// tool middleware the same context, so a call is found from either.
var (
	byRequest sync.Map // *mcp.CallToolRequest -> *pendingCall
	byContext sync.Map // context.Context -> *pendingCall
)

type pendingCall struct {
	mu       sync.Mutex
	call     core.Call
	ctx      context.Context
	reached  bool
	recorded bool
}

// Instrument measures every tool call the server answers, and returns the
// server.
//
// Given a Config, it applies it, as mcpspan.Configure does; given none, it
// configures from the environment unless mcpspan.Configure ran already.
// Instrumenting the same server twice counts each call once. Hooks the
// server already has are kept. It never panics.
func Instrument(s *server.MCPServer, config ...mcpspan.Config) *server.MCPServer {
	defer func() { _ = recover() }()

	if len(config) > 0 {
		mcpspan.Configure(config[0])
	} else if !core.Collecting() {
		mcpspan.Configure(mcpspan.Config{})
	}

	if s == nil {
		return s
	}

	if _, already := instrumented.LoadOrStore(s, struct{}{}); already {
		return s
	}

	hooks := s.GetHooks()
	if hooks == nil {
		// Options are functions over the server, so one applies as well
		// after construction as during it.
		hooks = &server.Hooks{}
		server.WithHooks(hooks)(s)
	}

	hooks.AddBeforeCallTool(func(ctx context.Context, _ any, request *mcp.CallToolRequest) {
		before(s, ctx, request)
	})
	hooks.AddAfterCallTool(func(_ context.Context, _ any, request *mcp.CallToolRequest, result any) {
		after(request, result)
	})
	hooks.AddOnError(func(_ context.Context, _ any, method mcp.MCPMethod, message any, err error) {
		if method != mcp.MethodToolsCall {
			return
		}
		if request, ok := message.(*mcp.CallToolRequest); ok {
			failed(request, err)
		}
	})

	instrumentPrimitives(s, hooks)

	s.Use(middleware(s))

	return s
}

// Exclude leaves a tool out of the numbers entirely, refused calls to it
// included, and returns the tool as given:
//
//	s.AddTool(mcpgo.Exclude(mcp.NewTool("health_check")), health)
//
// It reads the name from the tool itself, so a rename carries the exclusion
// with it.
func Exclude(tool mcp.Tool) mcp.Tool {
	core.Exclude(tool.Name)
	return tool
}

// Track records every call to one tool handler, for a server Instrument does
// not cover. On an instrumented server it records nothing itself, and each
// call is counted once.
func Track(handler server.ToolHandlerFunc) server.ToolHandlerFunc {
	return func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		if _, instrumentedCall := byContext.Load(ctx); instrumentedCall || !core.Recording() {
			return handler(ctx, request)
		}

		call := begin(nil, ctx, &request)
		if core.Excluded(call.ToolName) {
			return handler(ctx, request)
		}

		result, err := handler(ctx, request)
		recordReached(call, result, err)

		return result, err
	}
}

func before(s *server.MCPServer, ctx context.Context, request *mcp.CallToolRequest) {
	defer func() { _ = recover() }()

	if !core.Recording() || core.Excluded(request.Params.Name) {
		return
	}

	pending := &pendingCall{call: begin(s, ctx, request), ctx: ctx}
	byRequest.Store(request, pending)
	byContext.Store(ctx, pending)
}

func middleware(s *server.MCPServer) server.ToolHandlerMiddleware {
	return func(next server.ToolHandlerFunc) server.ToolHandlerFunc {
		return func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			value, found := byContext.Load(ctx)
			if !found {
				// Not seen by the hooks: excluded, not recording, or called
				// in a way that bypassed them. Measured here, if at all.
				if !core.Recording() || core.Excluded(request.Params.Name) {
					return next(ctx, request)
				}
				call := begin(s, ctx, &request)
				result, err := next(ctx, request)
				recordReached(call, result, err)
				return result, err
			}

			pending := value.(*pendingCall)
			pending.mu.Lock()
			pending.reached = true
			pending.mu.Unlock()

			// What the tool returns goes back unchanged.
			result, err := next(ctx, request)

			if result != nil && result.NeedsInput() && err == nil {
				// Asking the client for more first; the retry that follows
				// comes through here again and settles the call.
				return result, err
			}

			pending.mu.Lock()
			if !pending.recorded {
				pending.recorded = true
				pending.mu.Unlock()
				recordReached(pending.call, result, err)
			} else {
				pending.mu.Unlock()
			}

			return result, err
		}
	}
}

// after sees every call the server answered with a result. One that never
// reached the tool and came back as an error was refused over its
// arguments: input validation is the only thing mcp-go answers that way
// before a tool runs.
func after(request *mcp.CallToolRequest, result any) {
	defer func() { _ = recover() }()

	pending := take(request)
	if pending == nil || pending.reached || pending.recorded {
		return
	}

	if callResult, ok := result.(*mcp.CallToolResult); ok && callResult.IsError {
		// No message: validation text can quote the value that was sent.
		core.Record(pending.call, core.Outcome{ErrorSource: core.SourceArguments})
	}
}

// failed sees every call the server answered with a protocol error.
func failed(request *mcp.CallToolRequest, err error) {
	defer func() { _ = recover() }()

	pending := take(request)
	if pending == nil || pending.reached || pending.recorded {
		return
	}

	if errors.Is(err, server.ErrToolNotFound) {
		core.Record(pending.call, core.Outcome{ErrorSource: core.SourceUnknownTool})
	}
}

func take(request *mcp.CallToolRequest) *pendingCall {
	value, found := byRequest.LoadAndDelete(request)
	if !found {
		return nil
	}

	pending := value.(*pendingCall)
	byContext.Delete(pending.ctx)

	return pending
}

// begin reads what is known about a call as it starts. s is nil when the
// call is seen from a tracked handler, which cannot see the connection.
func begin(s *server.MCPServer, ctx context.Context, request *mcp.CallToolRequest) core.Call {
	call := core.Begin(request.Params.Name)
	call.Arguments = arguments(request)

	session := server.ClientSessionFromContext(ctx)

	call.ClientName, call.ClientVersion = clientOf(request.Params.Meta, session)
	call.ServerVersion = serverVersionOf(s)

	if s != nil {
		transportSession := ""
		if session != nil {
			transportSession = session.SessionID()
		}
		call.SessionID = core.SessionFor(s, request.Header != nil, transportSession)
	}

	return call
}

func arguments(request *mcp.CallToolRequest) json.RawMessage {
	if len(request.Params.RawArguments) > 0 {
		return request.Params.RawArguments
	}

	encoded, err := json.Marshal(request.Params.Arguments)
	if err != nil {
		return nil
	}

	return encoded
}

// clientOf is the client that sent a request, its name and version: from
// the request's _meta on 2026-07-28, else from this session's handshake.
func clientOf(meta *mcp.Meta, session server.ClientSession) (name, version string) {
	if name, version = clientFromMeta(meta); name != "" {
		return name, version
	}
	if withInfo, ok := session.(server.SessionWithClientInfo); ok {
		info := withInfo.GetClientInfo()
		return info.Name, info.Version
	}
	return "", ""
}

// serverVersionOf is the version s was built with, NewMCPServer(name,
// version). mcp-go keeps it unexported and offers no accessor, so it is read,
// never written, from where mcp-go keeps it; if a version moves it, calls go
// without one rather than with a guess, and TestTheServerVersionIsWhereItIsRead
// fails first. Nil for a call seen from a tracked handler, which has no server.
func serverVersionOf(s *server.MCPServer) (version string) {
	defer func() {
		if recover() != nil {
			version = ""
		}
	}()
	if s == nil {
		return ""
	}
	field := reflect.ValueOf(s).Elem().FieldByName("version")
	if !field.IsValid() || field.Kind() != reflect.String {
		return ""
	}
	return field.String()
}

// recordReached records a call that got as far as the tool. mcp-go answers
// an error the handler returns with a protocol error, and a result marked
// IsError as the tool's own report.
func recordReached(call core.Call, result *mcp.CallToolResult, err error) {
	defer func() { _ = recover() }()

	switch {
	case err != nil:
		errorType, message := core.DescribeError(err)
		core.Record(call, core.Outcome{ErrorSource: core.SourceException, ErrorType: errorType, ErrorMessage: message})
	case result != nil && result.IsError:
		core.Record(call, core.Outcome{ErrorSource: core.SourceResult, ErrorMessage: core.ResultText(texts(result)), Response: result})
	case result != nil:
		core.Record(call, core.Outcome{Success: true, Response: result})
	default:
		core.Record(call, core.Outcome{Success: true})
	}
}

func texts(result *mcp.CallToolResult) []string {
	var found []string
	for _, content := range result.Content {
		if text, ok := content.(mcp.TextContent); ok {
			found = append(found, text.Text)
		} else if text, ok := content.(*mcp.TextContent); ok {
			found = append(found, text.Text)
		}
	}

	return found
}
