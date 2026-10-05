package core

import "testing"

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
