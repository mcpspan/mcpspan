package com.mcpspan.javasdk;

import io.modelcontextprotocol.json.McpJsonDefaults;
import io.modelcontextprotocol.json.McpJsonMapper;
import io.modelcontextprotocol.server.transport.StdioServerTransportProvider;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.UncheckedIOException;
import java.nio.channels.Channels;
import java.nio.channels.Pipe;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * A stdio transport for a server under test, and a client speaking JSON-RPC to it over pipes: the MCP SDK has no
 * in-memory client, and this is what a real client sends.
 *
 * <p>The pipes are the operating system's, not {@code java.io.PipedInputStream}: that one gives up with "Pipe broken"
 * once the thread that last wrote to it has ended and nothing arrives for a second or two, and the server writes its
 * answers from pooled threads. Under load that stopped the reader, and every later request timed out.
 */
final class Wire implements AutoCloseable {

    static final McpJsonMapper JSON = McpJsonDefaults.getMapper();

    final StdioServerTransportProvider transport;
    private final OutputStream toServer;
    private final Map<Integer, CompletableFuture<Map<String, Object>>> pending = new ConcurrentHashMap<>();
    private final AtomicInteger ids = new AtomicInteger();
    private final Thread reader;

    Wire() {
        try {
            Pipe requests = Pipe.open();
            Pipe answers = Pipe.open();
            toServer = Channels.newOutputStream(requests.sink());
            InputStream clientIn = Channels.newInputStream(answers.source());
            transport = new StdioServerTransportProvider(
                JSON, Channels.newInputStream(requests.source()), Channels.newOutputStream(answers.sink()));
            reader = new Thread(() -> read(clientIn), "wire-reader");
            reader.setDaemon(true);
            reader.start();
        }
        catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    @SuppressWarnings("unchecked")
    private void read(InputStream in) {
        try (BufferedReader lines = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            for (String line = lines.readLine(); line != null; line = lines.readLine()) {
                Map<String, Object> message = JSON.readValue(line, Map.class);
                if (message.get("id") instanceof Number id && pending.containsKey(id.intValue())) {
                    pending.remove(id.intValue()).complete(message);
                }
            }
        }
        catch (IOException ignored) {
            // The server went away.
        }
    }

    /** Sends a request and waits for its answer. */
    Map<String, Object> request(String method, Map<String, Object> params) {
        int id = ids.incrementAndGet();
        CompletableFuture<Map<String, Object>> answer = new CompletableFuture<>();
        pending.put(id, answer);
        Map<String, Object> message = new LinkedHashMap<>();
        message.put("jsonrpc", "2.0");
        message.put("id", id);
        message.put("method", method);
        message.put("params", params);
        send(message);
        try {
            return answer.get(10, TimeUnit.SECONDS);
        }
        catch (Exception e) {
            throw new IllegalStateException("no answer to " + method, e);
        }
    }

    void notify(String method) {
        send(Map.of("jsonrpc", "2.0", "method", method));
    }

    private synchronized void send(Map<String, Object> message) {
        try {
            toServer.write((JSON.writeValueAsString(message) + "\n").getBytes(StandardCharsets.UTF_8));
            toServer.flush();
        }
        catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /** The handshake, as a client calling itself this name. */
    Wire connect(String clientName) {
        request("initialize", Map.of("protocolVersion", "2025-11-25", "capabilities", Map.of(),
            "clientInfo", Map.of("name", clientName, "version", "1.0.0")));
        notify("notifications/initialized");
        return this;
    }

    /** Calls a tool; the answer is the JSON-RPC response, a result or an error. */
    Map<String, Object> call(String name, Map<String, Object> arguments) {
        return request("tools/call", Map.of("name", name, "arguments", arguments));
    }

    Map<String, Object> call(String name) {
        return call(name, Map.of());
    }

    @Override
    public void close() throws IOException {
        toServer.close();
    }
}
