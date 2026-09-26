package dev.fsapp.backend;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Instant;
import java.util.Base64;
import java.util.HashMap;
import java.util.Map;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

/** All admission/state changes share one short lock. Peer.send only enqueues; it never does I/O. */
@Service
final class RoomRegistry {
    static final long MAX_FILE_BYTES = 100L * 1024 * 1024;
    static final int MAX_FILES = 10;
    private final Map<String, Room> rooms = new HashMap<>();
    private final Map<String, String> codes = new HashMap<>();
    private final SecureRandom random;
    private final Clock clock;
    private final AppProperties config;

    @Autowired
    RoomRegistry(Clock clock, AppProperties config) { this(clock, config, new SecureRandom()); }

    RoomRegistry(Clock clock, AppProperties config, SecureRandom random) {
        this.clock = clock; this.config = config; this.random = random;
    }

    record Created(String id, String senderToken, String code, String key, String attempt, Instant expiresAt,
                   long maxFileBytes, int maxFiles) {}
    record Claimed(String id, String token, String key, String attempt, Instant expiresAt) {}

    synchronized Created create() {
        cleanup();
        if (rooms.size() >= config.maxRooms()) throw new ApiException(503, "capacity", "The service is busy. Try again shortly.");
        String id = randomToken(18);
        String code = unusedCode();
        Room room = new Room(id, randomToken(32), randomToken(32), code, randomToken(32), randomToken(16),
                clock.instant().plus(config.invitationTtl()));
        rooms.put(id, room);
        codes.put(code, id);
        return new Created(id, room.senderToken, code, room.key, room.attempt, room.expiresAt, MAX_FILE_BYTES, MAX_FILES);
    }

    synchronized Claimed claim(String code) {
        if (code == null || !code.matches("[0-9]{6}")) throw pairingUnavailable();
        String id = codes.get(code);
        Room room = id == null ? null : rooms.get(id);
        if (room == null || room.claimed) throw pairingUnavailable();
        if (!clock.instant().isBefore(room.expiresAt)) {
            retire(room, "expired", "This invitation expired. Create a new one.");
            throw pairingUnavailable();
        }
        room.claimed = true;
        // Reserve the consumed code until this room retires, so it cannot immediately identify another room.
        Claimed result = new Claimed(room.id, room.receiverToken, room.key, room.attempt, room.expiresAt);
        room.key = null; // No further redemption needs the pairing key; avoid retaining it for the live session.
        return result;
    }

    synchronized void join(String roomId, String role, String token, Peer peer) {
        Room room = requireRoom(roomId);
        requireRole(role);
        if (!equalToken(room.token(role), token)) throw unauthorized();
        if (role.equals("receiver") && !room.claimed) throw unauthorized();
        if (room.peers.containsKey(role)) throw new ApiException(409, "role_taken", "This invitation is already in use.");
        room.peers.put(role, peer);
        peer.send(Map.of("type", "ready", "role", role));
        if (room.peers.size() == 2) {
            room.peers.values().forEach(p -> p.send(Map.of("type", "pairing-pending")));
        }
    }

    synchronized void approve(String id, String token) {
        Room room = requireRoom(id);
        if (!equalToken(room.senderToken, token)) throw unauthorized();
        if (room.peers.size() != 2) throw new ApiException(409, "peer_missing", "Wait for the other device to join.");
        if (room.approved) return;
        room.approved = true;
        room.expiresAt = clock.instant().plus(config.sessionTtl());
        room.peers.values().forEach(peer -> peer.send(Map.of("type", "peer-ready")));
    }

    synchronized void forward(String roomId, String role, Peer sender, SignalEnvelope signal) {
        Room room = requireRoom(roomId);
        if (room.peers.get(role) != sender) throw unauthorized();
        if (room.peers.size() != 2) throw new ApiException(409, "peer_missing", "Wait for the other device to join.");
        if (!room.approved) throw approvalRequired();
        if (!signal.roomId().equals(roomId) || !signal.role().equals(role) || !signal.attemptId().equals(room.attempt)) throw invalidSignal();
        long previous = room.sequences.getOrDefault(role, -1L);
        if (signal.seq() <= previous) throw new ApiException(400, "replay", "The signaling sequence was repeated or out of order.");
        switch (signal.kind()) {
            case "offer" -> {
                if (!role.equals("sender") || room.offered) throw invalidSignal();
                room.offered = true;
            }
            case "answer" -> {
                if (!role.equals("receiver") || !room.offered || room.answered) throw invalidSignal();
                room.answered = true;
            }
            case "ice" -> {
                if (!(role.equals("sender") ? room.offered : room.answered)) throw invalidSignal();
            }
            default -> throw invalidSignal();
        }
        room.sequences.put(role, signal.seq());
        room.peers.get(role.equals("sender") ? "receiver" : "sender").send(signal.asMap());
    }

