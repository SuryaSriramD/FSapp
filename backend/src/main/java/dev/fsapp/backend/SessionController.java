package dev.fsapp.backend;

import java.time.Duration;
import java.io.IOException;
import java.util.Map;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.ObjectReader;
import tools.jackson.databind.DeserializationFeature;

@RestController
final class SessionController {
    static final int MAX_PAIRING_BODY_BYTES = 128;
    private final RoomRegistry rooms;
    private final IceService ice;
    private final RateLimits limits;
    private final ObjectReader pairingJson;
    SessionController(RoomRegistry rooms, IceService ice, RateLimits limits, ObjectMapper json) {
        this.rooms = rooms; this.ice = ice; this.limits = limits;
        this.pairingJson = json.reader().with(DeserializationFeature.FAIL_ON_READING_DUP_TREE_KEY)
                .with(DeserializationFeature.FAIL_ON_TRAILING_TOKENS);
    }

    @PostMapping("/v1/sessions")
    ResponseEntity<RoomRegistry.Created> create() { return ResponseEntity.status(201).body(rooms.create()); }

    @PostMapping("/v1/pairings")
    RoomRegistry.Claimed claim(HttpServletRequest request) throws IOException {
        byte[] body = request.getInputStream().readNBytes(MAX_PAIRING_BODY_BYTES + 1);
        if (body.length > MAX_PAIRING_BODY_BYTES) throw new ApiException(413, "too_large", "The pairing request is too large.");
        JsonNode node;
        try { node = pairingJson.readTree(body); }
        catch (RuntimeException error) { throw new ApiException(400, "invalid_request", "Send one six-digit code as JSON."); }
        if (node == null || !node.isObject() || node.size() != 1 || !node.path("code").isString()) {
            throw new ApiException(400, "invalid_request", "Send one six-digit code as JSON.");
        }
        return rooms.claim(node.path("code").asText());
    }

    @PostMapping("/v1/sessions/{id}/approve")
    ResponseEntity<Void> approve(@PathVariable String id, @RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String authorization) {
        rooms.approve(id, bearer(authorization));
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/v1/sessions/{id}/ice")
    IceService.Configuration ice(@PathVariable String id, @RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String authorization) {
        String token = bearer(authorization);
        var roomExpiresAt = rooms.authorizeIce(id, token);
        limits.require("ice:" + id + ":" + token, 6, Duration.ofMinutes(1));
        return ice.configuration(id + ":" + token, roomExpiresAt);
    }

    @DeleteMapping("/v1/sessions/{id}")
    ResponseEntity<Void> delete(@PathVariable String id, @RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String authorization) {
        rooms.delete(id, bearer(authorization));
        return ResponseEntity.noContent().build();
    }

    private String bearer(String authorization) {
        if (authorization == null || !authorization.matches("Bearer [A-Za-z0-9_-]{43}")) {
            throw new ApiException(401, "unauthorized", "A valid participant token is required.");
        }
        return authorization.substring(7);
    }
}

@RestControllerAdvice
class ApiErrors {
    @ExceptionHandler(ApiException.class)
    ResponseEntity<Map<String, String>> apiError(ApiException error) {
        var response = ResponseEntity.status(error.status);
        if (error.status == 429) response.header("Retry-After", "60");
        return response.body(Map.of("code", error.code, "message", error.getMessage()));
    }
}
