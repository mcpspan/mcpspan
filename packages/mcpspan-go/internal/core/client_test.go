package core

import (
	"strings"
	"testing"
)

func TestKeepsTheClientNameButCutsIt(t *testing.T) {
	if got := ClientName(" cursor "); got != "cursor" {
		t.Fatalf("got %q", got)
	}
	if got := ClientName("c" + strings.Repeat("x", 400)); len(got) != MaxNameLength {
		t.Fatalf("got %d characters", len(got))
	}
}
