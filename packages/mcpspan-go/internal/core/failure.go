package core

import (
	"errors"
	"reflect"
	"strings"
	"unicode/utf8"
)

// Limits the ingest API enforces. A batch holding one field over its limit
// is refused whole, so everything that comes from outside the developer's
// control is cut before it is sent.
const (
	MaxNameLength             = 200
	MaxExceptionMessageLength = 500
	MaxResultMessageLength    = 200
)

// Truncate cuts text to a limit in characters, leaving a visible sign that
// something was removed. It never splits a character.
func Truncate(text string, limit int) string {
	if utf8.RuneCountInString(text) <= limit {
		return text
	}

	runes := []rune(text)

	return string(runes[:limit-3]) + "..."
}

// ErrorType names the kind of an error, as TypeScript's error name and
// Python's exception class do: the type's own name, without its package or
// pointer. Errors made with errors.New or fmt.Errorf have no kind of their
// own, and are called "error".
func ErrorType(err error) string {
	t := reflect.TypeOf(err)
	for t != nil && t.Kind() == reflect.Pointer {
		t = t.Elem()
	}

	if t == nil || t.Name() == "" {
		return "error"
	}

	switch t.PkgPath() {
	case "errors", "fmt":
		return "error"
	}

	return Truncate(t.Name(), MaxNameLength)
}

// DescribeError is the kind and message of an error a tool returned. The
// kind is that of the first error in the chain that has one, so a wrapped
// error is named for what it wraps; the message is the whole of it.
func DescribeError(err error) (string, string) {
	if err == nil {
		return "error", ""
	}

	return ErrorType(Unwrap(err)), Truncate(safeMessage(err), MaxExceptionMessageLength)
}

// safeMessage reads an error's text, and survives an Error method that
// panics: describing a failure must never become one.
func safeMessage(err error) (message string) {
	defer func() {
		if recover() != nil {
			message = ""
		}
	}()

	return err.Error()
}

// ResultText joins the text blocks of a result that reported an error, cut
// to the result limit. Only text is read: images and binary content carry
// nothing worth storing, and copying them anywhere would be indefensible.
func ResultText(texts []string) string {
	joined := strings.TrimSpace(strings.Join(texts, " "))

	return Truncate(joined, MaxResultMessageLength)
}

// Unwrap follows an error to the first one of a kind worth naming, so an
// error wrapped with fmt.Errorf("...: %w") is still called what it is.
func Unwrap(err error) error {
	for err != nil {
		if ErrorType(err) != "error" {
			return err
		}
		next := errors.Unwrap(err)
		if next == nil {
			return err
		}
		err = next
	}

	return err
}
