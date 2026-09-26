package dev.fsapp.backend;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.timeout;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.WebSocketSession;
import tools.jackson.databind.json.JsonMapper;

class ResourceLimitsTest {
    @Test void slowConsumerHasBoundedQueueAndNeverConcurrentWriters() throws Exception {
        var socket = mock(WebSocketSession.class);
        var open = new AtomicBoolean(true);
        when(socket.isOpen()).thenAnswer(i -> open.get());
        var started = new CountDownLatch(1);
        var released = new CountDownLatch(1);
        var closed = new CountDownLatch(1);
        AtomicInteger activeWriters = new AtomicInteger(), maxWriters = new AtomicInteger();
        doAnswer(i -> {
            maxWriters.accumulateAndGet(activeWriters.incrementAndGet(), Math::max);
            started.countDown();
            released.await(5, TimeUnit.SECONDS);
            activeWriters.decrementAndGet(); return null;
        }).when(socket).sendMessage(any());
        doAnswer(i -> { open.set(false); released.countDown(); closed.countDown(); return null; }).when(socket).close(any(CloseStatus.class));
        try (var writer = Executors.newVirtualThreadPerTaskExecutor()) {
            var peer = new QueuedPeer(socket, JsonMapper.builder().build(), writer);
            peer.send(Map.of("payload", "x".repeat(60_000)));
            assertThat(started.await(2, TimeUnit.SECONDS)).isTrue();
            peer.send(Map.of("payload", "x".repeat(60_000)));
            peer.send(Map.of("payload", "x".repeat(60_000)));
            assertThat(closed.await(2, TimeUnit.SECONDS)).isTrue();
            assertThat(maxWriters.get()).isEqualTo(1);
            verify(socket).close(new CloseStatus(1008, "slow_consumer"));
        } finally { released.countDown(); }
    }

    @Test void watchdogClosesAWriterThatStallsEvenWithoutFurtherMessages() throws Exception {
        var socket = mock(WebSocketSession.class);
        when(socket.isOpen()).thenReturn(true);
        var started = new CountDownLatch(1); var release = new CountDownLatch(1);
        doAnswer(i -> { started.countDown(); release.await(5, TimeUnit.SECONDS); return null; }).when(socket).sendMessage(any());
        doAnswer(i -> { release.countDown(); return null; }).when(socket).close(any(CloseStatus.class));
        try (var writer = Executors.newVirtualThreadPerTaskExecutor()) {
            var peer = new QueuedPeer(socket, JsonMapper.builder().build(), writer);
            peer.send(Map.of("type", "ready"));
            assertThat(started.await(2, TimeUnit.SECONDS)).isTrue();
            peer.checkStalled(Duration.ZERO);
            verify(socket, timeout(2000)).close(new CloseStatus(1008, "slow_consumer"));
        } finally { release.countDown(); }
    }

    @Test void fixedWindowRejectsExcessAndRecoversWithClock() {
        var clock = new TestSupport.MutableClock(); var limiter = new RateLimits(clock);
        limiter.require("same-ip", 2, Duration.ofMinutes(1));
        limiter.require("same-ip", 2, Duration.ofMinutes(1));
        assertThatThrownBy(() -> limiter.require("same-ip", 2, Duration.ofMinutes(1))).isInstanceOf(ApiException.class)
                .satisfies(e -> assertThat(((ApiException) e).status).isEqualTo(429));
        limiter.require("different-ip", 2, Duration.ofMinutes(1));
        clock.advance(Duration.ofMinutes(1));
        limiter.require("same-ip", 2, Duration.ofMinutes(1));
    }

    @Test void exhaustedRoomCapacityIsRecoveredByExpiry() {
        var clock = new TestSupport.MutableClock();
        var c = TestSupport.config(false);
        var config = new AppProperties("", "", 1, c.maxConnections(), c.createPerMinute(), c.requestPerMinute(), c.pairingAttemptsPerMinute(), c.pairingGlobalAttemptsPerMinute(), c.invitationTtl(),
                c.sessionTtl(), c.authTimeout(), false, "", "", c.turnTtl());
        var rooms = new RoomRegistry(clock, config);
        rooms.create();
        assertThatThrownBy(rooms::create).isInstanceOf(ApiException.class)
                .satisfies(e -> assertThat(((ApiException) e).code).isEqualTo("capacity"));
        clock.advance(Duration.ofMinutes(10));
        assertThat(rooms.create()).isNotNull(); assertThat(rooms.size()).isEqualTo(1);
    }

    @Test void turnKillSwitchNeverCallsProvider() {
        var turn = mock(TurnClient.class); var clock = new TestSupport.MutableClock();
        var service = new IceService(TestSupport.config(false), turn, clock);
        assertThat(service.configuration("participant", clock.instant().plusSeconds(7200)).relayEnabled()).isFalse();
        verify(turn, never()).issue(any());
    }

