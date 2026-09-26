package dev.fsapp.backend;

import java.io.IOException;
import java.time.Duration;
import java.util.ArrayDeque;
import java.util.Map;
import java.util.Queue;
import java.util.concurrent.Executor;
import java.util.concurrent.atomic.AtomicBoolean;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import tools.jackson.databind.ObjectMapper;

/** One drain per socket, with bounded bytes including the in-flight message. No network I/O under room locks. */
final class QueuedPeer implements Peer {
    static final int MAX_QUEUED_BYTES = 128 * 1024;
    private final WebSocketSession socket;
    private final ObjectMapper json;
    private final Executor executor;
    private final Queue<TextMessage> queue = new ArrayDeque<>();
    private int queuedBytes;
    private boolean running;
    private String closeReason;
    private boolean aborted;
    private final AtomicBoolean socketClosed = new AtomicBoolean();
    private volatile long sendingSince;

    QueuedPeer(WebSocketSession socket, ObjectMapper json, Executor executor) {
        this.socket = socket; this.json = json; this.executor = executor;
    }

    @Override public String id() { return socket.getId(); }

    @Override public synchronized void send(Map<String, ?> value) {
        if (closeReason != null || !socket.isOpen()) return;
        TextMessage message = new TextMessage(json.writeValueAsString(value));
        if (queuedBytes + message.getPayloadLength() > MAX_QUEUED_BYTES) {
            abort("slow_consumer");
            return;
        }
        queuedBytes += message.getPayloadLength();
        queue.add(message);
        startDrain();
    }

    @Override public synchronized void close(String reason) {
        if (closeReason == null) closeReason = reason;
        startDrain();
    }

    void checkStalled(Duration limit) {
        long started = sendingSince;
        if (started != 0 && System.nanoTime() - started > limit.toNanos()) abort("slow_consumer");
    }

    synchronized void abort(String reason) {
        if (aborted) return;
        aborted = true;
        closeReason = reason;
        queue.clear();
        executor.execute(() -> closeSocket(reason));
    }

    private void startDrain() {
        if (!running) { running = true; executor.execute(this::drain); }
    }

    private void drain() {
        while (true) {
            TextMessage message;
            String reason;
            synchronized (this) {
                message = queue.poll();
                reason = closeReason;
                if (message == null) running = false;
            }
            if (message == null) {
                if (reason != null) closeSocket(reason);
                return;
            }
            try {
                sendingSince = System.nanoTime();
                if (socket.isOpen()) socket.sendMessage(message);
            } catch (IOException | RuntimeException ignored) {
                abort("transport_error");
                return;
            } finally {
                sendingSince = 0;
                synchronized (this) { queuedBytes -= message.getPayloadLength(); }
            }
        }
    }

    private void closeSocket(String reason) {
        if (!socketClosed.compareAndSet(false, true)) return;
        try { if (socket.isOpen()) socket.close(new CloseStatus(1008, reason)); }
        catch (IOException | RuntimeException ignored) { /* Transport is already unavailable. */ }
    }
}
