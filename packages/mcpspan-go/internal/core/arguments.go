package core

import (
	"bytes"
	"encoding/json"
	"math"
	"sort"
	"strings"
	"unicode/utf8"
)

// Which top-level arguments of a refused call did not match the tool's input
// schema (contract, 3.10).
//
// The server's own refusal is not read: each validation library words it
// differently, and some quote the value the agent sent. The arguments are
// checked here instead, against the schema the server listed, by a small set
// of rules that never fail what they do not understand. Only names the schema
// declares come out, so nothing the client made up, and no value, is sent.

// maxInvalidArguments is how many names are sent at most, per call.
const maxInvalidArguments = 20

// InvalidArguments is the declared names whose arguments fail the schema,
// sorted, at most twenty. The schema is as decoded with json.Number; the
// arguments are as the client sent them. It never panics.
func InvalidArguments(schema any, arguments json.RawMessage) (names []string) {
	defer func() {
		if recover() != nil {
			names = nil
		}
	}()

	rules, isObject := schema.(map[string]any)
	if !isObject {
		return nil
	}
	var values any = map[string]any{}
	if trimmed := bytes.TrimSpace(arguments); len(trimmed) > 0 && !bytes.Equal(trimmed, []byte("null")) {
		decoder := json.NewDecoder(bytes.NewReader(trimmed))
		decoder.UseNumber()
		if decoder.Decode(&values) != nil {
			return nil
		}
	}
	return invalidIn(rules, values)
}

func invalidIn(schema map[string]any, arguments any) []string {
	values, isObject := arguments.(map[string]any)
	if !isObject {
		return nil
	}

	found := map[string]bool{}
	if required, isList := schema["required"].([]any); isList {
		for _, name := range required {
			if text, isText := name.(string); isText {
				if _, present := values[text]; !present {
					found[text] = true
				}
			}
		}
	}
	if properties, isMap := schema["properties"].(map[string]any); isMap {
		for name, rule := range properties {
			if value, present := values[name]; present && !matches(rule, value) {
				found[name] = true
			}
		}
	}

	names := make([]string, 0, len(found))
	for name := range found {
		names = append(names, name)
	}
	sort.Strings(names)
	if len(names) > maxInvalidArguments {
		names = names[:maxInvalidArguments]
	}
	if len(names) == 0 {
		return nil
	}
	return names
}

// matches says whether a value passes a schema under the checks the contract
// lists, and only those.
func matches(schema any, value any) bool {
	if schema == false {
		return false
	}
	rules, isObject := schema.(map[string]any)
	if !isObject {
		return true
	}

	switch kind := rules["type"].(type) {
	case string:
		if !isType(kind, value) {
			return false
		}
	case []any:
		allText, anyMatch := true, false
		for _, name := range kind {
			text, isText := name.(string)
			if !isText {
				allText = false
				break
			}
			if isType(text, value) {
				anyMatch = true
			}
		}
		if allText && !anyMatch {
			return false
		}
	}

	if allowed, isList := rules["enum"].([]any); isList {
		sent, ok := canonicalText(value)
		found := false
		for _, option := range allowed {
			if text, valid := canonicalText(option); ok && valid && text == sent {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	if constant, present := rules["const"]; present {
		want, okWant := canonicalText(constant)
		sent, okSent := canonicalText(value)
		if !okWant || !okSent || want != sent {
			return false
		}
	}

	if number, isNumber := numberOf(value); isNumber {
		if bound, ok := numberOf(rules["minimum"]); ok && number < bound {
			return false
		}
		if bound, ok := numberOf(rules["maximum"]); ok && number > bound {
			return false
		}
		if bound, ok := numberOf(rules["exclusiveMinimum"]); ok && number <= bound {
			return false
		}
		if bound, ok := numberOf(rules["exclusiveMaximum"]); ok && number >= bound {
			return false
		}
	}

	if text, isText := value.(string); isText {
		length := float64(utf8.RuneCountInString(text))
		if bound, ok := numberOf(rules["minLength"]); ok && length < bound {
			return false
		}
		if bound, ok := numberOf(rules["maxLength"]); ok && length > bound {
			return false
		}
	}

	if items, isList := value.([]any); isList {
		count := float64(len(items))
		if bound, ok := numberOf(rules["minItems"]); ok && count < bound {
			return false
		}
		if bound, ok := numberOf(rules["maxItems"]); ok && count > bound {
			return false
		}
		switch rule := rules["items"].(type) {
		case map[string]any, bool:
			for _, item := range items {
				if !matches(rule, item) {
					return false
				}
			}
		}
	}

	if object, isMap := value.(map[string]any); isMap {
		if required, isList := rules["required"].([]any); isList {
			for _, name := range required {
				if text, isText := name.(string); isText {
					if _, present := object[text]; !present {
						return false
					}
				}
			}
		}
		if properties, isMap := rules["properties"].(map[string]any); isMap {
			for name, rule := range properties {
				if item, present := object[name]; present && !matches(rule, item) {
					return false
				}
			}
		}
	}

	return true
}

func isType(kind string, value any) bool {
	switch kind {
	case "string":
		_, ok := value.(string)
		return ok
	case "number":
		_, ok := numberOf(value)
		return ok
	case "integer":
		number, ok := numberOf(value)
		return ok && number == math.Trunc(number)
	case "boolean":
		_, ok := value.(bool)
		return ok
	case "object":
		_, ok := value.(map[string]any)
		return ok
	case "array":
		_, ok := value.([]any)
		return ok
	case "null":
		return value == nil
	default:
		// A type this list does not know is not checked.
		return true
	}
}

// numberOf is a JSON number's value, decoded with json.Number or not.
func numberOf(value any) (float64, bool) {
	var number float64
	switch v := value.(type) {
	case json.Number:
		parsed, err := v.Float64()
		if err != nil {
			return 0, false
		}
		number = parsed
	case float64:
		number = v
	default:
		return 0, false
	}
	return number, !math.IsInf(number, 0) && !math.IsNaN(number)
}

func canonicalText(value any) (string, bool) {
	var out strings.Builder
	if canonical(&out, value) != nil {
		return "", false
	}
	return out.String(), true
}
