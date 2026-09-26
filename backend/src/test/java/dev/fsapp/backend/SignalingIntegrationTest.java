package dev.fsapp.backend;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import java.net.URI;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.WebSocket;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.HashMap;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        "fsapp.create-per-minute=10000", "fsapp.request-per-minute=10000", "fsapp.turn-enabled=false",
        "fsapp.pairing-attempts-per-minute=10000", "fsapp.pairing-global-attempts-per-minute=10000"})
@Import(SignalingIntegrationTest.TimeConfiguration.class)
class SignalingIntegrationTest {
    @Value("${local.server.port}") int port;
    @Autowired ObjectMapper json;
    @Autowired TestSupport.MutableClock clock;
    @Autowired RoomRegistry rooms;
    @Autowired SignalingHandler handler;
    final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    final List<Client> clients = new ArrayList<>();
    final List<JsonNode> created = new ArrayList<>();

    @TestConfiguration
    static class TimeConfiguration {
        @Bean @Primary TestSupport.MutableClock testClock() { return new TestSupport.MutableClock(); }
    }

    @AfterEach void cleanup() {
        clients.forEach(c -> c.socket.abort());
        created.forEach(r -> { try { rooms.delete(r.path("id").asText(), r.path("senderToken").asText()); } catch (ApiException ignored) {} });
        http.close();
    }

    @Test void createsBoundedInvitationAndReturnsSecurityHeaders() throws Exception {
        var response = request("POST", "/v1/sessions", null);
        assertThat(response.statusCode()).isEqualTo(201);
        JsonNode body = json.readTree(response.body());
        created.add(body);
        assertThat(body.path("id").asText()).matches("[A-Za-z0-9_-]{24}");
        assertThat(body.path("senderToken").asText()).hasSize(43);
        assertThat(body.has("receiverToken")).isFalse();
        assertThat(body.path("code").asText()).matches("[0-9]{6}");
        assertThat(body.path("key").asText()).matches("[A-Za-z0-9_-]{43}");
        assertThat(body.path("attempt").asText()).matches("[A-Za-z0-9_-]{22}");
        assertThat(body.path("maxFileBytes").longValue()).isEqualTo(104857600);
        assertThat(body.path("maxFiles").intValue()).isEqualTo(10);
        assertThat(response.headers().firstValue("Cache-Control")).hasValue("no-store");
        assertThat(response.headers().firstValue("Content-Security-Policy").orElseThrow()).contains("frame-ancestors 'none'").doesNotContain("unsafe-inline");
        assertThat(request("GET", "/actuator/health", null).statusCode()).isEqualTo(200);
    }

    @Test void realWebSocketsAuthenticatePairAndForwardOnlyValidRoleMessages() throws Exception {
        JsonNode room = create();
        Client sender = join(room, "sender"), receiver = join(room, "receiver");
        approvePair(room, sender, receiver);
        Map<String, Object> offer = signal(room, "sender", 1, "offer");
        sender.send(offer);
        assertThat(receiver.next("signal")).isEqualTo(json.valueToTree(offer));
        receiver.send(signal(room, "receiver", 1, "answer"));
        assertThat(sender.next("signal").path("kind").asText()).isEqualTo("answer");
        sender.send(signal(room, "sender", 2, "ice"));
        assertThat(receiver.next("signal").path("kind").asText()).isEqualTo("ice");
    }

    @Test void competingReceiverJoinsAdmitExactlyOneAndLeaveTheWinnerUsable() throws Exception {
        JsonNode room = create(); Client sender = join(room, "sender");
        Client first = connect(room), second = connect(room);
        var auth = auth(room, "receiver");
        CompletableFuture.allOf(first.socket.sendText(json.writeValueAsString(auth), true),
                second.socket.sendText(json.writeValueAsString(auth), true)).get(5, TimeUnit.SECONDS);
        JsonNode a = first.take(), b = second.take();
        assertThat(List.of(a.path("type").asText(), b.path("type").asText())).containsExactlyInAnyOrder("ready", "error");
        Client winner = "ready".equals(a.path("type").asText()) ? first : second;
        JsonNode rejection = "error".equals(a.path("type").asText()) ? a : b;
        assertThat(rejection.path("code").asText()).isEqualTo("role_taken");
        approvePair(room, sender, winner);
        sender.send(signal(room, "sender", 1, "offer"));
        assertThat(winner.next("signal").path("kind").asText()).isEqualTo("offer");
    }

