package dev.fsapp.backend;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;

abstract class PairingRateLimitChecks {
    @Value("${local.server.port}") int port;
    @Autowired AppProperties config;

    HttpResponse<String> invalidCode(HttpClient client, int forwardedSuffix) throws Exception {
        var request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/v1/pairings"))
                .header("Content-Type", "application/json")
                .header("X-Forwarded-For", "203.0.113." + forwardedSuffix)
                .POST(HttpRequest.BodyPublishers.ofString("{\"code\":\"invalid\"}")).build();
        return client.send(request, HttpResponse.BodyHandlers.ofString());
    }
}

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class PairingAddressLimitIntegrationTest extends PairingRateLimitChecks {
    @Test void defaultAddressLimitCountsInvalidCodesAndIgnoresForgedForwardedAddresses() throws Exception {
        assertThat(config.pairingAttemptsPerMinute()).isEqualTo(5);
        assertThat(config.pairingGlobalAttemptsPerMinute()).isEqualTo(60);
        try (var client = HttpClient.newHttpClient()) {
            for (int i = 0; i < 5; i++) assertThat(invalidCode(client, i).statusCode()).isEqualTo(404);
            var rejected = invalidCode(client, 6);
            assertThat(rejected.statusCode()).isEqualTo(429);
            assertThat(rejected.headers().firstValue("Retry-After")).hasValue("60");
            assertThat(rejected.body()).contains("rate_limited");
        }
    }
}

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = "fsapp.pairing-global-attempts-per-minute=3")
class PairingGlobalLimitIntegrationTest extends PairingRateLimitChecks {
    @Test void globalLimitRejectsRequestsWhileAddressStillHasBudget() throws Exception {
        assertThat(config.pairingAttemptsPerMinute()).isEqualTo(5);
        try (var client = HttpClient.newHttpClient()) {
            for (int i = 0; i < 3; i++) assertThat(invalidCode(client, i).statusCode()).isEqualTo(404);
            var rejected = invalidCode(client, 4);
            assertThat(rejected.statusCode()).isEqualTo(429);
            assertThat(rejected.headers().firstValue("Retry-After")).hasValue("60");
        }
    }
}
