package core

import (
	"bytes"
	"encoding/json"
	"os"
	"strconv"
	"testing"
)

func TestResponseBytesCountsCompactJSONWithoutEscapingHTML(t *testing.T) {
	answer := map[string]any{"content": []any{map[string]any{"type": "text", "text": "<b>Zażółć ✈️</b> & co"}}}
	want := int64(len(`{"content":[{"text":"<b>Zażółć ✈️</b> & co","type":"text"}]}`))

	got := ResponseBytes(answer)
	if got == nil || *got != want {
		t.Fatalf("got %v, want %d", got, want)
	}
}

func TestResponseBytesHasNothingForNoAnswer(t *testing.T) {
	var none *struct{ Text string }
	for _, answer := range []any{nil, none, make(chan int)} {
		if got := ResponseBytes(answer); got != nil {
			t.Fatalf("%T: got %d, want nothing", answer, *got)
		}
	}
}

func TestDefinitionHashMatchesTheSharedCases(t *testing.T) {
	raw, err := os.ReadFile("../../../../conformance/definition-hashes.json")
	if err != nil {
		t.Fatal(err)
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var shared struct {
		Cases []struct {
			Case string         `json:"case"`
			Tool map[string]any `json:"tool"`
			Hash string         `json:"hash"`
		} `json:"cases"`
	}
	if err := decoder.Decode(&shared); err != nil {
		t.Fatal(err)
	}
	for _, c := range shared.Cases {
		if got, ok := DefinitionHash(c.Tool); !ok || got != c.Hash {
			t.Errorf("%s: got %q, want %q", c.Case, got, c.Hash)
		}
	}
}

func TestNoteListingKeepsTheLatestFingerprintOfEachTool(t *testing.T) {
	defer ForgetListings()
	NoteListing([]map[string]any{{"name": "a", "description": "one"}, {"name": "b"}})
	NoteListing([]map[string]any{{"name": "a", "description": "two"}, {"description": "nameless"}})
	NoteListing(make(chan int))

	want, _ := DefinitionHash(map[string]any{"name": "a", "description": "two"})
	if got := DefinitionOf("a"); got != want {
		t.Fatalf("a: got %q, want %q", got, want)
	}
	if DefinitionOf("b") == "" || DefinitionOf("c") != "" {
		t.Fatalf("b %q, c %q", DefinitionOf("b"), DefinitionOf("c"))
	}
}

func TestNoteArgumentsTellsARepeatWhateverTheKeyOrder(t *testing.T) {
	defer ForgetArguments()
	steps := []struct {
		session, tool string
		arguments     any
		want          bool
	}{
		{"s1", "search", json.RawMessage(`{"to":"WAW","n":2}`), false},
		{"s1", "search", map[string]any{"n": 2, "to": "WAW"}, true},
		{"s1", "search", json.RawMessage(`{"to":"KRK","n":2}`), false},
		{"s1", "book", json.RawMessage(`{"to":"KRK","n":2}`), false},
		{"s2", "search", json.RawMessage(`{"to":"KRK","n":2}`), false},
		{"s1", "list", nil, false},
		{"s1", "list", map[string]any{}, true},
		{"s1", "odd", make(chan int), false},
		{"s1", "odd", make(chan int), false},
	}
	for i, step := range steps {
		if got := NoteArguments(step.session, step.tool, step.arguments); got != step.want {
			t.Fatalf("step %d: got %v, want %v", i, got, step.want)
		}
	}
}

func TestNoteArgumentsForgetsTheOldestPastItsBound(t *testing.T) {
	defer ForgetArguments()
	NoteArguments("first", "search", map[string]any{"to": "WAW"})
	for i := 0; i < maxKept; i++ {
		NoteArguments(strconv.Itoa(i), "search", nil)
	}
	if NoteArguments("first", "search", map[string]any{"to": "WAW"}) {
		t.Fatal("a forgotten pair still counted as a repeat")
	}
}

func TestContinuesEarlierCallKnowsARetryAnsweringAQuestion(t *testing.T) {
	if !ContinuesEarlierCall(map[string]any{"name": "a", "requestState": "x"}) ||
		!ContinuesEarlierCall(map[string]any{"inputResponses": map[string]any{"q": 1}}) ||
		ContinuesEarlierCall(map[string]any{"name": "a", "requestState": ""}) ||
		ContinuesEarlierCall(map[string]any{"name": "a"}) {
		t.Fatal("misread a retry")
	}
}
