package core

import (
	"sync"
)

// MaxSessionsPerServer bounds how many connections are remembered per
// server. Past it the oldest idle one is forgotten.
const MaxSessionsPerServer = 1_000

// maxServers bounds how many server objects are remembered at all. A program
// that builds a server per connection would otherwise keep every one of them
// alive here; past this the one seen least recently is forgotten.
const maxServers = 1_000

type serverSessions struct {
	ids   map[string]string
	order []string
}

var (
	sessionsMu  sync.Mutex
	sessions    = map[any]*serverSessions{}
	serverOrder []any
)

// SessionFor is our identifier for the connection a request arrived on, or
// "" for none. server is the MCP server object, compared by identity.
//
//   - Over HTTP with a transport session: one identifier per session.
//   - Over HTTP without one (stateless, and every endpoint on 2026-07-28,
//     which has no sessions): none, since each request may reach a fresh
//     server and every call would otherwise be a session of its own.
//   - Anything else, as stdio, is one connection for the server's life.
//
// The identifier is random and never derived from the transport's own,
// which travels in HTTP headers and would let server logs be joined to it.
func SessionFor(server any, overHTTP bool, transportSession string) string {
	if overHTTP && transportSession == "" {
		return ""
	}

	sessionsMu.Lock()
	defer sessionsMu.Unlock()

	known := sessions[server]
	if known == nil {
		known = &serverSessions{ids: map[string]string{}}
		sessions[server] = known
		serverOrder = append(serverOrder, server)

		if len(serverOrder) > maxServers {
			delete(sessions, serverOrder[0])
			serverOrder = serverOrder[1:]
		}
	}

	if id, ok := known.ids[transportSession]; ok {
		known.touch(transportSession)
		return id
	}

	id := newUUID()
	known.ids[transportSession] = id
	known.order = append(known.order, transportSession)

	if len(known.order) > MaxSessionsPerServer {
		oldest := known.order[0]
		known.order = known.order[1:]
		delete(known.ids, oldest)
	}

	return id
}

func (s *serverSessions) touch(key string) {
	for i, candidate := range s.order {
		if candidate == key {
			s.order = append(append(s.order[:i:i], s.order[i+1:]...), key)
			return
		}
	}
}
