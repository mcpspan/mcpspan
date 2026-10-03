package mcpgo

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"regexp"
	"sync"
	"unsafe"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/mcpspan/mcpspan/packages/mcpspan-go/internal/core"
)

// Resource reads and prompt gets (contract, 3.5), through mcp-go's hooks.
//
// Before a read or a get, the call is named: a fixed resource by its URI
// (from the server's public ListResources, or the session's own resources),
// a templated read by its template (the session's templates, or the
// server's), an address the server has nothing for by its scheme alone, a
// prompt by its name. What the server has none of is told by the errors
// mcp-go documents for it, ErrResourceNotFound and ErrPromptNotFound.
//
// The server's own templates are the one thing mcp-go keeps without a way
// to list them. They are read, under the server's own lock and never
// written, from where it keeps them; if a version moves them, a templated
// read is named by its scheme instead, which keeps the address private and
// is plainly visible in the dashboard. primitives_test.go fails first.

var primitiveCalls sync.Map // request pointer -> *pendingPrimitive

type pendingPrimitive struct {
	call core.Call
}

var scheme = regexp.MustCompile(`^([a-zA-Z][a-zA-Z0-9+.-]*):`)

// schemeOf is the scheme of an address, which is all of an unknown one that
// may be kept: "db://".
func schemeOf(uri string) string {
	if match := scheme.FindStringSubmatch(uri); match != nil {
		return match[1] + "://"
	}
	return "unknown://"
}

func instrumentPrimitives(s *server.MCPServer, hooks *server.Hooks) {
	hooks.AddBeforeReadResource(func(ctx context.Context, _ any, request *mcp.ReadResourceRequest) {
		defer func() { _ = recover() }()
		if !core.Recording() {
			return
		}
		name, variables := nameResource(s, ctx, request.Params.URI)
		primitiveCalls.Store(request, &pendingPrimitive{call: beginPrimitive(s, ctx, request.Header != nil, core.KindResource, name, variables, request.Params.Meta)})
	})
	hooks.AddAfterReadResource(func(_ context.Context, _ any, request *mcp.ReadResourceRequest, _ *mcp.ReadResourceResult) {
		settlePrimitive(request, nil, "")
	})
	hooks.AddBeforeGetPrompt(func(ctx context.Context, _ any, request *mcp.GetPromptRequest) {
		defer func() { _ = recover() }()
		if !core.Recording() {
			return
		}
		var arguments json.RawMessage
		if len(request.Params.Arguments) > 0 {
			arguments, _ = json.Marshal(request.Params.Arguments)
		}
		primitiveCalls.Store(request, &pendingPrimitive{call: beginPrimitive(s, ctx, request.Header != nil, core.KindPrompt, request.Params.Name, arguments, request.Params.Meta)})
	})
	hooks.AddAfterGetPrompt(func(_ context.Context, _ any, request *mcp.GetPromptRequest, _ *mcp.GetPromptResult) {
		settlePrimitive(request, nil, "")
	})
	hooks.AddOnError(func(_ context.Context, _ any, method mcp.MCPMethod, message any, err error) {
		switch method {
		case mcp.MethodResourcesRead:
			if request, ok := message.(*mcp.ReadResourceRequest); ok {
				unknown := ""
				if errors.Is(err, server.ErrResourceNotFound) {
					unknown = schemeOf(request.Params.URI)
				}
				settlePrimitive(request, err, unknown)
			}
		case mcp.MethodPromptsGet:
			if request, ok := message.(*mcp.GetPromptRequest); ok {
				unknown := ""
				if errors.Is(err, server.ErrPromptNotFound) {
					unknown = request.Params.Name
				}
				settlePrimitive(request, err, unknown)
			}
		}
	})
}

func beginPrimitive(s *server.MCPServer, ctx context.Context, overHTTP bool, kind, name string, arguments json.RawMessage, meta *mcp.Meta) core.Call {
	call := core.Begin(name)
	call.Kind = kind
	call.Arguments = arguments

	session := server.ClientSessionFromContext(ctx)
	call.ClientName, call.ClientVersion = clientOf(meta, session)
	call.ServerVersion = serverVersionOf(s)

	transportSession := ""
	if session != nil {
		transportSession = session.SessionID()
	}
	call.SessionID = core.SessionFor(s, overHTTP, transportSession)

	return call
}

