package core

import "strings"

// ClientName is the name as reported, cut to what the API takes. The mcpspan
// server tells clients apart by it (contract, 7). A client chooses its own
// name, and one over the limit would lose its whole batch.
func ClientName(name string) string {
	return Truncate(strings.TrimSpace(name), MaxNameLength)
}

// ClientInfoMetaKey is where a request on the 2026-07-28 protocol names its
// client.
const ClientInfoMetaKey = "io.modelcontextprotocol/clientInfo"
