package core

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"time"
)

// Call is what an integration knows about one tool call as it starts.
type Call struct {
	// Kind is empty for a tool call; KindResource or KindPrompt otherwise.
	Kind       string
	ToolName   string
	Arguments  json.RawMessage
	ClientName string
	// ClientVersion is the version the client gives itself.
	ClientVersion string
	// ServerVersion is the version the server gives itself; the ServerVersion
	// setting wins over it.
	ServerVersion string
	SessionID     string
	Started       time.Time
}

// MaxVersionLength is the longest version the API takes; longer is cut.
const MaxVersionLength = 100

// Begin notes the start of a call. The clock is read here, first.
func Begin(toolName string) Call {
	return Call{ToolName: toolName, Started: time.Now()}
}

// Outcome is how a call ended.
type Outcome struct {
	Success      bool
	ErrorSource  string
	ErrorType    string
	ErrorMessage string
	// Response is the answer the call returned, when it returned one, to be
	// measured (contract, 3.7). Nil when there was none.
	Response any
}

// MaxResponseBytes is the largest size an event carries; anything larger is
// sent as this (contract, 3.7).
const MaxResponseBytes = 2_147_483_647

// ResponseBytes is the size of an answer in bytes of its compact JSON, or nil
// when it cannot be encoded. The JSON is counted and dropped; nothing of it
// is kept or sent. HTML characters are left as they are, as MCP SDKs send
// them, rather than escaped as encoding/json does by default.
func ResponseBytes(response any) *int64 {
	if response == nil {
		return nil
	}
	// A nil pointer in an interface is no answer either, not the four bytes of null.
	if value := reflect.ValueOf(response); value.Kind() == reflect.Pointer && value.IsNil() {
		return nil
	}
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(response); err != nil {
		return nil
	}
	// Encode ends with a newline that is not part of the value.
	size := min(int64(buffer.Len()-1), MaxResponseBytes)
	return &size
}

// Recording reports whether events are being collected, so an integration
// can skip all of its work when they are not.
func Recording() bool {
	r, _ := running()
	return r != nil
}

// Record builds the event for a finished call and queues it. It never
// panics and never blocks on the network.
func Record(call Call, outcome Outcome) {
	defer func() { _ = recover() }()

	r, capture := running()
	if r == nil {
		return
	}
	serverVersion := configuredServerVersion()
	if serverVersion == "" {
		serverVersion = call.ServerVersion
	}

	event := Event{
		ID:         newUUID(),
		Kind:       call.Kind,
		ToolName:   Truncate(call.ToolName, MaxNameLength),
		DurationMs: float64(time.Since(call.Started).Nanoseconds()) / 1e6,
		Success:    outcome.Success,
		ClientType: DetectClient(call.ClientName),
		ClientName: ClientName(call.ClientName),
		// Cut rather than lose the batch: the API refuses a longer one.
		ClientVersion: Truncate(strings.TrimSpace(call.ClientVersion), MaxVersionLength),
		ServerVersion: Truncate(strings.TrimSpace(serverVersion), MaxVersionLength),
		Timestamp:     call.Started.UTC().Format("2006-01-02T15:04:05.000Z"),
		SDKVersion:    Version,
		SessionID:     call.SessionID,
		ErrorSource:   outcome.ErrorSource,
		ErrorType:     outcome.ErrorType,
	}

	if !outcome.Success {
		event.ErrorMessage = outcome.ErrorMessage
	}
	event.ResponseBytes = ResponseBytes(outcome.Response)
	// A tool the server has, refused arguments included: often the schema is why.
	if call.Kind == "" && outcome.ErrorSource != SourceUnknownTool {
		event.DefinitionHash = DefinitionOf(call.ToolName)
	}
	if capture {
		event.Parameters = DescribeParameters(call.Arguments)
	}

	r.record(event)
}

// newUUID makes a random version 4 UUID.
func newUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80

	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

type callKey struct{}

// CallState is shared between an integration's request-level hook and a
// handler wrapped by Track, through the request's context.
type CallState struct {
	// Reached is set when the call got as far as a tracked handler.
	Reached bool
}

// WithCallState attaches a fresh CallState to a request's context.
func WithCallState(ctx context.Context) (context.Context, *CallState) {
	state := &CallState{}
	return context.WithValue(ctx, callKey{}, state), state
}

// CallStateFrom returns the CallState an instrumented server attached, or nil.
func CallStateFrom(ctx context.Context) *CallState {
	state, _ := ctx.Value(callKey{}).(*CallState)
	return state
}
