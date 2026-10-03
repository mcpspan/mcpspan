package core

import (
	"context"
	"testing"
	"time"
)

func reset(t *testing.T) {
	t.Helper()
	t.Setenv("MCPSPAN_API_KEY", "")
	t.Setenv("MCPSPAN_ENDPOINT", "")
	t.Cleanup(func() { Shutdown(context.Background()) })
}

func TestDoesNothingAtAllWithoutAKey(t *testing.T) {
	reset(t)
	Configure(Settings{})

	if Collecting() || Recording() {
		t.Fatal("collecting without a key")
	}
}

func TestReadsTheKeyAndEndpointFromTheEnvironment(t *testing.T) {
	reset(t)
	fake := newIngest(t)
	t.Setenv("MCPSPAN_API_KEY", "env-key")
	t.Setenv("MCPSPAN_ENDPOINT", fake.URL)

	Configure(Settings{})
	eventually(t, "the announcement", func() bool { return fake.received() == 1 })

	if fake.requests[0].Header.Get("Authorization") != "Bearer env-key" {
		t.Fatal("key not read from the environment")
	}
}

func TestTheSameSettingsAgainChangeNothing(t *testing.T) {
	reset(t)
	sent := &recorder{}
	settings := UseSender(Settings{APIKey: "k"}, sent.send)

	Configure(settings)
	first := current
	Configure(settings)

	if current != first {
		t.Fatal("started over for the same settings")
	}

	Configure(UseSender(Settings{APIKey: "other"}, sent.send))
	if current == first {
		t.Fatal("kept running with different settings")
	}
}

func TestAMalformedSettingFallsBack(t *testing.T) {
	reset(t)
	var notes []string
	Configure(UseSender(Settings{APIKey: "k", FlushInterval: -time.Second, MaxBatchSize: 5000, Debug: true,
		OnDiagnostic: func(m string) { notes = append(notes, m) }}, (&recorder{}).send))

	if current.flushInterval != DefaultFlushInterval || current.maxBatchSize != 1_000 {
		t.Fatalf("interval %v, batch %d", current.flushInterval, current.maxBatchSize)
	}
}

func TestRecordBuildsAWellFormedEvent(t *testing.T) {
	reset(t)
	sent := &recorder{}
	Configure(UseSender(Settings{APIKey: "k", FlushInterval: time.Hour}, sent.send))

	call := Begin("search")
	call.ClientName = "Claude Desktop"
	call.SessionID = "s-1"
	call.Arguments = []byte(`{"destination":"secret"}`)
	Record(call, Outcome{Success: true, ErrorMessage: "ignored on success"})
	Shutdown(context.Background())

	event := onlyEvent(t, sent)
	if event.ToolName != "search" || !event.Success || event.ClientType != "claude" ||
		event.ClientName != "Claude Desktop" || event.SessionID != "s-1" || event.SDKVersion != Version ||
		event.ErrorMessage != "" || event.Parameters != nil || len(event.ID) != 36 ||
		event.Timestamp[len(event.Timestamp)-1] != 'Z' {
		t.Fatalf("event %+v", event)
	}
}

func TestRecordsParametersOnlyWhenAsked(t *testing.T) {
	reset(t)
	sent := &recorder{}
	Configure(UseSender(Settings{APIKey: "k", FlushInterval: time.Hour, CaptureParameterNames: true}, sent.send))

	call := Begin("search")
	call.Arguments = []byte(`{"destination":"secret","passengers":2}`)
	Record(call, Outcome{Success: true})
	Shutdown(context.Background())

	got := onlyEvent(t, sent).Parameters
	if got["destination"] != "string" || got["passengers"] != "number" {
		t.Fatalf("parameters %v", got)
	}
}

// onlyEvent is the one event delivered, whichever batch it came in: the
// announcement runs on its own and may arrive before it or after.
func onlyEvent(t *testing.T, sent *recorder) Event {
	t.Helper()
	sent.mu.Lock()
	defer sent.mu.Unlock()

	var found []Event
	for _, batch := range sent.batches {
		found = append(found, batch.events...)
	}
	if len(found) != 1 {
		t.Fatalf("delivered %d events", len(found))
	}

	return found[0]
}

func TestAServerVersionSetForTheSDKWinsOverTheServersOwn(t *testing.T) {
	for _, c := range []struct{ setting, env, own, want string }{
		{"", "", "1.0.0", "1.0.0"},
		{"", "env-sha", "1.0.0", "env-sha"},
		{"a1b2c3d", "env-sha", "1.0.0", "a1b2c3d"},
		{"", "", "", ""},
	} {
		reset(t)
		t.Setenv("MCPSPAN_SERVER_VERSION", c.env)
		sent := &recorder{}
		Configure(UseSender(Settings{APIKey: "k", FlushInterval: time.Hour, ServerVersion: c.setting}, sent.send))

		call := Begin("search")
		call.ServerVersion, call.ClientVersion = c.own, "2.3.4"
		Record(call, Outcome{Success: true})
		Shutdown(context.Background())

		var got Event
		sent.mu.Lock()
		for _, batch := range sent.batches {
			for _, event := range batch.events {
				got = event
			}
		}
		sent.mu.Unlock()
		if got.ServerVersion != c.want || got.ClientVersion != "2.3.4" {
			t.Errorf("setting %q, env %q, server %q: recorded %q and client %q", c.setting, c.env, c.own, got.ServerVersion, got.ClientVersion)
		}
	}
}

func TestWithAKeyAndNoEndpointNothingIsCollectedAndItIsSaidOnce(t *testing.T) {
	reset(t)
	t.Setenv("MCPSPAN_ENDPOINT", "")
	mu.Lock()
	saidNoEndpoint = false
	mu.Unlock()

	var said []string
	settings := Settings{APIKey: "k", OnDiagnostic: func(message string) { said = append(said, message) }}
	Configure(settings)
	Configure(settings)

	if running, _ := running(); running != nil {
		t.Error("collecting with nowhere to send")
	}
	if len(said) != 1 || said[0] != NoEndpoint {
		t.Errorf("said %q, want NoEndpoint once", said)
	}
}