    @Test void rejectsWrongTokenAndUnauthenticatedPayloadWithoutConsumingRole() throws Exception {
        JsonNode room = create();
        Client attacker = connect(room);
        attacker.send(Map.of("type", "auth", "role", "receiver", "token", "A".repeat(43)));
        assertThat(attacker.next("error").path("code").asText()).isEqualTo("unauthorized");
        Client unauthenticated = connect(room);
        unauthenticated.send(signal(room, "sender", 1, "offer"));
        assertThat(unauthenticated.next("error").path("code").asText()).isEqualTo("unauthorized");
        join(room, "sender"); join(room, "receiver");
    }

    @Test void rejectsReplayAndOutOfRoleDescription() throws Exception {
        JsonNode room = create(); Client sender = join(room, "sender"), receiver = join(room, "receiver");
        approvePair(room, sender, receiver);
        sender.send(signal(room, "sender", 1, "offer")); receiver.next("signal");
        sender.send(signal(room, "sender", 1, "ice"));
        assertThat(sender.next("error").path("code").asText()).isEqualTo("replay");

        room = create(); sender = join(room, "sender"); receiver = join(room, "receiver");
        approvePair(room, sender, receiver);
        receiver.send(signal(room, "receiver", 1, "offer"));
        assertThat(receiver.next("error").path("code").asText()).isEqualTo("invalid_signal");
    }

    @Test void rejectsMalformedAndOversizedMessages() throws Exception {
        JsonNode room = create(); Client client = connect(room);
        client.socket.sendText("{invalid json", true).join();
        assertThat(client.next("error").path("code").asText()).isEqualTo("invalid_message");
        Client oversized = connect(room);
        oversized.socket.sendText("x".repeat(SignalingHandler.MAX_MESSAGE_BYTES + 1), true).join();
        assertThat(oversized.closed.get(5, TimeUnit.SECONDS)).isEqualTo(1009);
    }

    @Test void departureRetiresInvitationAndClosesOrphanSignalingSocket() throws Exception {
        JsonNode room = create(); Client sender = join(room, "sender"), receiver = join(room, "receiver");
        approvePair(room, sender, receiver);
        receiver.socket.sendClose(1000, "done").join();
        assertThat(sender.next("peer-left").path("type").asText()).isEqualTo("peer-left");
        assertThat(sender.closed.get(5, TimeUnit.SECONDS)).isEqualTo(1008);
        await().atMost(Duration.ofSeconds(3)).untilAsserted(() -> assertThat(handler.connectionCount()).isZero());
        Client replacement = connect(room); replacement.send(auth(room, "receiver"));
        assertThat(replacement.next("error").path("code").asText()).isEqualTo("expired");
    }

