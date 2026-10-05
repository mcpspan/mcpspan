package core

import (
	"bytes"
	"container/list"
	"crypto/sha256"
	"encoding/json"
	"strings"
	"sync"
)

// Whether a call repeats the previous call to the same tool in the same
// session (contract, 3.9): an agent stuck in a loop. Only the answer leaves
// the process. Kept here is a SHA-256 of the canonical arguments of the latest
// call per session and tool, never sent: a digest of a short identifier or an
// enumerated value is found by trying every one.

// maxKept bounds the session and tool pairs kept, the oldest forgotten first.
const maxKept = 10_000

type repeatKey struct{ session, tool string }

type repeatEntry struct {
	key    repeatKey
	digest [32]byte
}

var (
	repeatsMu sync.Mutex
	repeats   = map[repeatKey]*list.Element{}
	byAge     = list.New()
)

// NoteArguments notes a call's arguments, as the client sent them (any value
// that encodes to JSON, raw JSON included), and says whether they are the
// previous call's to the same tool in the same session. Arguments that cannot
// be written down are never a repeat. It never panics.
func NoteArguments(sessionID, toolName string, arguments any) (repeated bool) {
	defer func() {
		if recover() != nil {
			repeated = false
		}
	}()

	encoded, err := json.Marshal(arguments)
	if err != nil {
		return false
	}
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.UseNumber()
	var value any
	if decoder.Decode(&value) != nil {
		return false
	}
	if value == nil {
		value = map[string]any{}
	}
	var text strings.Builder
	if canonical(&text, value) != nil {
		return false
	}
	digest := sha256.Sum256([]byte(text.String()))

	key := repeatKey{sessionID, toolName}
	repeatsMu.Lock()
	defer repeatsMu.Unlock()
	if element, known := repeats[key]; known {
		entry := element.Value.(*repeatEntry)
		repeated = entry.digest == digest
		entry.digest = digest
		byAge.MoveToBack(element)
		return repeated
	}
	repeats[key] = byAge.PushBack(&repeatEntry{key: key, digest: digest})
	if byAge.Len() > maxKept {
		oldest := byAge.Front()
		byAge.Remove(oldest)
		delete(repeats, oldest.Value.(*repeatEntry).key)
	}
	return false
}

// ContinuesEarlierCall says whether a call's parameters answer an interim
// result's question (2026-07-28): the call then continues the one that asked,
// and is neither compared nor kept.
func ContinuesEarlierCall(params any) bool {
	encoded, err := json.Marshal(params)
	if err != nil {
		return false
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(encoded, &fields) != nil {
		return false
	}
	for _, name := range []string{"inputResponses", "requestState"} {
		if value, present := fields[name]; present && string(value) != "null" && string(value) != `""` {
			return true
		}
	}
	return false
}

// ForgetArguments is for tests: it forgets every call.
func ForgetArguments() {
	repeatsMu.Lock()
	defer repeatsMu.Unlock()
	repeats = map[repeatKey]*list.Element{}
	byAge = list.New()
}
