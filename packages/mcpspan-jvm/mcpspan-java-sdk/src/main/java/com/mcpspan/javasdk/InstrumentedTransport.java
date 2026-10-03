package com.mcpspan.javasdk;

import io.modelcontextprotocol.server.McpAsyncServer;
import io.modelcontextprotocol.spec.McpServerSession;
import io.modelcontextprotocol.spec.McpServerTransportProvider;
import java.util.List;
import reactor.core.publisher.Mono;

/**
 * A transport provider that instruments the server built on it as each session is created, before the session
 * reads its first message.
 *
 * <p>A stdio transport starts reading as the server is built, so {@code instrument(server)} afterwards leaves a
 * window in which the first calls of a fast client pass unmeasured. Wrapped here, the session is instrumented the
 * moment it exists. Everything else is handed to the transport as it is.
 */
final class InstrumentedTransport implements McpServerTransportProvider {

    private final McpServerTransportProvider transport;

    InstrumentedTransport(McpServerTransportProvider transport) {
        this.transport = transport;
    }

    @Override
    public void setSessionFactory(McpServerSession.Factory factory) {
        transport.setSessionFactory(sessionTransport -> {
            McpServerSession session = factory.create(sessionTransport);
            try {
                McpAsyncServer server = Instrumentation.serverOf(session);
                if (server != null) {
                    Instrumentation.instrument(server, Instrumentation.handlersOfSession(session));
                }
            }
            catch (RuntimeException ignored) {
                // A session of an unfamiliar shape is handed back as it was.
            }
            return session;
        });
    }

    @Override
    public Mono<Void> notifyClients(String method, Object params) {
        return transport.notifyClients(method, params);
    }

    @Override
    public Mono<Void> notifyClient(String sessionId, String method, Object params) {
        return transport.notifyClient(sessionId, method, params);
    }

    @Override
    public void close() {
        transport.close();
    }

    @Override
    public Mono<Void> closeGracefully() {
        return transport.closeGracefully();
    }

    @Override
    public List<String> protocolVersions() {
        return transport.protocolVersions();
    }
}
