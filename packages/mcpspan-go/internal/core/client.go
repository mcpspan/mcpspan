package core

import "strings"

// Client types, as the contract names them (section 7).
var knownClients = []struct{ pattern, clientType string }{
	// claude-code before claude, which would otherwise swallow it.
	{"claude-code", "claude-code"},
	{"claude code", "claude-code"},
	{"claude", "claude"},
	{"cursor", "cursor"},
	{"chatgpt", "chatgpt"},
	{"openai", "chatgpt"},
	// The official Inspector sends inspector-cli, which is why names are
	// matched as substrings.
	{"inspector", "mcp-inspector"},
}

// DetectClient derives the client type from the name a client reported:
// case-insensitive substring match, first match wins.
func DetectClient(name string) string {
	lower := strings.ToLower(strings.TrimSpace(name))
	if lower == "" {
		return "unknown"
	}

	for _, known := range knownClients {
		if strings.Contains(lower, known.pattern) {
			return known.clientType
		}
	}

	return "other"
}

// ClientName is the name as reported, cut to what the API takes. A client
// chooses its own name, and one over the limit would lose its whole batch.
func ClientName(name string) string {
	return Truncate(strings.TrimSpace(name), MaxNameLength)
}

// ClientInfoMetaKey is where a request on the 2026-07-28 protocol names its
// client.
const ClientInfoMetaKey = "io.modelcontextprotocol/clientInfo"
