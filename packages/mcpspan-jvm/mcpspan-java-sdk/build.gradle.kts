plugins {
    id("org.gradle.test-retry") version "1.6.6"
}

description = "mcpspan for servers built on the official MCP Java SDK."

dependencies {
    api(project(":mcpspan"))
    // The MCP SDK it instruments, and nothing else.
    api("io.modelcontextprotocol.sdk:mcp-core:2.0.1")

    testImplementation("io.modelcontextprotocol.sdk:mcp:2.0.1")
    // Parses the README's samples, to check them against the package.
    testImplementation("com.github.javaparser:javaparser-core:3.28.2")
}

// The MCP Java SDK's stdio server can stop answering under heavy CPU load, with no mcpspan in the process
// (contract, 15). The tests that drive a real server run a failed case once more with a fresh one, as CI does for the
// conformance suite; a case that fails twice fails the build.
tasks.test {
    retry {
        maxRetries = 1
        filter { includeClasses.add("*JavaSdkTest") }
    }
}
