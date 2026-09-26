package dev.fsapp.backend;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.HashMap;
import java.util.concurrent.CompletableFuture;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

@Service
final class IceService {
    private static final List<Map<String, Object>> STUN = List.of(Map.of("urls", List.of("stun:stun.cloudflare.com:3478")));
    private final AppProperties config;
    private final TurnClient turn;
    private final Clock clock;
    private final Map<String, Pending> cache = new HashMap<>();

    record Configuration(List<Map<String, Object>> iceServers, boolean relayEnabled, Instant expiresAt) {}

    IceService(AppProperties config, TurnClient turn, Clock clock) { this.config = config; this.turn = turn; this.clock = clock; }

    Configuration configuration(String participantKey, Instant roomExpiresAt) {
        if (!config.turnEnabled()) return new Configuration(STUN, false, null);
        Duration ttl = Duration.between(clock.instant(), roomExpiresAt);
        if (ttl.compareTo(config.turnTtl()) > 0) ttl = config.turnTtl();
        if (ttl.compareTo(Duration.ofSeconds(60)) < 0) return new Configuration(STUN, false, null);
        Pending pending;
        boolean issuer = false;
        synchronized (cache) {
            cleanup();
            pending = cache.get(participantKey);
            if (pending == null || (pending.result.isDone() && !clock.instant().plusSeconds(30).isBefore(pending.expiresAt))) {
                if (pending == null && cache.size() >= config.maxRooms() * 2) return new Configuration(STUN, false, null);
                pending = new Pending(clock.instant().plus(ttl));
                cache.put(participantKey, pending);
                issuer = true;
            }
        }
        // Only the participant's concurrent callers share a future. Provider I/O never holds the cache lock.
        if (issuer) {
            try {
                pending.result.complete(new Configuration(turn.issue(ttl), true, pending.expiresAt));
            } catch (RuntimeException unavailable) {
                pending.result.complete(new Configuration(STUN, false, null));
                synchronized (cache) { cache.remove(participantKey, pending); }
            }
        }
        return pending.result.join();
    }

    @Scheduled(fixedDelay = 60_000)
    void cleanup() {
        synchronized (cache) { cache.values().removeIf(v -> !clock.instant().isBefore(v.expiresAt)); }
    }

    private static final class Pending {
        final Instant expiresAt;
        final CompletableFuture<Configuration> result = new CompletableFuture<>();
        Pending(Instant expiresAt) { this.expiresAt = expiresAt; }
    }
}
