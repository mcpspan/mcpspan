package mcpspan_test

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// The README's samples, checked against the packages they use: each must
// parse, and every mcpspan, mcpsdk or mcpgo name in it must exist, so a
// rename that misses the documentation fails here rather than on somebody
// else's machine.
func TestReadmeSamplesUseOnlyWhatExists(t *testing.T) {
	readme, err := os.ReadFile("README.md")
	if err != nil {
		t.Fatal(err)
	}

	exported := map[string]map[string]bool{
		"mcpspan": exportedNames(t, "."),
		"mcpsdk":  exportedNames(t, "mcpsdk"),
		"mcpgo":   exportedNames(t, "mcpgo"),
	}

	samples := regexp.MustCompile("(?s)```go\n(.*?)```").FindAllStringSubmatch(string(readme), -1)
	if len(samples) < 6 {
		t.Fatalf("found %d samples", len(samples))
	}

	for _, sample := range samples {
		source := sample[1]
		if !strings.HasPrefix(source, "package ") {
			source = "package sample\nfunc _() {\n" + source + "\n}\n"
		}

		file, err := parser.ParseFile(token.NewFileSet(), "sample.go", source, 0)
		if err != nil {
			t.Errorf("sample does not parse: %v\n%s", err, sample[1])
			continue
		}

		ast.Inspect(file, func(node ast.Node) bool {
			selector, ok := node.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			if pkg, ok := selector.X.(*ast.Ident); ok && exported[pkg.Name] != nil && !exported[pkg.Name][selector.Sel.Name] {
				t.Errorf("README uses %s.%s, which does not exist", pkg.Name, selector.Sel.Name)
			}
			return true
		})
	}
}

func exportedNames(t *testing.T, dir string) map[string]bool {
	t.Helper()

	names := map[string]bool{}
	files, _ := filepath.Glob(filepath.Join(dir, "*.go"))
	for _, path := range files {
		if strings.HasSuffix(path, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(token.NewFileSet(), path, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		for name, object := range file.Scope.Objects {
			if ast.IsExported(name) {
				_ = object
				names[name] = true
			}
		}
	}

	return names
}
