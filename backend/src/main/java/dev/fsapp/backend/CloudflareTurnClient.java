package dev.fsapp.backend;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Flow;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import jakarta.annotation.PreDestroy;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@Component
final class CloudflareTurnClient implements TurnClient {
    private final HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build();
    private final AppProperties config;
    private final ObjectMapper json;
    private final URI endpoint;
    private final Duration responseTimeout;

    @Autowired
    CloudflareTurnClient(AppProperties config, ObjectMapper json) {
        this(config, json, URI.create("https://rtc.live.cloudflare.com/v1/turn/keys/" + config.turnKeyId() + "/credentials/generate-ice-servers"), Duration.ofSeconds(5));
    }

    CloudflareTurnClient(AppProperties config, ObjectMapper json, URI endpoint, Duration responseTimeout) {
        this.config = config; this.json = json; this.endpoint = endpoint; this.responseTimeout = responseTimeout;
    }

    @Override public List<Map<String, Object>> issue(Duration ttl) {
        var request = HttpRequest.newBuilder(endpoint).timeout(responseTimeout)
                .header("Authorization", "Bearer " + config.turnApiToken())
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(json.writeValueAsString(Map.of("ttl", ttl.toSeconds())))).build();
        var pending = client.sendAsync(request, ignored -> new BoundedBody());
        try {
            var response = pending.get(responseTimeout.toMillis(), TimeUnit.MILLISECONDS);
            if (response.statusCode() != 200) throw unavailable();
            return parseServers(json.readTree(response.body()).path("iceServers"));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw unavailable();
        } catch (ExecutionException | TimeoutException | RuntimeException e) {
            // Provider error bodies and credential values must never reach application logs or clients.
            throw unavailable();
        } finally {
            if (!pending.isDone()) pending.cancel(true);
        }
    }

    @PreDestroy void shutdown() { client.shutdownNow(); }

    private List<Map<String, Object>> parseServers(JsonNode servers) {
        if (!servers.isArray() || servers.isEmpty() || servers.size() > 16) throw unavailable();
        List<Map<String, Object>> result = new ArrayList<>();
        boolean hasTurn = false;
        for (JsonNode server : servers) {
            List<String> urls = new ArrayList<>();
            JsonNode raw = server.path("urls");
            if (raw.isString()) urls.add(raw.asText());
            else if (raw.isArray()) {
                for (JsonNode url : raw) {
                    if (!url.isString()) throw unavailable();
                    urls.add(url.asText());
                }
            } else throw unavailable();
            if (urls.isEmpty() || urls.size() > 16
                    || urls.stream().anyMatch(u -> !u.matches("(?:stun|turn|turns):[^\\s]{1,500}"))) throw unavailable();
            if (urls.stream().anyMatch(u -> u.startsWith("turn:") || u.startsWith("turns:"))) {
                String username = server.path("username").asText(), credential = server.path("credential").asText();
                if (username.isBlank() || credential.isBlank() || username.length() > 1024 || credential.length() > 2048) throw unavailable();
                result.add(Map.of("urls", urls, "username", username, "credential", credential));
                hasTurn = true;
            } else result.add(Map.of("urls", urls));
        }
        if (!hasTurn) throw unavailable();
        return List.copyOf(result);
    }

    /** Byte limit and deadline both cover the entire body, including a provider that stalls after headers. */
    private static final class BoundedBody implements HttpResponse.BodySubscriber<byte[]> {
        private final CompletableFuture<byte[]> body = new CompletableFuture<>();
        private final ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        private Flow.Subscription subscription;
        @Override public CompletionStage<byte[]> getBody() { return body; }
        @Override public void onSubscribe(Flow.Subscription value) { subscription = value; value.request(1); }
        @Override public void onNext(List<ByteBuffer> buffers) {
            for (ByteBuffer buffer : buffers) {
                if (buffer.remaining() > 32_768 - bytes.size()) {
                    subscription.cancel();
                    body.completeExceptionally(new IOException("TURN response exceeded the size limit"));
                    return;
                }
                byte[] chunk = new byte[buffer.remaining()]; buffer.get(chunk); bytes.writeBytes(chunk);
            }
            subscription.request(1);
        }
        @Override public void onError(Throwable error) { body.completeExceptionally(error); }
        @Override public void onComplete() { body.complete(bytes.toByteArray()); }
    }

    private static ApiException unavailable() { return new ApiException(503, "relay_unavailable", "Relay is unavailable. Direct connections may still work."); }
}
