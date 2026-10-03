package core

// DefaultMaxQueueSize is how many events are held while delivery fails. At
// ten calls per second that covers roughly seventeen minutes of downtime;
// past it the oldest go, so an unreachable endpoint can never grow the queue
// until the host runs out of memory.
const DefaultMaxQueueSize = 10_000

// queue holds events waiting to be sent, oldest first. Not safe for
// concurrent use on its own; the reporter guards it.
type queue struct {
	max     int
	events  []Event
	dropped int
}

// add queues an event, dropping the oldest when full: once the backend is
// back, what the server is doing now matters more than what it did when the
// outage began.
func (q *queue) add(event Event) {
	if len(q.events) >= q.max {
		q.events = q.events[1:]
		q.dropped++
	}
	q.events = append(q.events, event)
}

// drain removes and returns up to limit events, oldest first.
func (q *queue) drain(limit int) []Event {
	if limit > len(q.events) {
		limit = len(q.events)
	}

	batch := make([]Event, limit)
	copy(batch, q.events[:limit])
	q.events = q.events[limit:]

	return batch
}

// restore puts a batch that failed to deliver back in front. If that
// overflows the queue, the oldest go as usual.
func (q *queue) restore(batch []Event) {
	q.events = append(append(make([]Event, 0, len(batch)+len(q.events)), batch...), q.events...)

	if over := len(q.events) - q.max; over > 0 {
		q.events = q.events[over:]
		q.dropped += over
	}
}
