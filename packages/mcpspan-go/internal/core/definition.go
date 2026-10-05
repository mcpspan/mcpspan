package core

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"
)

// Tool definitions as the server lists them, fingerprinted (contract, 3.8).
// Rewording a description can change how agents use a tool more than a change
// to its code. The fingerprint is taken from the answer to tools/list, what an
// agent actually read, and sent with every call to the tool. Kept for the
// process: one process reports to one server.

var (
	listedMu sync.RWMutex
	listed   = map[string]string{}
)

// DefinitionOf is the latest fingerprint listed for a tool, or "" when no
// listing in this process named it.
func DefinitionOf(toolName string) string {
	listedMu.RLock()
	defer listedMu.RUnlock()
	return listed[toolName]
}

// NoteListing notes every tool in a listing: anything that encodes to a JSON
// array of tools in the wire's spelling, such as the SDK's own tool slice. It
// never panics.
func NoteListing(tools any) {
	defer func() { _ = recover() }()

	encoded, err := json.Marshal(tools)
	if err != nil {
		return
	}
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.UseNumber()
	var wire []map[string]any
	if decoder.Decode(&wire) != nil {
		return
	}

	listedMu.Lock()
	defer listedMu.Unlock()
	for _, tool := range wire {
		name, isText := tool["name"].(string)
		if !isText {
			continue
		}
		if fingerprint, ok := DefinitionHash(tool); ok {
			listed[name] = fingerprint
		}
	}
}

// ForgetListings is for tests: it forgets every listing.
func ForgetListings() {
	listedMu.Lock()
	defer listedMu.Unlock()
	listed = map[string]string{}
}

// DefinitionHash is the first 16 hex characters of the SHA-256 of the tool's
// name, title, description and input schema, as canonical JSON. Numbers are
// expected as json.Number, which keeps integers exact.
func DefinitionHash(tool map[string]any) (string, bool) {
	hashed := map[string]any{}
	for _, field := range []string{"name", "title", "description", "inputSchema"} {
		if value, present := tool[field]; present && value != nil {
			hashed[field] = value
		}
	}
	var out strings.Builder
	if err := canonical(&out, hashed); err != nil {
		return "", false
	}
	sum := sha256.Sum256([]byte(out.String()))
	return hex.EncodeToString(sum[:])[:16], true
}

// canonical writes sorted keys, no whitespace and minimal escaping: the same
// text in every SDK.
func canonical(out *strings.Builder, value any) error {
	switch v := value.(type) {
	case nil:
		out.WriteString("null")
	case bool:
		out.WriteString(strconv.FormatBool(v))
	case json.Number:
		if integer, err := v.Int64(); err == nil {
			out.WriteString(strconv.FormatInt(integer, 10))
			return nil
		}
		number, err := v.Float64()
		if err != nil {
			return err
		}
		if number == float64(int64(number)) {
			out.WriteString(strconv.FormatInt(int64(number), 10))
		} else {
			out.WriteString(strconv.FormatFloat(number, 'g', -1, 64))
		}
	case float64:
		return canonical(out, json.Number(strconv.FormatFloat(v, 'g', -1, 64)))
	case string:
		text(out, v)
	case []any:
		out.WriteByte('[')
		for i, item := range v {
			if i > 0 {
				out.WriteByte(',')
			}
			if err := canonical(out, item); err != nil {
				return err
			}
		}
		out.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(v))
		for key := range v {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		out.WriteByte('{')
		for i, key := range keys {
			if i > 0 {
				out.WriteByte(',')
			}
			text(out, key)
			out.WriteByte(':')
			if err := canonical(out, v[key]); err != nil {
				return err
			}
		}
		out.WriteByte('}')
	default:
		return fmt.Errorf("cannot fingerprint %T", value)
	}
	return nil
}

func text(out *strings.Builder, value string) {
	out.WriteByte('"')
	for _, character := range value {
		switch character {
		case '"':
			out.WriteString(`\"`)
		case '\\':
			out.WriteString(`\\`)
		case '\b':
			out.WriteString(`\b`)
		case '\f':
			out.WriteString(`\f`)
		case '\n':
			out.WriteString(`\n`)
		case '\r':
			out.WriteString(`\r`)
		case '\t':
			out.WriteString(`\t`)
		default:
			if character < 0x20 {
				fmt.Fprintf(out, `\u%04x`, character)
			} else {
				out.WriteRune(character)
			}
		}
	}
	out.WriteByte('"')
}
