package core

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func TestDescribesNamesAndJSONTypesOnly(t *testing.T) {
	raw := json.RawMessage(`{"destination":"secret","passengers":2,"price":9.5,"direct":true,` +
		`"stops":["a"],"filters":{"k":"v"},"note":null}`)

	got := DescribeParameters(raw)
	want := map[string]string{
		"destination": "string", "passengers": "number", "price": "number", "direct": "boolean",
		"stops": "array", "filters": "object", "note": "null",
	}

	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v", got)
	}
	if strings.Contains(fmt.Sprint(got), "secret") {
		t.Fatal("a value leaked")
	}
}

func TestNothingForNoParametersOrNotAnObject(t *testing.T) {
	for _, raw := range []string{`{}`, `["a"]`, `"x"`, ``, `{broken`} {
		if got := DescribeParameters(json.RawMessage(raw)); got != nil {
			t.Errorf("%q: got %v", raw, got)
		}
	}
}

func TestBoundedInCountAndNameLength(t *testing.T) {
	var parts []string
	for i := range 80 {
		parts = append(parts, fmt.Sprintf(`"p%d":1`, i))
	}
	if got := DescribeParameters(json.RawMessage("{" + strings.Join(parts, ",") + "}")); len(got) != MaxDescribedParameters {
		t.Fatalf("described %d", len(got))
	}

	long := DescribeParameters(json.RawMessage(`{"` + strings.Repeat("n", 400) + `":1}`))
	for name := range long {
		if len(name) > MaxNameLength {
			t.Fatalf("name of %d characters", len(name))
		}
	}
}
