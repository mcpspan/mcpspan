package mcpsdk

import (
	"context"
	"encoding/json"
	"reflect"
	"regexp"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/yosida95/uritemplate/v3"

	"github.com/mcpspan/mcpspan/packages/mcpspan-go/internal/core"
)

// Resource reads and prompt gets (contract, 3.5).
//
// The official Go SDK keeps its resources, templates and prompts to itself,
// and Go cannot reach in. What it does offer is its own answer to a list:
// the middleware asks the server, through the same handler chain and with
// the request's own metadata, which templates, resources and prompts it has,
// and names the call from that before it runs. A fixed resource is named by
// its URI, a templated read by its template (never the address the client
// sent), an address the server has nothing for by its scheme alone, and a
// prompt by its name. The templates are matched with the library the SDK
// matches them with itself.
//
// The SDK does not check a prompt's required arguments; its handler gets
// what was sent and decides. So there is no refusal of arguments to record
// on this SDK, and a handler's error is the prompt's exception.

// maxListPages bounds how far a list is followed, so a server with a vast
// catalogue costs a read a bounded amount of lookup.
const maxListPages = 20

var scheme = regexp.MustCompile(`^([a-zA-Z][a-zA-Z0-9+.-]*):`)

// schemeOf is the scheme of an address, which is all of an unknown one that
// may be kept: "db://".
func schemeOf(uri string) string {
	if match := scheme.FindStringSubmatch(uri); match != nil {
		return match[1] + "://"
	}
	return "unknown://"
}

func measurePrimitive(ctx context.Context, server *mcp.Server, next mcp.MethodHandler, method string, req mcp.Request) (mcp.Result, error) {
	switch r := req.(type) {
	case *mcp.ReadResourceRequest:
		if r.Params == nil {
			return next(ctx, method, req)
		}
		name, exists, variables := resolveResource(ctx, next, r)
		call, ok := beginPrimitive(server, req, core.KindResource, name, variables)
		if !ok {
			return next(ctx, method, req)
		}
		result, err := next(ctx, method, req)
		read, _ := result.(*mcp.ReadResourceResult)
		settlePrimitive(call, exists, core.SourceUnknownResource, err, read != nil && read.InputRequests != nil, read)
		return result, err

	case *mcp.GetPromptRequest:
		if r.Params == nil {
			return next(ctx, method, req)
		}
		exists := hasPrompt(ctx, next, r)
		var arguments json.RawMessage
		if len(r.Params.Arguments) > 0 {
			arguments, _ = json.Marshal(r.Params.Arguments)
		}
		call, ok := beginPrimitive(server, req, core.KindPrompt, r.Params.Name, arguments)
		if !ok {
			return next(ctx, method, req)
		}
		result, err := next(ctx, method, req)
		got, _ := result.(*mcp.GetPromptResult)
		settlePrimitive(call, exists, core.SourceUnknownPrompt, err, got != nil && got.InputRequests != nil, got)
		return result, err
	}

	return next(ctx, method, req)
}

func beginPrimitive(server *mcp.Server, req mcp.Request, kind, name string, arguments json.RawMessage) (call core.Call, ok bool) {
	defer func() {
		if recover() != nil {
			ok = false
		}
	}()

	call = core.Begin(name)
	call.Kind = kind
	call.Arguments = arguments
	if info := clientOf(req); info != nil {
		call.ClientName, call.ClientVersion = info.Name, info.Version
	}
	call.ServerVersion = serverVersionOf(server)
	call.SessionID = sessionOf(server, req)

	return call, true
}

func settlePrimitive(call core.Call, exists bool, unknown string, err error, interim bool, response any) {
	defer func() { _ = recover() }()

	switch {
	case err != nil && !exists:
		core.Record(call, core.Outcome{ErrorSource: unknown})
	case err != nil:
		errorType, message := core.DescribeError(err)
		core.Record(call, core.Outcome{ErrorSource: core.SourceException, ErrorType: errorType, ErrorMessage: message})
	case interim:
		// An interim answer asking the client for more settles nothing; the retry does.
	default:
		core.Record(call, core.Outcome{Success: true, Response: response})
	}
}

