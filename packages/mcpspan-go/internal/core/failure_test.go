package core

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
)

type BookingError struct{}

func (*BookingError) Error() string { return "seat map unavailable" }

func TestTruncateMarksACutAndKeepsCharactersWhole(t *testing.T) {
	if got := Truncate("abc", 5); got != "abc" {
		t.Fatalf("short text changed: %q", got)
	}
	if got := Truncate("abcdefgh", 5); got != "ab..." {
		t.Fatalf("got %q", got)
	}
	if got := Truncate(strings.Repeat("ż", 300), 200); len([]rune(got)) != 200 || !strings.HasSuffix(got, "...") {
		t.Fatalf("cut through a character or to the wrong length: %d", len([]rune(got)))
	}
}

func TestErrorTypeNamesTheKind(t *testing.T) {
	cases := []struct {
		err  error
		want string
	}{
		{&BookingError{}, "BookingError"},
		{fmt.Errorf("booking: %w", &BookingError{}), "BookingError"},
		{errors.New("plain"), "error"},
		{fmt.Errorf("plain %d", 1), "error"},
		{&json.SyntaxError{}, "SyntaxError"},
	}

	for _, c := range cases {
		if got, _ := DescribeError(c.err); got != c.want {
			t.Errorf("%T: got %q, want %q", c.err, got, c.want)
		}
	}
}

type panicky struct{}

func (panicky) Error() string { panic("no") }

func TestDescribeErrorSurvivesAnErrorMethodThatPanics(t *testing.T) {
	kind, message := DescribeError(panicky{})
	if kind != "panicky" || message != "" {
		t.Fatalf("got %q %q", kind, message)
	}
}

func TestMessagesAreCutToTheirLimits(t *testing.T) {
	_, message := DescribeError(errors.New(strings.Repeat("m", 1000)))
	if len(message) != MaxExceptionMessageLength {
		t.Fatalf("exception message is %d long", len(message))
	}
	if got := ResultText([]string{strings.Repeat("x", 1000)}); len(got) != MaxResultMessageLength {
		t.Fatalf("result message is %d long", len(got))
	}
	if got := ResultText([]string{"No flights", "found"}); got != "No flights found" {
		t.Fatalf("got %q", got)
	}
}
