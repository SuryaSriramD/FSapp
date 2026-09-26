package dev.fsapp.backend;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

class CloudflareTurnClientTest {
    @Test void postsServerSecretAndTemporaryTtlAndReturnsOnlyIceConfiguration() throws Exception {
        AtomicReference<String> auth = new AtomicReference<>(), requestBody = new AtomicReference<>();
        var server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/credentials", exchange -> {
            auth.set(exchange.getRequestHeaders().getFirst("Authorization"));
            requestBody.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            byte[] body = """
                    {"iceServers":[{"urls":["stun:stun.cloudflare.com:3478"]},
                    {"urls":"turn:turn.cloudflare.com:3478?transport=udp","username":"temporary-user","credential":"temporary-secret"}],
                    "extra":"must-not-be-forwarded"}
                    """.getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, body.length); exchange.getResponseBody().write(body); exchange.close();
        });
        server.start();
        var client = client(server, Duration.ofSeconds(3));
        try {
            var servers = client.issue(Duration.ofMinutes(7));
            assertThat(auth.get()).isEqualTo("Bearer test-secret");
            assertThat(JsonMapper.builder().build().readTree(requestBody.get()).path("ttl").intValue()).isEqualTo(420);
            assertThat(servers).hasSize(2);
            assertThat(servers.get(1)).containsEntry("username", "temporary-user").containsEntry("credential", "temporary-secret");
            assertThat(servers.toString()).doesNotContain("must-not-be-forwarded");
        } finally { client.shutdown(); server.stop(0); }
    }

    @Test void rejectsAnOversizedProviderResponseWithoutExposingIt() throws Exception {
        var server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/credentials", exchange -> {
            byte[] body = ("private-provider-data" + "x".repeat(40_000)).getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, body.length);
            try { exchange.getResponseBody().write(body); } finally { exchange.close(); }
        });
        server.start(); var client = client(server, Duration.ofSeconds(3));
        try {
            assertThatThrownBy(() -> client.issue(Duration.ofMinutes(5))).isInstanceOf(ApiException.class)
                    .hasMessage("Relay is unavailable. Direct connections may still work.");
        } finally { client.shutdown(); server.stop(0); }
    }

    @Test void enforcesDeadlineWhenProviderSendsHeadersThenStalls() throws Exception {
        var server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        var release = new CountDownLatch(1); var headersSent = new CountDownLatch(1);
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            server.setExecutor(executor);
            server.createContext("/credentials", exchange -> {
                exchange.sendResponseHeaders(200, 200);
                exchange.getResponseBody().write('x'); exchange.getResponseBody().flush(); headersSent.countDown();
                try { release.await(5, TimeUnit.SECONDS); } catch (InterruptedException error) { Thread.currentThread().interrupt(); }
                exchange.close();
            });
            server.start(); var client = client(server, Duration.ofMillis(500));
            try {
                long started = System.nanoTime();
                assertThatThrownBy(() -> client.issue(Duration.ofMinutes(5))).isInstanceOf(ApiException.class);
                assertThat(headersSent.getCount()).isZero();
                assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(Duration.ofSeconds(2));
            } finally { release.countDown(); client.shutdown(); server.stop(0); }
        }
    }

    private CloudflareTurnClient client(HttpServer server, Duration timeout) {
        return new CloudflareTurnClient(TestSupport.config(true), JsonMapper.builder().build(),
                URI.create("http://127.0.0.1:" + server.getAddress().getPort() + "/credentials"), timeout);
    }
}