// resolveResource names a read: the fixed resource's URI, the matching
// template with its variables, or the address's scheme when the server has
// neither.
func resolveResource(ctx context.Context, next mcp.MethodHandler, r *mcp.ReadResourceRequest) (name string, exists bool, variables json.RawMessage) {
	defer func() {
		if recover() != nil {
			name, exists, variables = schemeOf(r.Params.URI), false, nil
		}
	}()

	uri := r.Params.URI
	meta := r.Params.Meta

	for _, resource := range listResources(ctx, next, r.Session, meta) {
		if resource.URI == uri {
			return uri, true, nil
		}
	}

	for _, template := range listTemplates(ctx, next, r.Session, meta) {
		parsed, err := uritemplate.New(template.URITemplate)
		if err != nil {
			continue
		}
		values := parsed.Match(uri)
		if values == nil {
			continue
		}
		matched := make(map[string]string, len(values))
		for key, value := range values {
			matched[key] = value.String()
		}
		encoded, _ := json.Marshal(matched)
		return template.URITemplate, true, encoded
	}

	return schemeOf(uri), false, nil
}

func listResources(ctx context.Context, next mcp.MethodHandler, session *mcp.ServerSession, meta mcp.Meta) []*mcp.Resource {
	var found []*mcp.Resource
	cursor := ""
	for page := 0; page < maxListPages; page++ {
		result, err := next(ctx, "resources/list", &mcp.ListResourcesRequest{
			Session: session,
			Params:  &mcp.ListResourcesParams{Meta: meta, Cursor: cursor},
		})
		list, ok := result.(*mcp.ListResourcesResult)
		if err != nil || !ok {
			return found
		}
		found = append(found, list.Resources...)
		if list.NextCursor == "" {
			return found
		}
		cursor = list.NextCursor
	}
	return found
}

func listTemplates(ctx context.Context, next mcp.MethodHandler, session *mcp.ServerSession, meta mcp.Meta) []*mcp.ResourceTemplate {
	var found []*mcp.ResourceTemplate
	cursor := ""
	for page := 0; page < maxListPages; page++ {
		result, err := next(ctx, "resources/templates/list", &mcp.ListResourceTemplatesRequest{
			Session: session,
			Params:  &mcp.ListResourceTemplatesParams{Meta: meta, Cursor: cursor},
		})
		list, ok := result.(*mcp.ListResourceTemplatesResult)
		if err != nil || !ok {
			return found
		}
		found = append(found, list.ResourceTemplates...)
		if list.NextCursor == "" {
			return found
		}
		cursor = list.NextCursor
	}
	return found
}

func hasPrompt(ctx context.Context, next mcp.MethodHandler, r *mcp.GetPromptRequest) (exists bool) {
	defer func() {
		if recover() != nil {
			exists = false
		}
	}()

	cursor := ""
	for page := 0; page < maxListPages; page++ {
		result, err := next(ctx, "prompts/list", &mcp.ListPromptsRequest{
			Session: r.Session,
			Params:  &mcp.ListPromptsParams{Meta: r.Params.Meta, Cursor: cursor},
		})
		list, ok := result.(*mcp.ListPromptsResult)
		if err != nil || !ok {
			return false
		}
		for _, prompt := range list.Prompts {
			if prompt.Name == r.Params.Name {
				return true
			}
		}
		if list.NextCursor == "" {
			return false
		}
		cursor = list.NextCursor
	}
	return false
}

// clientOf is the client named on the request's _meta, else in the session's
// handshake, as the SDK's own accessor reads them.
// serverVersionOf is the version server was built with, the Implementation
// given to mcp.NewServer. The SDK keeps it unexported and offers no accessor,
// so it is read, never written, from where the SDK keeps it; if a version
// moves it, calls go without one rather than with a guess, and
// TestTheServerVersionIsWhereItIsRead fails first.
func serverVersionOf(server *mcp.Server) (version string) {
	defer func() {
		if recover() != nil {
			version = ""
		}
	}()
	if server == nil {
		return ""
	}
	impl := reflect.ValueOf(server).Elem().FieldByName("impl")
	if !impl.IsValid() || impl.Kind() != reflect.Pointer || impl.IsNil() {
		return ""
	}
	field := impl.Elem().FieldByName("Version")
	if !field.IsValid() || field.Kind() != reflect.String {
		return ""
	}
	return field.String()
}

func clientOf(req mcp.Request) *mcp.Implementation {
	switch r := req.(type) {
	case *mcp.ReadResourceRequest:
		return r.ClientInfo()
	case *mcp.GetPromptRequest:
		return r.ClientInfo()
	}
	return nil
}

func sessionOf(server *mcp.Server, req mcp.Request) string {
	if server == nil {
		return ""
	}
	var extra *mcp.RequestExtra
	var session *mcp.ServerSession
	switch r := req.(type) {
	case *mcp.ReadResourceRequest:
		extra, session = r.Extra, r.Session
	case *mcp.GetPromptRequest:
		extra, session = r.Extra, r.Session
	}
	transportSession := ""
	if session != nil {
		transportSession = session.ID()
	}
	return core.SessionFor(server, extra != nil && extra.Header != nil, transportSession)
}
