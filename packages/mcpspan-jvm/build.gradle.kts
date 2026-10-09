// Every module: Java 17 bytecode, the oldest Java the MCP SDKs run on, built
// with whichever newer JDK is at hand. Warnings fail the build.
subprojects {
    apply(plugin = "java-library")
    apply(plugin = "maven-publish")
    apply(plugin = "signing")

    group = "com.mcpspan"
    version = "0.5.0"

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

    // What Maven Central requires of every artifact: a POM that says what it is, whose, under which licence and
    // where its source is, and a signature. Published into a directory under the root build, which the release
    // workflow bundles and uploads to the Central Portal; nothing here talks to the network.
    extensions.configure<PublishingExtension> {
        publications {
            create<MavenPublication>("maven") {
                from(components["java"])
                pom {
                    name.set(project.name)
                    description.set(provider { project.description })
                    url.set("https://github.com/mcpspan/mcpspan")
                    licenses {
                        license {
                            name.set("MIT")
                            url.set("https://opensource.org/license/mit")
                        }
                    }
                    developers {
                        developer {
                            id.set("KcprZtn")
                            name.set("Kacper Zatoń")
                            email.set("contact@mcpspan.com")
                        }
                    }
                    scm {
                        url.set("https://github.com/mcpspan/mcpspan")
                        connection.set("scm:git:https://github.com/mcpspan/mcpspan.git")
                    }
                }
            }
        }
        repositories {
            maven {
                name = "staging"
                url = rootProject.layout.buildDirectory.dir("staging").get().asFile.toURI()
            }
        }
    }

    // Signed when the release workflow hands over a key; a build anywhere else does not need one.
    val signingKey = providers.environmentVariable("MAVEN_SIGNING_KEY")
    if (signingKey.isPresent) {
        extensions.configure<SigningExtension> {
            useInMemoryPgpKeys(signingKey.get(), providers.environmentVariable("MAVEN_SIGNING_PASSWORD").orNull)
            sign(extensions.getByType<PublishingExtension>().publications["maven"])
        }
    }
}
