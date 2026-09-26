package dev.fsapp.backend;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import jakarta.annotation.PreDestroy;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.BinaryMessage;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.AbstractWebSocketHandler;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@Component
final class SignalingHandler extends AbstractWebSocketHandler {
    static final int MAX_MESSAGE_BYTES = 64 * 1024;
    private final Map<String, Connection> connections = new ConcurrentHashMap<>();
    private final ExecutorService writer = Executors.newVirtualThreadPerTaskExecutor();
    private final RoomRegistry rooms;
    private final ObjectMapper json;
    private final AppProperties config;
    private final Clock clock;

    SignalingHandler(RoomRegistry rooms, ObjectMapper json, AppProperties config, Clock clock) {
        this.rooms = rooms; this.json = json; this.config = config; this.clock = clock;
    }

    @Override public synchronized void afterConnectionEstablished(WebSocketSession socket) throws Exception {
        if (connections.size() >= config.maxConnections()) {
            socket.close(new CloseStatus(1013, "capacity")); return;
        }
        socket.setTextMessageSizeLimit(MAX_MESSAGE_BYTES);
        socket.setBinaryMessageSizeLimit(1);
        String path = socket.getUri().getPath();
        String roomId = path.substring(path.lastIndexOf('/') + 1);
        QueuedPeer peer = new QueuedPeer(socket, json, writer);
        connections.put(socket.getId(), new Connection(roomId, peer, clock.instant().plus(config.authTimeout())));
    }

    @Override protected void handleTextMessage(WebSocketSession socket, TextMessage message) {
        Connection connection = connections.get(socket.getId());
        if (connection == null) return;
        try {
            if (message.getPayloadLength() > MAX_MESSAGE_BYTES) throw new ApiException(400, "too_large", "Connection message is too large.");
            connection.requireMessageBudget(clock.instant());
            JsonNode node = json.readTree(message.getPayload());
            if (node == null || !node.isObject()) throw new ApiException(400, "invalid_message", "Expected a JSON connection message.");
            if (connection.role == null) {
                if (!clock.instant().isBefore(connection.authDeadline)) throw new ApiException(401, "auth_timeout", "Authentication timed out.");
                if (node.size() != 3 || !"auth".equals(node.path("type").asText())
                        || !node.path("role").isString() || !node.path("token").isString()
                        || !node.path("token").asText().matches("[A-Za-z0-9_-]{43}")) {
                    throw new ApiException(401, "unauthorized", "Authenticate with an invitation first.");
                }
                String role = node.path("role").asText();
                connection.role = role;
                rooms.join(connection.roomId, role, node.path("token").asText(), connection.peer);
            } else if (node.size() == 1 && "ping".equals(node.path("type").asText())) {
                connection.peer.send(Map.of("type", "pong"));
            } else {
                rooms.forward(connection.roomId, connection.role, connection.peer, SignalEnvelope.parse(node));
            }
        } catch (ApiException error) {
            fail(connection, error.code, error.getMessage());
        } catch (RuntimeException error) {
            // Never log client payloads: they may contain authorization tokens or ICE credentials.
            fail(connection, "invalid_message", "The connection message could not be read.");
        }
    }

    @Override protected void handleBinaryMessage(WebSocketSession socket, BinaryMessage message) {
        Connection connection = connections.get(socket.getId());
        if (connection != null) fail(connection, "invalid_message", "Binary signaling messages are not supported.");
    }

    @Override public void handleTransportError(WebSocketSession socket, Throwable exception) {
        Connection connection = connections.get(socket.getId());
        if (connection != null) connection.peer.abort("transport_error");
    }

    @Override public void afterConnectionClosed(WebSocketSession socket, CloseStatus status) {
        Connection connection = connections.remove(socket.getId());
        if (connection != null && connection.role != null) rooms.disconnected(connection.roomId, connection.role, connection.peer);
    }

    @Scheduled(fixedDelayString = "${fsapp.cleanup-interval-ms:1000}")
    void maintenance() {
        connections.values().forEach(connection -> {
            if (connection.role == null && !clock.instant().isBefore(connection.authDeadline)) {
                fail(connection, "auth_timeout", "Authentication timed out.");
            }
            connection.peer.checkStalled(Duration.ofSeconds(5));
        });
    }

    @PreDestroy
    void shutdown() {
        connections.values().forEach(c -> c.peer.abort("server_shutdown"));
        writer.shutdown();
    }

    int connectionCount() { return connections.size(); }

    private void fail(Connection connection, String code, String message) {
        connection.peer.send(Map.of("type", "error", "code", code, "message", message));
        connection.peer.close(code);
    }

    private static final class Connection {
        final String roomId;
        final QueuedPeer peer;
        final Instant authDeadline;
        volatile String role;
        Instant windowEnd = Instant.MIN;
        int messages;
        Connection(String roomId, QueuedPeer peer, Instant authDeadline) {
            this.roomId = roomId; this.peer = peer; this.authDeadline = authDeadline;
        }
        void requireMessageBudget(Instant now) {
            if (!now.isBefore(windowEnd)) { windowEnd = now.plusSeconds(10); messages = 0; }
            if (++messages > 300) throw new ApiException(429, "rate_limited", "Too many connection messages.");
        }
    }
}
