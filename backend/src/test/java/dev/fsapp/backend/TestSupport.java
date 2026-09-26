package dev.fsapp.backend;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;

final class TestSupport {
    static AppProperties config(boolean turn) {
        return new AppProperties("", "", 500, 1000, 20, 120, 5, 60, Duration.ofMinutes(10), Duration.ofHours(2),
                Duration.ofSeconds(10), turn, turn ? "test-key" : "", turn ? "test-secret" : "", Duration.ofMinutes(10));
    }

    static final class MutableClock extends Clock {
        private volatile Instant now = Instant.parse("2026-09-14T12:00:00Z");
        void advance(Duration delta) { now = now.plus(delta); }
        @Override public ZoneId getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(ZoneId zone) { return this; }
        @Override public Instant instant() { return now; }
    }
}