    synchronized Instant authorizeIce(String id, String token) {
        Room room = requireRoom(id);
        String role = equalToken(room.senderToken, token) ? "sender" : equalToken(room.receiverToken, token) ? "receiver" : "";
        if (!room.peers.containsKey(role)) throw unauthorized();
        if (room.peers.size() != 2) throw new ApiException(409, "peer_missing", "Wait for the other device to join.");
        if (!room.approved) throw approvalRequired();
        return room.expiresAt;
    }

    synchronized void delete(String id, String token) {
        Room room = requireRoom(id);
        if (!equalToken(room.senderToken, token) && !(room.claimed && equalToken(room.receiverToken, token))) throw unauthorized();
        retire(room, "session_closed", "A participant closed this invitation.");
    }

    synchronized void disconnected(String id, String role, Peer peer) {
        Room room = rooms.get(id);
        if (room == null || room.peers.get(role) != peer) return;
        rooms.remove(id);
        codes.remove(room.code, id);
        room.peers.values().stream().filter(p -> p != peer)
                .forEach(p -> {
                    p.send(Map.of("type", "peer-left"));
                    p.close("peer_left");
                });
        // Close orphan signaling sockets too; their independently established DataChannels are unaffected.
    }

    @Scheduled(fixedDelayString = "${fsapp.cleanup-interval-ms:1000}")
    synchronized void cleanup() {
        rooms.values().stream().filter(r -> !clock.instant().isBefore(r.expiresAt)).toList()
                .forEach(r -> retire(r, "expired", "This invitation expired. Create a new one."));
    }

    synchronized int size() { return rooms.size(); }

    private Room requireRoom(String id) {
        Room room = rooms.get(id);
        if (room == null) throw new ApiException(410, "expired", "This invitation is unavailable. Create a new one.");
        if (!clock.instant().isBefore(room.expiresAt)) {
            retire(room, "expired", "This invitation expired. Create a new one.");
            throw new ApiException(410, "expired", "This invitation expired. Create a new one.");
        }
        return room;
    }

    private void retire(Room room, String code, String message) {
        rooms.remove(room.id);
        codes.remove(room.code, room.id);
        room.peers.values().forEach(peer -> {
            peer.send(Map.of("type", "error", "code", code, "message", message));
            peer.close(code);
        });
    }

    private String randomToken(int size) {
        byte[] bytes = new byte[size]; random.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    private String unusedCode() {
        for (int attempt = 0; attempt < 100; attempt++) {
            String code = String.format(java.util.Locale.ROOT, "%06d", random.nextInt(1_000_000));
            if (!codes.containsKey(code)) return code;
        }
        throw new ApiException(503, "capacity", "The service is busy. Try again shortly.");
    }

    private static boolean equalToken(String expected, String actual) {
        return actual != null && actual.length() == expected.length()
                && MessageDigest.isEqual(expected.getBytes(StandardCharsets.US_ASCII), actual.getBytes(StandardCharsets.US_ASCII));
    }

    static void requireRole(String role) { if (!"sender".equals(role) && !"receiver".equals(role)) throw unauthorized(); }
    private static ApiException unauthorized() { return new ApiException(401, "unauthorized", "This participant is not authorized."); }
    private static ApiException invalidSignal() { return new ApiException(400, "invalid_signal", "Invalid connection negotiation."); }
    private static ApiException approvalRequired() { return new ApiException(409, "approval_required", "The sender must confirm the matching phrase before connecting."); }
    private static ApiException pairingUnavailable() { return new ApiException(404, "pairing_unavailable", "This code is unavailable. Check the code or create a new invitation."); }

    private static final class Room {
        final String id, senderToken, receiverToken, code, attempt;
        String key;
        Instant expiresAt;
        final Map<String, Peer> peers = new HashMap<>();
        final Map<String, Long> sequences = new HashMap<>();
        boolean offered, answered, claimed, approved;
        Room(String id, String senderToken, String receiverToken, String code, String key, String attempt, Instant expiresAt) {
            this.id = id; this.senderToken = senderToken; this.receiverToken = receiverToken; this.expiresAt = expiresAt;
            this.code = code; this.key = key; this.attempt = attempt;
        }
        String token(String role) { return role.equals("sender") ? senderToken : receiverToken; }
    }
}
