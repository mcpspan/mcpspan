package core

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// TestDetectsTheContractTable checks the table as cases shared by every SDK's
// tests. A name of null is a client that named itself nowhere, which in Go is
// the empty name.
func TestDetectsTheContractTable(t *testing.T) {
	raw, err := os.ReadFile("../../../../conformance/client-types.json")
	if err != nil {
		t.Fatal(err)
	}
	var table struct {
		Cases [][2]*string `json:"cases"`
	}
	if err := json.Unmarshal(raw, &table); err != nil {
		t.Fatal(err)
	}

	for _, c := range table.Cases {
		name := ""
		if c[0] != nil {
			name = *c[0]
		}
		if got := DetectClient(name); got != *c[1] {
			t.Errorf("%q: got %q, want %q", name, got, *c[1])
		}
	}
}

func TestKeepsTheClientNameButCutsIt(t *testing.T) {
	if got := ClientName(" cursor "); got != "cursor" {
		t.Fatalf("got %q", got)
	}
	if got := ClientName("c" + strings.Repeat("x", 400)); len(got) != MaxNameLength {
		t.Fatalf("got %d characters", len(got))
	}
}
