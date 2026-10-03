package core

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// DefaultTimeout is how long one delivery attempt may take.
const DefaultTimeout = 10 * time.Second

// MaxRetryAfter is the longest Retry-After followed. A server asking for
// longer is either wrong or unwell, and a queue that stops for a day on its
// word loses the day.
const MaxRetryAfter = 5 * time.Minute

// UserAgent names the SDK and its language, as the contract asks.
const UserAgent = "mcpspan/" + Version + " (go)"

// transportError is a delivery that did not succeed. Retryable says whether
// sending the same batch again could work: a refused key or a malformed
// batch is refused the same way every time.
type transportError struct {
	message    string
	status     int
	retryable  bool
	retryAfter time.Duration
}

func (e *transportError) Error() string { return e.message }

func isRetryable(status int) bool {
	return status == http.StatusRequestTimeout || status == http.StatusTooManyRequests || status >= 500
}

// newHTTPClient makes the client deliveries go through. It follows no
// redirects: a redirected POST delivers nothing while looking like it did,
// so a redirect is surfaced as the answer it is.
func newHTTPClient(timeout time.Duration) *http.Client {
	return &http.Client{
		Timeout: timeout,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

// sendEvents delivers one batch. It neither retries nor swallows.
func sendEvents(client *http.Client, endpoint, apiKey string, events []Event) error {
	if events == nil {
		events = []Event{}
	}

	body, err := json.Marshal(map[string][]Event{"events": events})
	if err != nil {
		return &transportError{message: "could not encode the batch: " + err.Error()}
	}

	url := strings.TrimRight(endpoint, "/") + "/v1/events"
	request, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return &transportError{message: "could not build the request: " + err.Error()}
	}

	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+apiKey)
	request.Header.Set("User-Agent", UserAgent)

	response, err := client.Do(request)
	if err != nil {
		// Unreachable, reset, timed out: the moment, not the batch.
		return &transportError{message: fmt.Sprintf("failed to reach %s (%v)", url, err), retryable: true}
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64<<10))

	if response.StatusCode >= 200 && response.StatusCode < 300 {
		return nil
	}

	return &transportError{
		message:    fmt.Sprintf("ingest API answered %d", response.StatusCode),
		status:     response.StatusCode,
		retryable:  isRetryable(response.StatusCode),
		retryAfter: parseRetryAfter(response.Header.Get("Retry-After"), time.Now()),
	}
}

// parseRetryAfter reads Retry-After in either form, whole seconds or a date.
// Zero when absent or unreadable, which leaves the SDK's own backoff to decide.
func parseRetryAfter(header string, now time.Time) time.Duration {
	header = strings.TrimSpace(header)
	if header == "" {
		return 0
	}

	var wait time.Duration
	if seconds, err := strconv.ParseUint(header, 10, 32); err == nil {
		wait = time.Duration(seconds) * time.Second
	} else if at, err := http.ParseTime(header); err == nil {
		wait = at.Sub(now)
	} else {
		return 0
	}

	return min(max(wait, 0), MaxRetryAfter)
}
