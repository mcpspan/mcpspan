package core

import (
	"container/list"
	"strings"
	"sync"
)

// The listings already sent for each session, so the same answer to
// tools/list is sent once per session (contract, 3.11). A client lists the
// tools at the start of a session and often again; the count that matters is
// the sessions that were shown the tools, not how often they asked.

// maxListingSessions is how many sessions are kept, the oldest forgotten first.
const maxListingSessions = 10_000

var (
	listingsMu sync.Mutex
	sentOrder  = list.New()
	sentBy     = map[string]*list.Element{}
)

type sentListings struct {
	session    string
	signatures map[string]bool
}

// firstListing says whether a listing is new for its session, noting it as
// sent. A listing with no session is always new.
func firstListing(session, signature string) bool {
	if session == "" {
		return true
	}
	listingsMu.Lock()
	defer listingsMu.Unlock()

	element, known := sentBy[session]
	if !known {
		element = sentOrder.PushBack(&sentListings{session: session, signatures: map[string]bool{}})
		sentBy[session] = element
	}
	sent := element.Value.(*sentListings)
	if sent.signatures[signature] {
		return false
	}
	sent.signatures[signature] = true
	sentOrder.MoveToBack(element)
	if sentOrder.Len() > maxListingSessions {
		oldest := sentOrder.Front()
		sentOrder.Remove(oldest)
		delete(sentBy, oldest.Value.(*sentListings).session)
	}
	return true
}

// ForgetListingsSent is for tests: it forgets every listing sent.
func ForgetListingsSent() {
	listingsMu.Lock()
	defer listingsMu.Unlock()
	sentOrder.Init()
	sentBy = map[string]*list.Element{}
}

// maxListedTools is how many tools of a listing are sent (contract, 3.11).
const maxListedTools = 500

// RecordListing records what the server answered to tools/list (contract,
// 3.11): the tools' names, fingerprints and sizes, once per session for the
// same answer. call carries the client, the session and the versions; its
// clock is the moment of the answer. Excluded tools are left out. It never
// panics.
func RecordListing(call Call, tools []ListedTool) {
	defer func() { _ = recover() }()

	r, _, _ := running()
	if r == nil {
		return
	}

	shown := []ListedTool{}
	for _, tool := range tools {
		if Excluded(tool.Name) {
			continue
		}
		tool.Name = Truncate(tool.Name, MaxNameLength)
		shown = append(shown, tool)
		if len(shown) == maxListedTools {
			break
		}
	}
	var signature strings.Builder
	for _, tool := range shown {
		signature.WriteString(tool.Name + "\x00" + tool.DefinitionHash + "\x00")
	}
	if !firstListing(call.SessionID, signature.String()) {
		return
	}

	serverVersion := configuredServerVersion()
	if serverVersion == "" {
		serverVersion = call.ServerVersion
	}
	r.record(Event{
		ID:            newUUID(),
		Kind:          KindListing,
		ToolName:      "tools/list",
		Success:       true,
		ClientType:    "unknown",
		ClientName:    ClientName(call.ClientName),
		ClientVersion: Truncate(strings.TrimSpace(call.ClientVersion), MaxVersionLength),
		ServerVersion: Truncate(strings.TrimSpace(serverVersion), MaxVersionLength),
		Timestamp:     call.Started.UTC().Format("2006-01-02T15:04:05.000Z"),
		SDKVersion:    Version,
		SessionID:     call.SessionID,
		ListedTools:   shown,
	})
}
