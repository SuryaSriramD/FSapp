package dev.fsapp.backend;

import java.time.Duration;
import java.net.URI;
import java.util.Arrays;
import java.util.List;
import java.util.stream.Stream;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

@ConfigurationProperties("fsapp")
public record AppProperties(
        @DefaultValue("") String publicOrigin,
        @DefaultValue("") String allowedOrigins,
        @DefaultValue("500") int maxRooms,
        @DefaultValue("1000") int maxConnections,
        @DefaultValue("20") int createPerMinute,
        @DefaultValue("120") int requestPerMinute,
        @DefaultValue("5") int pairingAttemptsPerMinute,
        @DefaultValue("60") int pairingGlobalAttemptsPerMinute,
        @DefaultValue("10m") Duration invitationTtl,
        @DefaultValue("2h") Duration sessionTtl,
        @DefaultValue("10s") Duration authTimeout,
        @DefaultValue("false") boolean turnEnabled,
        @DefaultValue("") String turnKeyId,
        @DefaultValue("") String turnApiToken,
        @DefaultValue("2h") Duration turnTtl) {
    public AppProperties {
        if (maxRooms < 1 || maxConnections < 2 || createPerMinute < 1 || requestPerMinute < 1
                || pairingAttemptsPerMinute < 1 || pairingAttemptsPerMinute > 10_000
                || pairingGlobalAttemptsPerMinute < 1 || pairingGlobalAttemptsPerMinute > 100_000
                || invitationTtl.isNegative() || invitationTtl.isZero()
                || sessionTtl.isNegative() || sessionTtl.isZero()
                || authTimeout.isNegative() || authTimeout.isZero()
                || turnTtl.compareTo(Duration.ofSeconds(60)) < 0 || turnTtl.compareTo(Duration.ofHours(2)) > 0) {
            throw new IllegalArgumentException("Invalid FSApp resource limits or expiry configuration");
        }
        if (!publicOrigin.isBlank() && !validOrigin(publicOrigin)) {
            throw new IllegalArgumentException("FSAPP_PUBLIC_ORIGIN must be an HTTP(S) origin without a trailing slash");
        }
        for (String origin : allowedOrigins.split(",")) {
            if (!origin.isBlank() && !validOrigin(origin.trim())) {
                throw new IllegalArgumentException("FSAPP_ALLOWED_ORIGINS must contain exact HTTP(S) origins");
            }
        }
        if (turnEnabled && (!turnKeyId.matches("[A-Za-z0-9_-]{1,128}") || turnApiToken.isBlank())) {
            throw new IllegalArgumentException("TURN enabled without valid server credentials");
        }
    }

    List<String> origins() {
        return Stream.concat(Stream.of(publicOrigin), Arrays.stream(allowedOrigins.split(",")))
                .map(String::trim).filter(s -> !s.isBlank()).distinct().toList();
    }

    private static boolean validOrigin(String value) {
        try {
            URI uri = URI.create(value);
            return ("http".equals(uri.getScheme()) || "https".equals(uri.getScheme())) && uri.getHost() != null
                    && uri.getRawPath().isEmpty() && uri.getRawQuery() == null && uri.getRawFragment() == null
                    && uri.getRawUserInfo() == null;
        } catch (IllegalArgumentException error) { return false; }
    }

    @Override public String toString() {
        return "AppProperties[maxRooms=" + maxRooms + ", maxConnections=" + maxConnections + ", turnEnabled=" + turnEnabled + "]";
    }
}
