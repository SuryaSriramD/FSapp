package dev.fsapp.backend;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/** A bounded fixed-window limiter. The remote socket address is used; arbitrary proxy headers are ignored. */
@Component
final class RateLimits {
    private static final int MAX_KEYS = 10_000;
    private final Map<String, Window> windows = new HashMap<>();
    private final Clock clock;
    RateLimits(Clock clock) { this.clock = clock; }

    synchronized void require(String key, int limit, Duration duration) {
        Instant now = clock.instant();
        Window window = windows.get(key);
        if (window == null || !now.isBefore(window.until)) {
            if (window == null && windows.size() >= MAX_KEYS) {
                cleanup();
                if (windows.size() >= MAX_KEYS) throw new ApiException(429, "rate_limited", "The service is busy. Try again in a minute.");
            }
            window = new Window(now.plus(duration));
            windows.put(key, window);
        }
        if (++window.count > limit) throw new ApiException(429, "rate_limited", "Too many requests. Try again in a minute.");
    }

    @Scheduled(fixedDelay = 60_000)
    synchronized void cleanup() { windows.values().removeIf(w -> !clock.instant().isBefore(w.until)); }
    private static final class Window {
        final Instant until; int count;
        Window(Instant until) { this.until = until; }
    }
}
