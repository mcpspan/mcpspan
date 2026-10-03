package core

// Event is one tool call, in the shape the ingest API takes (contract,
// section 4). Field names follow the wire format. Parameter values are never
// part of it.
type Event struct {
	ID string `json:"id"`
	// Kind is empty for a tool call, and KindResource or KindPrompt for the
	// others (contract, 3.5).
	Kind         string  `json:"kind,omitempty"`
	ToolName     string  `json:"toolName"`
	DurationMs   float64 `json:"durationMs"`
	Success      bool    `json:"success"`
	ErrorSource  string  `json:"errorSource,omitempty"`
	ErrorType    string  `json:"errorType,omitempty"`
	ErrorMessage string  `json:"errorMessage,omitempty"`
	ClientType   string  `json:"clientType"`
	ClientName   string  `json:"clientName,omitempty"`
	// ClientVersion and ServerVersion are as the client and the server give
	// themselves (contract, 3.6).
	ClientVersion string            `json:"clientVersion,omitempty"`
	ServerVersion string            `json:"serverVersion,omitempty"`
	Timestamp     string            `json:"timestamp"`
	SDKVersion    string            `json:"sdkVersion"`
	SessionID     string            `json:"sessionId,omitempty"`
	Parameters    map[string]string `json:"parameters,omitempty"`
}

// Error sources, as the contract names them.
const (
	SourceResult      = "result"
	SourceException   = "exception"
	SourceArguments   = "arguments"
	SourceUnknownTool = "unknown_tool"
	// SourceUnknownResource and SourceUnknownPrompt name a read or a get of
	// something the server does not have.
	SourceUnknownResource = "unknown_resource"
	SourceUnknownPrompt   = "unknown_prompt"
)

// Kinds of call besides tools (contract, 3.5).
const (
	KindResource = "resource"
	KindPrompt   = "prompt"
)

// Version is the SDK's own version, reported in every event and in the
// User-Agent.
const Version = "0.1.0"