// settlePrimitive records a read or a get once the server has answered it.
// unknown is the name to record it under when the server had no such thing.
func settlePrimitive(request any, err error, unknown string) {
	defer func() { _ = recover() }()

	value, found := primitiveCalls.LoadAndDelete(request)
	if !found {
		return
	}
	call := value.(*pendingPrimitive).call

	switch {
	case err == nil:
		core.Record(call, core.Outcome{Success: true})
	case unknown != "":
		call.ToolName = unknown
		call.Arguments = nil
		source := core.SourceUnknownPrompt
		if call.Kind == core.KindResource {
			source = core.SourceUnknownResource
		}
		core.Record(call, core.Outcome{ErrorSource: source})
	default:
		// mcp-go hands its hooks the handler's error inside a wrapper of its
		// own; the handler's error is what is worth naming.
		if inner := errors.Unwrap(err); inner != nil && reflect.TypeOf(err).String() == "*server.requestError" {
			err = inner
		}
		errorType, message := core.DescribeError(err)
		core.Record(call, core.Outcome{ErrorSource: core.SourceException, ErrorType: errorType, ErrorMessage: message})
	}
}

// nameResource names a read before it runs, and returns a template's
// variables. An address matching nothing is named by its scheme here too;
// whether the server had it is settled by its answer.
func nameResource(s *server.MCPServer, ctx context.Context, uri string) (string, json.RawMessage) {
	session := server.ClientSessionFromContext(ctx)

	if withResources, ok := session.(server.SessionWithResources); ok {
		if _, found := withResources.GetSessionResources()[uri]; found {
			return uri, nil
		}
	}
	if _, found := s.ListResources()[uri]; found {
		return uri, nil
	}

	var templates []*mcp.URITemplate
	if withTemplates, ok := session.(server.SessionWithResourceTemplates); ok {
		for _, entry := range withTemplates.GetSessionResourceTemplates() {
			templates = append(templates, entry.Template.URITemplate)
		}
	}
	templates = append(templates, serverTemplates(s)...)

	for _, template := range templates {
		if template == nil || template.Template == nil || !template.Regexp().MatchString(uri) {
			continue
		}
		variables := make(map[string]string)
		for key, value := range template.Match(uri) {
			variables[key] = value.String()
		}
		encoded, _ := json.Marshal(variables)
		return template.Raw(), encoded
	}

	return schemeOf(uri), nil
}

// serverTemplates reads the server's resource templates where mcp-go keeps
// them, under its own read lock. Nothing is written. Nil if a version keeps
// them elsewhere.
func serverTemplates(s *server.MCPServer) (found []*mcp.URITemplate) {
	defer func() {
		if recover() != nil {
			found = nil
		}
	}()

	value := reflect.ValueOf(s).Elem()
	lockField := value.FieldByName("resourcesMu")
	mapField := value.FieldByName("resourceTemplates")
	if !lockField.IsValid() || !mapField.IsValid() || lockField.Type() != reflect.TypeOf(sync.RWMutex{}) {
		return nil
	}

	lock := (*sync.RWMutex)(unsafe.Pointer(lockField.UnsafeAddr()))
	lock.RLock()
	defer lock.RUnlock()

	entries := reflect.NewAt(mapField.Type(), unsafe.Pointer(mapField.UnsafeAddr())).Elem()
	if entries.Kind() != reflect.Map {
		return nil
	}
	for iterator := entries.MapRange(); iterator.Next(); {
		entry := reflect.New(iterator.Value().Type()).Elem()
		entry.Set(iterator.Value())
		templateField := entry.FieldByName("template")
		if !templateField.IsValid() {
			return nil
		}
		template, ok := reflect.NewAt(templateField.Type(), unsafe.Pointer(templateField.UnsafeAddr())).Elem().Interface().(mcp.ResourceTemplate)
		if ok && template.URITemplate != nil {
			found = append(found, template.URITemplate)
			continue
		}
	}
	return found
}

// clientFromMeta is the client a request names on its _meta, on 2026-07-28.
// clientFromMeta is the client a request names in its _meta on 2026-07-28:
// its name and version, empty when it names none.
func clientFromMeta(meta *mcp.Meta) (name, version string) {
	if meta == nil {
		return "", ""
	}
	info, ok := meta.AdditionalFields[core.ClientInfoMetaKey].(map[string]any)
	if !ok {
		return "", ""
	}
	name, _ = info["name"].(string)
	version, _ = info["version"].(string)
	return name, version
}