    @Test void realWebSocketStalledReaderIsDisconnectedAndCapacityIsReclaimed() throws Exception {
        JsonNode room = create(); Client sender = join(room, "sender");
        // A raw RFC6455 peer is deliberate: high-level clients may keep draining TCP into hidden buffers.
        try (Socket stalled = new Socket()) {
            stalled.setReceiveBufferSize(1024);
            stalled.setSoTimeout(5000);
            stalled.connect(new InetSocketAddress("127.0.0.1", port), 5000);
            var output = stalled.getOutputStream();
            String upgrade = "GET /v1/sessions/" + room.path("id").asText() + " HTTP/1.1\r\n"
                    + "Host: localhost:" + port + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                    + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n";
            output.write(upgrade.getBytes(StandardCharsets.US_ASCII)); output.flush();
            var header = new ByteArrayOutputStream();
            while (!header.toString(StandardCharsets.US_ASCII).endsWith("\r\n\r\n")) {
                int next = stalled.getInputStream().read();
                assertThat(next).isNotEqualTo(-1);
                header.write(next);
                assertThat(header.size()).isLessThan(16_384);
            }
            assertThat(header.toString(StandardCharsets.US_ASCII)).startsWith("HTTP/1.1 101");
            byte[] authBytes = json.writeValueAsBytes(auth(room, "receiver"));
            assertThat(authBytes.length).isLessThan(126);
            byte[] mask = {11, 22, 33, 44};
            output.write(0x81); output.write(0x80 | authBytes.length); output.write(mask);
            for (int i = 0; i < authBytes.length; i++) output.write(authBytes[i] ^ mask[i % 4]);
            output.flush();
            // From here until the assertion completes, no reads occur on the receiver socket.
            sender.next("pairing-pending");
            assertThat(request("POST", "/v1/sessions/" + room.path("id").asText() + "/approve", room.path("senderToken").asText()).statusCode()).isEqualTo(204);
            sender.next("peer-ready");
            for (int seq = 1; seq <= 240 && !sender.closed.isDone(); seq++) {
                var envelope = new HashMap<>(signal(room, "sender", seq, seq == 1 ? "offer" : "ice"));
                envelope.put("payload", "A".repeat(60_000));
                try { sender.send(envelope); }
                catch (java.util.concurrent.CompletionException closedDuringSend) { break; }
            }
            JsonNode peerLeft = sender.messages.poll(12, TimeUnit.SECONDS);
            assertThat(peerLeft).isNotNull();
            assertThat(peerLeft.path("type").asText()).isEqualTo("peer-left");
            assertThat(sender.closed.get(5, TimeUnit.SECONDS)).isEqualTo(1008);
            await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(handler.connectionCount()).isZero());
            assertThat(rooms.size()).isZero();
        }
    }

    @Test void unusedInvitationExpiresAtTenMinutesAndJoinedSessionAtTwoHours() throws Exception {
        JsonNode waitingRoom = create(); Client waiting = join(waitingRoom, "sender");
        clock.advance(Duration.ofMinutes(10)); rooms.cleanup();
        assertThat(waiting.next("error").path("code").asText()).isEqualTo("expired");
        JsonNode liveRoom = create(); Client sender = join(liveRoom, "sender"), receiver = join(liveRoom, "receiver");
        approvePair(liveRoom, sender, receiver);
        clock.advance(Duration.ofMinutes(11)); rooms.cleanup();
        assertThat(request("POST", "/v1/sessions/" + liveRoom.path("id").asText() + "/ice", liveRoom.path("senderToken").asText()).statusCode()).isEqualTo(200);
        clock.advance(Duration.ofMinutes(109)); rooms.cleanup();
        assertThat(sender.next("error").path("code").asText()).isEqualTo("expired");
    }

    @Test void requiresJoinedParticipantForIceAndParticipantForDelete() throws Exception {
        JsonNode room = create(); String path = "/v1/sessions/" + room.path("id").asText();
        assertThat(request("POST", path + "/ice", room.path("senderToken").asText()).statusCode()).isEqualTo(401);
        Client sender = join(room, "sender");
        assertThat(request("POST", path + "/ice", room.path("senderToken").asText()).statusCode()).isEqualTo(409);
        Client receiver = join(room, "receiver");
        approvePair(room, sender, receiver);
        var ice = request("POST", path + "/ice", room.path("senderToken").asText());
        assertThat(ice.statusCode()).isEqualTo(200);
        assertThat(json.readTree(ice.body()).path("relayEnabled").booleanValue()).isFalse();
        assertThat(json.readTree(ice.body()).path("iceServers").get(0).path("urls").get(0).asText()).startsWith("stun:");
        assertThat(request("DELETE", path, "A".repeat(43)).statusCode()).isEqualTo(401);
        assertThat(request("DELETE", path, room.path("senderToken").asText()).statusCode()).isEqualTo(204);
        assertThat(sender.next("error").path("code").asText()).isEqualTo("session_closed");
    }

    @Test void closesUnclaimedSocketAfterAuthenticationDeadline() throws Exception {
        Client client = connect(create());
        clock.advance(Duration.ofSeconds(11)); handler.maintenance();
        assertThat(client.next("error").path("code").asText()).isEqualTo("auth_timeout");
        assertThat(client.closed.get(5, TimeUnit.SECONDS)).isEqualTo(1008);
    }

    @Test void authenticatedHeartbeatDoesNotExtendInvitationAndExcessMessagesAreRejected() throws Exception {
        JsonNode room = create(); Client sender = join(room, "sender");
        sender.send(Map.of("type", "ping"));
        assertThat(sender.next("pong").path("type").asText()).isEqualTo("pong");
        clock.advance(Duration.ofMinutes(10)); rooms.cleanup();
        assertThat(sender.next("error").path("code").asText()).isEqualTo("expired");

        Client noisy = join(create(), "sender");
        for (int i = 0; i < 299; i++) noisy.send(Map.of("type", "ping"));
        noisy.send(Map.of("type", "ping"));
        for (int i = 0; i < 299; i++) noisy.next("pong");
        assertThat(noisy.next("error").path("code").asText()).isEqualTo("rate_limited");
    }

    @Test void rejectsUntrustedOriginsAndBodies() throws Exception {
        var wrongOrigin = HttpRequest.newBuilder(uri("/v1/sessions")).header("Origin", "https://attacker.example")
                .POST(HttpRequest.BodyPublishers.noBody()).build();
        assertThat(http.send(wrongOrigin, HttpResponse.BodyHandlers.ofString()).statusCode()).isEqualTo(403);
        var body = HttpRequest.newBuilder(uri("/v1/sessions")).POST(HttpRequest.BodyPublishers.ofString("{}")).build();
        assertThat(http.send(body, HttpResponse.BodyHandlers.ofString()).statusCode()).isEqualTo(413);
    }

    @Test void codeClaimIsAtomicAndReturnsStrongMatchingMaterialOnlyOnce() throws Exception {
        JsonNode room = createUnclaimed();
        var request = HttpRequest.newBuilder(uri("/v1/pairings")).header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(json.writeValueAsString(Map.of("code", room.path("code").asText())))).build();
        var a = http.sendAsync(request, HttpResponse.BodyHandlers.ofString());
        var b = http.sendAsync(request, HttpResponse.BodyHandlers.ofString());
        var first = a.get(5, TimeUnit.SECONDS); var second = b.get(5, TimeUnit.SECONDS);
        assertThat(List.of(first.statusCode(), second.statusCode())).containsExactlyInAnyOrder(200, 404);
        var winner = first.statusCode() == 200 ? first : second;
        JsonNode claim = json.readTree(winner.body());
        assertThat(claim.path("id")).isEqualTo(room.path("id"));
        assertThat(claim.path("key")).isEqualTo(room.path("key"));
        assertThat(claim.path("attempt")).isEqualTo(room.path("attempt"));
        assertThat(claim.path("expiresAt")).isEqualTo(room.path("expiresAt"));
        assertThat(claim.path("token").asText()).hasSize(43).isNotEqualTo(room.path("senderToken").asText());
        assertThat(claim.has("senderToken")).isFalse();
        assertThat(winner.headers().firstValue("Cache-Control")).hasValue("no-store");
        var used = pairing(Map.of("code", room.path("code").asText()));
        var invalid = pairing(Map.of("code", "not-a-code"));
        assertThat(used.statusCode()).isEqualTo(404);
        assertThat(used.body()).isEqualTo(invalid.body());
        ((ObjectNode) room).put("receiverToken", claim.path("token").asText());
        Client sender = join(room, "sender"), receiver = join(room, "receiver");
        approvePair(room, sender, receiver);
    }

    @Test void claimedReceiverCanCancelBeforeJoiningWebSocket() throws Exception {
        JsonNode room = create(); Client sender = join(room, "sender");
        assertThat(request("DELETE", "/v1/sessions/" + room.path("id").asText(), room.path("receiverToken").asText()).statusCode()).isEqualTo(204);
        assertThat(sender.next("error").path("code").asText()).isEqualTo("session_closed");
        assertThat(pairing(Map.of("code", room.path("code").asText())).statusCode()).isEqualTo(404);
        assertThat(rooms.size()).isZero();
    }

    @Test void invalidatedAndExpiredCodesHaveTheSameGenericResponse() throws Exception {
        JsonNode cancelled = createUnclaimed();
        assertThat(request("DELETE", "/v1/sessions/" + cancelled.path("id").asText(), cancelled.path("senderToken").asText()).statusCode()).isEqualTo(204);
        var removed = pairing(Map.of("code", cancelled.path("code").asText()));
        JsonNode expired = createUnclaimed();
        clock.advance(Duration.ofMinutes(10));
        var timedOut = pairing(Map.of("code", expired.path("code").asText()));
        assertThat(timedOut.statusCode()).isEqualTo(404);
        assertThat(timedOut.body()).isEqualTo(removed.body());
        JsonNode disconnected = createUnclaimed();
        Client sender = join(disconnected, "sender");
        sender.socket.sendClose(1000, "cancel").join();
        await().atMost(Duration.ofSeconds(3)).untilAsserted(() -> assertThat(rooms.size()).isZero());
        assertThat(pairing(Map.of("code", disconnected.path("code").asText())).body()).isEqualTo(removed.body());
    }

    @Test void senderApprovalIsRequiredForIceAndSignalingAndCannotBeGrantedByReceiver() throws Exception {
        JsonNode room = create(); Client sender = join(room, "sender"), receiver = join(room, "receiver");
        sender.next("pairing-pending"); receiver.next("pairing-pending");
        String path = "/v1/sessions/" + room.path("id").asText();
        var deniedIce = request("POST", path + "/ice", room.path("receiverToken").asText());
        assertThat(deniedIce.statusCode()).isEqualTo(409);
        assertThat(json.readTree(deniedIce.body()).path("code").asText()).isEqualTo("approval_required");
        assertThat(request("POST", path + "/approve", room.path("receiverToken").asText()).statusCode()).isEqualTo(401);
        sender.send(signal(room, "sender", 1, "offer"));
        assertThat(sender.next("error").path("code").asText()).isEqualTo("approval_required");
        assertThat(receiver.next("peer-left").path("type").asText()).isEqualTo("peer-left");
    }

    @Test void approvalStartsLiveExpiryOnceAndEnforcesServerGeneratedAttempt() throws Exception {
        JsonNode room = create(); Client sender = join(room, "sender"), receiver = join(room, "receiver");
        clock.advance(Duration.ofMinutes(9));
        approvePair(room, sender, receiver);
        var liveExpiry = rooms.authorizeIce(room.path("id").asText(), room.path("senderToken").asText());
        assertThat(liveExpiry).isEqualTo(clock.instant().plus(Duration.ofHours(2)));
        clock.advance(Duration.ofMinutes(1));
        assertThat(request("POST", "/v1/sessions/" + room.path("id").asText() + "/approve", room.path("senderToken").asText()).statusCode()).isEqualTo(204);
        assertThat(rooms.authorizeIce(room.path("id").asText(), room.path("senderToken").asText())).isEqualTo(liveExpiry);
        assertThat(sender.messages.poll(100, TimeUnit.MILLISECONDS)).isNull();
        var wrongAttempt = new HashMap<>(signal(room, "sender", 1, "offer"));
        wrongAttempt.put("attemptId", "A".repeat(22));
        sender.send(wrongAttempt);
        assertThat(sender.next("error").path("code").asText()).isEqualTo("invalid_signal");
    }

    @Test void unapprovedPairExpiresAtInvitationDeadlineAndApproveCannotReviveIt() throws Exception {
        JsonNode room = create(); Client sender = join(room, "sender"), receiver = join(room, "receiver");
        sender.next("pairing-pending"); receiver.next("pairing-pending");
        clock.advance(Duration.ofMinutes(10)); rooms.cleanup();
        assertThat(sender.next("error").path("code").asText()).isEqualTo("expired");
        assertThat(receiver.next("error").path("code").asText()).isEqualTo("expired");
        assertThat(request("POST", "/v1/sessions/" + room.path("id").asText() + "/approve", room.path("senderToken").asText()).statusCode()).isEqualTo(410);
    }

    @Test void concurrentApprovalAndReceiverCancellationCannotReviveRoom() throws Exception {
        JsonNode room = create(); Client sender = join(room, "sender"), receiver = join(room, "receiver");
        sender.next("pairing-pending"); receiver.next("pairing-pending");
        String path = "/v1/sessions/" + room.path("id").asText();
        var approve = HttpRequest.newBuilder(uri(path + "/approve")).header("Authorization", "Bearer " + room.path("senderToken").asText())
                .POST(HttpRequest.BodyPublishers.noBody()).build();
        var cancel = HttpRequest.newBuilder(uri(path)).header("Authorization", "Bearer " + room.path("receiverToken").asText()).DELETE().build();
        var approved = http.sendAsync(approve, HttpResponse.BodyHandlers.ofString());
        var cancelled = http.sendAsync(cancel, HttpResponse.BodyHandlers.ofString());
        assertThat(approved.get(5, TimeUnit.SECONDS).statusCode()).isIn(204, 410);
        assertThat(cancelled.get(5, TimeUnit.SECONDS).statusCode()).isEqualTo(204);
        assertThat(sender.closed.get(5, TimeUnit.SECONDS)).isEqualTo(1008);
        assertThat(receiver.closed.get(5, TimeUnit.SECONDS)).isEqualTo(1008);
        for (Client peer : List.of(sender, receiver)) {
            var events = new ArrayList<JsonNode>(); peer.messages.drainTo(events);
            assertThat(events.stream().filter(event -> event.path("type").asText().equals("peer-ready")).count()).isLessThanOrEqualTo(1);
            assertThat(events.getLast().path("code").asText()).isEqualTo("session_closed");
        }
        assertThat(rooms.size()).isZero();
        assertThat(request("POST", path + "/approve", room.path("senderToken").asText()).statusCode()).isEqualTo(410);
        assertThat(request("POST", path + "/ice", room.path("receiverToken").asText()).statusCode()).isEqualTo(410);
    }

    @Test void pairingBodyRejectsAmbiguousJsonAndOversizedChunkedInputWithoutConsumingCode() throws Exception {
        JsonNode room = createUnclaimed(); String code = room.path("code").asText();
        for (String body : List.of("{\"code\":\"" + code + "\",\"code\":\"" + code + "\"}",
                "{\"code\":\"" + code + "\"}{}", "{\"code\":123456}", "{\"code\":\"" + code + "\",\"extra\":1}")) {
            var request = HttpRequest.newBuilder(uri("/v1/pairings")).header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(body)).build();
            assertThat(http.send(request, HttpResponse.BodyHandlers.ofString()).statusCode()).isEqualTo(400);
        }
        var chunked = HttpRequest.newBuilder(uri("/v1/pairings")).header("Content-Type", "application/json")
                .version(HttpClient.Version.HTTP_1_1)
                .POST(HttpRequest.BodyPublishers.ofInputStream(() -> new java.io.ByteArrayInputStream("x".repeat(129).getBytes(StandardCharsets.UTF_8)))).build();
        assertThat(http.send(chunked, HttpResponse.BodyHandlers.ofString()).statusCode()).isEqualTo(413);
        assertThat(pairing(Map.of("code", code)).statusCode()).isEqualTo(200);
    }

    @Test void alternateApiPathsCannotBypassPairingGuards() throws Exception {
        JsonNode room = createUnclaimed();
        for (String path : List.of("/v1/%70airings", "/%76%31/pairings", "/v1/pairings;ignored=1")) {
            String body = json.writeValueAsString(Map.of("code", room.path("code").asText()));
            var request = HttpRequest.newBuilder(uri(path)).header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(body)).build();
            assertThat(http.send(request, HttpResponse.BodyHandlers.ofString()).statusCode()).isEqualTo(400);
        }
        assertThat(pairing(Map.of("code", room.path("code").asText())).statusCode()).isEqualTo(200);
    }

    private JsonNode create() throws Exception {
        JsonNode room = createUnclaimed();
        var claim = pairing(Map.of("code", room.path("code").asText()));
        assertThat(claim.statusCode()).isEqualTo(200);
        ((ObjectNode) room).put("receiverToken", json.readTree(claim.body()).path("token").asText());
        return room;
    }

    private JsonNode createUnclaimed() throws Exception {
        var response = request("POST", "/v1/sessions", null);
        assertThat(response.statusCode()).isEqualTo(201);
        JsonNode room = json.readTree(response.body()); created.add(room); return room;
    }

    private void approvePair(JsonNode room, Client sender, Client receiver) throws Exception {
        sender.next("pairing-pending"); receiver.next("pairing-pending");
        assertThat(request("POST", "/v1/sessions/" + room.path("id").asText() + "/approve", room.path("senderToken").asText()).statusCode()).isEqualTo(204);
        sender.next("peer-ready"); receiver.next("peer-ready");
    }

    private HttpResponse<String> pairing(Map<String, ?> body) throws Exception {
        var request = HttpRequest.newBuilder(uri("/v1/pairings")).timeout(Duration.ofSeconds(5))
                .header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body))).build();
        return http.send(request, HttpResponse.BodyHandlers.ofString());
    }

    private Map<String, Object> auth(JsonNode room, String role) {
        return Map.of("type", "auth", "role", role, "token", room.path(role + "Token").asText());
    }

    private Map<String, Object> signal(JsonNode room, String role, int seq, String kind) {
        return Map.of("type", "signal", "version", 1, "roomId", room.path("id").asText(), "attemptId", room.path("attempt").asText(),
                "role", role, "seq", seq, "kind", kind, "payload", "e30", "mac", "A".repeat(43));
    }

    private Client join(JsonNode room, String role) throws Exception {
        Client client = connect(room); client.send(auth(room, role));
        assertThat(client.next("ready").path("role").asText()).isEqualTo(role); return client;
    }

    private Client connect(JsonNode room) throws Exception {
        Client client = new Client();
        client.socket = http.newWebSocketBuilder().connectTimeout(Duration.ofSeconds(5))
                .buildAsync(URI.create("ws://localhost:" + port + "/v1/sessions/" + room.path("id").asText()), client).get(5, TimeUnit.SECONDS);
        clients.add(client); return client;
    }

    private HttpResponse<String> request(String method, String path, String token) throws Exception {
        var request = HttpRequest.newBuilder(uri(path)).timeout(Duration.ofSeconds(5));
        if (token != null) request.header("Authorization", "Bearer " + token);
        return http.send(request.method(method, HttpRequest.BodyPublishers.noBody()).build(), HttpResponse.BodyHandlers.ofString());
    }
    private URI uri(String path) { return URI.create("http://localhost:" + port + path); }

    private final class Client implements WebSocket.Listener {
        WebSocket socket;
        final BlockingQueue<JsonNode> messages = new LinkedBlockingQueue<>();
        final CompletableFuture<Integer> closed = new CompletableFuture<>();
        final StringBuilder fragment = new StringBuilder();
        @Override public void onOpen(WebSocket ws) { ws.request(1); }
        @Override public CompletionStage<?> onText(WebSocket ws, CharSequence data, boolean last) {
            fragment.append(data);
            if (last) { messages.add(json.readTree(fragment.toString())); fragment.setLength(0); }
            ws.request(1); return null;
        }
        @Override public CompletionStage<?> onClose(WebSocket ws, int status, String reason) { closed.complete(status); return null; }
        @Override public void onError(WebSocket ws, Throwable error) { closed.completeExceptionally(error); }
        void send(Map<String, ?> message) { socket.sendText(json.writeValueAsString(message), true).join(); }
        JsonNode take() throws Exception {
            JsonNode message = messages.poll(5, TimeUnit.SECONDS);
            assertThat(message).as("Expected server message; closed=%s", closed.isDone()).isNotNull(); return message;
        }
        JsonNode next(String type) throws Exception {
            JsonNode message = take();
            assertThat(message.path("type").asText()).as(message.toString()).isEqualTo(type); return message;
        }
    }
}
