package core

import (
	"bytes"
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

func TestInvalidArgumentsAsEverySDKFindsThem(t *testing.T) {
	raw, err := os.ReadFile("../../../../conformance/argument-checks.json")
	if err != nil {
		t.Fatal(err)
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var shared struct {
		Cases []struct {
			Case      string          `json:"case"`
			Schema    any             `json:"schema"`
			Arguments json.RawMessage `json:"arguments"`
			Invalid   []string        `json:"invalid"`
		} `json:"cases"`
	}
	if err := decoder.Decode(&shared); err != nil {
		t.Fatal(err)
	}

	for _, entry := range shared.Cases {
		got := InvalidArguments(entry.Schema, entry.Arguments)
		if len(got) == 0 && len(entry.Invalid) == 0 {
			continue
		}
		if !reflect.DeepEqual(got, entry.Invalid) {
			t.Errorf("%s: got %v, want %v", entry.Case, got, entry.Invalid)
		}
	}
}

func TestFindsNothingWithoutASchema(t *testing.T) {
	if got := InvalidArguments(nil, json.RawMessage(`{"passengers":2}`)); got != nil {
		t.Fatalf("got %v", got)
	}
}
