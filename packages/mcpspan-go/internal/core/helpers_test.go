package core

import (
	"sync"
	"testing"
	"time"
)

// recorder stands in for delivery: it keeps every batch and answers from a
// script, then with success.
type recorder struct {
	mu      sync.Mutex
	batches []recorded
	answers []error
}

type recorded struct {
	at     time.Time
	events []Event
}

func (r *recorder) send(events []Event) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	r.batches = append(r.batches, recorded{at: time.Now(), events: append([]Event(nil), events...)})
	if len(r.answers) == 0 {
		return nil
	}
	answer := r.answers[0]
	r.answers = r.answers[1:]

	return answer
}

func (r *recorder) withEvents() [][]string {
	r.mu.Lock()
	defer r.mu.Unlock()

	var ids [][]string
	for _, batch := range r.batches {
		if len(batch.events) == 0 {
			continue
		}
		var batchIDs []string
		for _, event := range batch.events {
			batchIDs = append(batchIDs, event.ID)
		}
		ids = append(ids, batchIDs)
	}

	return ids
}

func (r *recorder) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()

	return len(r.batches)
}

func eventually(t *testing.T, what string, condition func() bool) {
	t.Helper()

	deadline := time.Now().Add(5 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}
