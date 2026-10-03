package core

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

type ingest struct {
	*httptest.Server
	mu       sync.Mutex
	requests []*http.Request
	bodies   []map[string][]Event
	status   int
	headers  map[string]string
}

func newIngest(t *testing.T) *ingest {
	t.Helper()

	fake := &ingest{status: http.StatusAccepted}
	fake.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var decoded map[string][]Event
		_ = json.Unmarshal(body, &decoded)
		fake.mu.Lock()
		fake.requests = append(fake.requests, r)
		fake.bodies = append(fake.bodies, decoded)
		fake.mu.Unlock()
		for name, value := range fake.headers {
			w.Header().Set(name, value)
		}
		if fake.status >= 300 && fake.status < 400 {
			w.Header().Set("Location", "/elsewhere")
		}
		w.WriteHeader(fake.status)
	}))
	t.Cleanup(fake.Close)

	return fake
}

// received is how many requests arrived, safe to ask while more arrive.
func (fake *ingest) received() int {
	fake.mu.Lock()
	defer fake.mu.Unlock()

	return len(fake.requests)
}

func TestPostsJSONWithTheKeyAndAUserAgent(t *testing.T) {
	fake := newIngest(t)

	err := sendEvents(newHTTPClient(time.Second), fake.URL+"/", "k", []Event{{ID: "1", ToolName: "ok"}})
	if err != nil {
		t.Fatal(err)
	}

	request := fake.requests[0]
	if request.URL.Path != "/v1/events" || request.Method != http.MethodPost {
		t.Fatalf("%s %s", request.Method, request.URL.Path)
	}
	if request.Header.Get("Authorization") != "Bearer k" ||
		request.Header.Get("Content-Type") != "application/json" ||
		request.Header.Get("User-Agent") != "mcpspan/"+Version+" (go)" {
		t.Fatalf("headers %v", request.Header)
	}
	if fake.bodies[0]["events"][0].ToolName != "ok" {
		t.Fatalf("body %v", fake.bodies[0])
	}
}

func TestAnEmptyBatchIsAnEmptyList(t *testing.T) {
	fake := newIngest(t)
	_ = sendEvents(newHTTPClient(time.Second), fake.URL, "k", nil)

	if events, ok := fake.bodies[0]["events"]; !ok || events == nil || len(events) != 0 {
		t.Fatalf("body %v", fake.bodies[0])
	}
}

func TestClassifiesAnswers(t *testing.T) {
	cases := map[int]bool{408: true, 429: true, 500: true, 503: true, 400: false, 401: false, 413: false, 307: false}

	for status, retryable := range cases {
		fake := newIngest(t)
		fake.status = status

		err := sendEvents(newHTTPClient(time.Second), fake.URL, "k", []Event{{ID: "1"}})
		te, ok := err.(*transportError)
		if !ok || te.status != status || te.retryable != retryable {
			t.Errorf("%d: got %#v", status, err)
		}
		if len(fake.requests) != 1 {
			t.Errorf("%d: followed a redirect", status)
		}
	}
}

func TestPassesRetryAfterOn(t *testing.T) {
	fake := newIngest(t)
	fake.status = http.StatusTooManyRequests
	fake.headers = map[string]string{"Retry-After": "7"}

	err := sendEvents(newHTTPClient(time.Second), fake.URL, "k", []Event{{ID: "1"}})
	if te := err.(*transportError); te.retryAfter != 7*time.Second {
		t.Fatalf("got %v", te.retryAfter)
	}
}

func TestAnUnreachableEndpointIsRetryable(t *testing.T) {
	err := sendEvents(newHTTPClient(time.Second), "http://127.0.0.1:9", "k", []Event{{ID: "1"}})
	if te, ok := err.(*transportError); !ok || !te.retryable || te.status != 0 {
		t.Fatalf("got %#v", err)
	}
}

func TestReadsRetryAfterInBothForms(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

	cases := map[string]time.Duration{
		"":   0,
		"12": 12 * time.Second,
		now.Add(30 * time.Second).Format(http.TimeFormat): 30 * time.Second,
		"99999": MaxRetryAfter,
		"soon":  0,
	}

	for header, want := range cases {
		if got := parseRetryAfter(header, now); got != want {
			t.Errorf("%q: got %v, want %v", header, got, want)
		}
	}
}
