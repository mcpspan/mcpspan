// Every module: Java 17 bytecode, the oldest Java the MCP SDKs run on, built
// with whichever newer JDK is at hand. Warnings fail the build.
subprojects {
    apply(plugin = "java-library")

    group = "com.mcpspan"
    version = "0.1.0"

    repositories {
        mavenCentral()
    }

    extensions.configure<JavaPluginExtension> {
        withSourcesJar()
        withJavadocJar()
    }

    tasks.withType<JavaCompile>().configureEach {
        options.release = 17
        options.encoding = "UTF-8"
        options.compilerArgs.addAll(listOf("-Xlint:all", "-Xlint:-serial", "-Werror"))
    }

    tasks.withType<Javadoc>().configureEach {
        (options as StandardJavadocDocletOptions).addStringOption("Xdoclint:all,-missing", "-quiet")
    }

    tasks.withType<Test>().configureEach {
        useJUnitPlatform()
        // One at a time: the SDK keeps its configuration process-wide, as a server does.
        maxParallelForks = 1
        testLogging { events("failed"); exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL }
    }

    dependencies {
        "testImplementation"(platform("org.junit:junit-bom:6.1.3"))
        "testImplementation"("org.junit.jupiter:junit-jupiter")
        "testImplementation"("org.junit.jupiter:junit-jupiter-params")
        "testRuntimeOnly"("org.junit.platform:junit-platform-launcher")
    }
}
