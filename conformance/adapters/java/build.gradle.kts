// The conformance adapter for the JVM SDK, on the official MCP Java SDK.
//
// Build it, then point the suite at the start script:
//
//   ../../../packages/mcpspan-jvm/gradlew installDist
//   CONFORMANCE_ADAPTER='["adapters/java/build/install/adapter/bin/adapter"]' ...
plugins {
    application
}

repositories {
    mavenCentral()
}

dependencies {
    implementation("com.mcpspan:mcpspan-java-sdk:0.7.1")
    implementation("io.modelcontextprotocol.sdk:mcp:2.1.0")
}


tasks.withType<JavaCompile>().configureEach {
    options.release = 17
}

application {
    applicationName = "adapter"
    mainClass = "adapter.Main"
}
