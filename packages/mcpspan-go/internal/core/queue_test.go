package core

import (
	"reflect"
	"strconv"
	"testing"
)

func ids(events []Event) []string {
	var out []string
	for _, event := range events {
		out = append(out, event.ID)
	}
	return out
}

func events(from, to int) []Event {
	var out []Event
	for i := from; i < to; i++ {
		out = append(out, Event{ID: strconv.Itoa(i)})
	}
	return out
}

func TestQueueDropsTheOldestWhenFull(t *testing.T) {
	q := queue{max: 3}
	for _, event := range events(0, 5) {
		q.add(event)
	}

	if got := ids(q.drain(10)); !reflect.DeepEqual(got, []string{"2", "3", "4"}) || q.dropped != 2 {
		t.Fatalf("got %v, dropped %d", got, q.dropped)
	}
}

func TestQueueDrainsInBatchesAndRestoresInFront(t *testing.T) {
	q := queue{max: 4}
	for _, event := range events(0, 3) {
		q.add(event)
	}

	first := q.drain(2)
	q.add(Event{ID: "3"})
	q.restore(first)

	if got := ids(q.drain(10)); !reflect.DeepEqual(got, []string{"0", "1", "2", "3"}) {
		t.Fatalf("got %v", got)
	}

	q.add(Event{ID: "9"})
	q.restore(events(5, 9))
	if got := ids(q.drain(10)); !reflect.DeepEqual(got, []string{"6", "7", "8", "9"}) || q.dropped != 1 {
		t.Fatalf("got %v, dropped %d", got, q.dropped)
	}
}
