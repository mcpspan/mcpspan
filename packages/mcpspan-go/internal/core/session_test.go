package core

import (
	"strings"
	"testing"
)

// Not zero-sized on purpose: Go may give two pointers to empty structs the
// same address, and these must be two different servers.
type server struct{ _ byte }

func TestOneSessionForAServerOverStdio(t *testing.T) {
	a, b := &server{}, &server{}

	first := SessionFor(a, false, "")
	if first == "" || SessionFor(a, false, "") != first || SessionFor(b, false, "") == first {
		t.Fatal("not one session per server")
	}
}

func TestFollowsTheTransportSessionOverHTTPWithoutUsingIt(t *testing.T) {
	s := &server{}

	a := SessionFor(s, true, "transport-a")
	if a != SessionFor(s, true, "transport-a") || a == SessionFor(s, true, "transport-b") ||
		strings.Contains(a, "transport-a") {
		t.Fatal("does not follow the transport session")
	}
	if SessionFor(s, true, "") != "" {
		t.Fatal("invented a session over stateless HTTP")
	}
}

func TestForgetsTheOldestIdleSession(t *testing.T) {
	s := &server{}
	first := SessionFor(s, true, "first")
	for i := range MaxSessionsPerServer {
		SessionFor(s, true, "s"+strings.Repeat("x", i%3)+string(rune('a'+i%26))+string(rune(i)))
	}

	if SessionFor(s, true, "first") == first {
		t.Fatal("remembered past the bound")
	}
}
