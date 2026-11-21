package mcpgo2

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// mcp-go v2 changed its module path and little else that mcpspan reads, so
// this package is ../mcpgo with the imports moved to /v2. The files here are
// made from those there, never edited by hand: a fix goes into ../mcpgo, and
//
//	MCPSPAN_REGENERATE=1 go test -run TestGeneratedFromMcpgo .
//
// writes it here. Without the variable the test fails when a file has fallen
// behind, so a fix cannot reach one mcp-go and miss the other.
func TestGeneratedFromMcpgo(t *testing.T) {
	sources, err := filepath.Glob(filepath.Join("..", "mcpgo", "*.go"))
	if err != nil || len(sources) == 0 {
		t.Fatalf("no sources in ../mcpgo: %v", err)
	}

	regenerate := os.Getenv("MCPSPAN_REGENERATE") == "1"
	for _, source := range sources {
		original, err := os.ReadFile(source)
		if err != nil {
			t.Fatal(err)
		}

		name := filepath.Base(source)
		want := generate(string(original))
		if regenerate {
			if err := os.WriteFile(name, []byte(want), 0o644); err != nil {
				t.Fatal(err)
			}
			continue
		}

		got, err := os.ReadFile(name)
		if err != nil || string(got) != want {
			t.Errorf("%s is not what ../mcpgo/%s makes; run MCPSPAN_REGENERATE=1 go test -run TestGeneratedFromMcpgo .", name, name)
		}
	}
}

func generate(source string) string {
	source = strings.NewReplacer(
		"github.com/mark3labs/mcp-go/", "github.com/mark3labs/mcp-go/v2/",
		"packages/mcpspan-go/mcpgo\"", "packages/mcpspan-go/mcpgo2\"",
		"Package mcpgo instruments servers built on mcp-go,\n// github.com/mark3labs/mcp-go.",
		"Package mcpgo2 instruments servers built on mcp-go v2,\n// github.com/mark3labs/mcp-go/v2.",
		"package mcpgo\n", "package mcpgo2\n",
		"mcpgo.", "mcpgo2.",
	).Replace(source)

	return "// Code generated from ../mcpgo by generated_test.go. DO NOT EDIT.\n\n" + source
}
