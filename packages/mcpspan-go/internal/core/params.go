package core

import (
	"bytes"
	"encoding/json"
)

// MaxDescribedParameters bounds how many parameters one call describes, so a
// tool taking a very wide object cannot turn one event into a large one.
const MaxDescribedParameters = 50

// DescribeParameters lists the top-level parameters of a call's arguments,
// as the client sent them, by name and JSON type only. Values are skipped
// over unread. Nil when there are none, or when the arguments are not an
// object.
func DescribeParameters(raw json.RawMessage) map[string]string {
	decoder := json.NewDecoder(bytes.NewReader(raw))

	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		return nil
	}

	described := map[string]string{}

	for decoder.More() && len(described) < MaxDescribedParameters {
		key, err := decoder.Token()
		if err != nil {
			return nil
		}

		name, ok := key.(string)
		if !ok {
			return nil
		}

		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil
		}

		described[Truncate(name, MaxNameLength)] = jsonType(value)
	}

	if len(described) == 0 {
		return nil
	}

	return described
}

// jsonType names a JSON value's type from its first byte, without reading
// the value itself.
func jsonType(value json.RawMessage) string {
	trimmed := bytes.TrimSpace(value)
	if len(trimmed) == 0 {
		return "null"
	}

	switch trimmed[0] {
	case '"':
		return "string"
	case '{':
		return "object"
	case '[':
		return "array"
	case 't', 'f':
		return "boolean"
	case 'n':
		return "null"
	default:
		return "number"
	}
}
