module github.com/mcpspan/mcpspan/packages/mcpspan-go/mcpgo

go 1.25.5

require (
	github.com/mark3labs/mcp-go v1.1.1
	github.com/mcpspan/mcpspan/packages/mcpspan-go v0.4.0
)

require (
	github.com/google/jsonschema-go v0.4.2 // indirect
	github.com/google/uuid v1.6.0 // indirect
	github.com/santhosh-tekuri/jsonschema/v6 v6.0.2 // indirect
	github.com/spf13/cast v1.7.1 // indirect
	github.com/yosida95/uritemplate/v3 v3.0.2 // indirect
	golang.org/x/text v0.14.0 // indirect
)

// The core module, from this repository until it is published.
replace github.com/mcpspan/mcpspan/packages/mcpspan-go => ../