    @Test void turnCredentialsAreCachedBoundedByRoomExpiryAndRefreshed() {
        var turn = mock(TurnClient.class); var clock = new TestSupport.MutableClock();
        when(turn.issue(any())).thenReturn(List.of(Map.of("urls", List.of("turn:example.test:3478"), "username", "temp", "credential", "secret")));
        var service = new IceService(TestSupport.config(true), turn, clock);
        var expiry = clock.instant().plusSeconds(7200);
        var first = service.configuration("participant", expiry);
        assertThat(first.relayEnabled()).isTrue();
        assertThat(first.expiresAt()).isEqualTo(clock.instant().plusSeconds(600));
        assertThat(service.configuration("participant", expiry)).isSameAs(first);
        verify(turn).issue(Duration.ofMinutes(10));
        clock.advance(Duration.ofMinutes(10));
        assertThat(service.configuration("participant", clock.instant().plusSeconds(90)).expiresAt()).isEqualTo(clock.instant().plusSeconds(90));
        verify(turn).issue(Duration.ofSeconds(90));
    }

    @Test void providerOutageFallsBackToDirectStunWithoutExposingProviderErrors() {
        var turn = mock(TurnClient.class); var clock = new TestSupport.MutableClock();
        when(turn.issue(any())).thenThrow(new ApiException(503, "relay_unavailable", "provider private details"));
        var service = new IceService(TestSupport.config(true), turn, clock);
        var response = service.configuration("participant", clock.instant().plusSeconds(7200));
        assertThat(response.relayEnabled()).isFalse();
        assertThat(response.iceServers()).hasSize(1);
        assertThat(response.toString()).doesNotContain("provider private details");
    }

    @Test void concurrentCredentialRequestsShareIssuanceWithoutBlockingOtherParticipants() throws Exception {
        var turn = mock(TurnClient.class); var clock = new TestSupport.MutableClock();
        var entered = new CountDownLatch(1); var release = new CountDownLatch(1); var calls = new AtomicInteger();
        when(turn.issue(any())).thenAnswer(invocation -> {
            if (calls.incrementAndGet() == 1) { entered.countDown(); release.await(5, TimeUnit.SECONDS); }
            return List.of(Map.of("urls", List.of("turn:example.test:3478"), "username", "temp", "credential", "secret"));
        });
        var service = new IceService(TestSupport.config(true), turn, clock);
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var first = executor.submit(() -> service.configuration("first", clock.instant().plusSeconds(7200)));
            assertThat(entered.await(2, TimeUnit.SECONDS)).isTrue();
            var duplicate = executor.submit(() -> service.configuration("first", clock.instant().plusSeconds(7200)));
            var other = executor.submit(() -> service.configuration("other", clock.instant().plusSeconds(7200)));
            assertThat(other.get(2, TimeUnit.SECONDS).relayEnabled()).isTrue();
            release.countDown();
            assertThat(first.get(2, TimeUnit.SECONDS)).isSameAs(duplicate.get(2, TimeUnit.SECONDS));
            assertThat(calls.get()).isEqualTo(2);
        } finally { release.countDown(); }
    }

    @Test void invalidConfigurationFailsAtStartup() {
        var c = TestSupport.config(false);
        assertThatThrownBy(() -> new AppProperties("", "*", c.maxRooms(), c.maxConnections(), c.createPerMinute(), c.requestPerMinute(), c.pairingAttemptsPerMinute(), c.pairingGlobalAttemptsPerMinute(),
                c.invitationTtl(), c.sessionTtl(), c.authTimeout(), false, "", "", c.turnTtl())).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new AppProperties("", "", c.maxRooms(), c.maxConnections(), c.createPerMinute(), c.requestPerMinute(), c.pairingAttemptsPerMinute(), c.pairingGlobalAttemptsPerMinute(),
                c.invitationTtl(), c.sessionTtl(), c.authTimeout(), true, "", "", c.turnTtl())).isInstanceOf(IllegalArgumentException.class);
    }

    @Test void consumedCodesRemainReservedAndRetiringOldRoomCannotDeleteAnotherCode() {
        var clock = new TestSupport.MutableClock();
        var choices = new AtomicInteger();
        var random = new java.security.SecureRandom() {
            @Override public int nextInt(int bound) { return choices.getAndIncrement() < 2 ? 42 : 43; }
        };
        var registry = new RoomRegistry(clock, TestSupport.config(false), random);
        var first = registry.create();
        assertThat(first.code()).isEqualTo("000042");
        assertThat(registry.claim(first.code()).key()).isEqualTo(first.key());
        assertThatThrownBy(() -> registry.claim(first.code())).isInstanceOf(ApiException.class);
        var second = registry.create();
        assertThat(second.code()).isEqualTo("000043"); // The injected collision with consumed 000042 was skipped.
        registry.delete(first.id(), first.senderToken());
        assertThat(registry.claim(second.code()).id()).isEqualTo(second.id());
        assertThatThrownBy(() -> registry.claim(first.code())).isInstanceOf(ApiException.class);
    }
}
