package dev.fsapp.backend;

import java.util.Map;
import java.util.Set;
import tools.jackson.databind.JsonNode;

record SignalEnvelope(String roomId, String attemptId, String role, long seq, String kind, String payload, String mac) {
    private static final Set<String> FIELDS = Set.of("type", "version", "roomId", "attemptId", "role", "seq", "kind", "payload", "mac");

    static SignalEnvelope parse(JsonNode node) {
        if (!node.isObject() || node.size() != FIELDS.size() || !node.propertyNames().containsAll(FIELDS)
                || !"signal".equals(node.path("type").asText()) || !node.path("version").isInt() || node.path("version").intValue() != 1
                || !node.path("seq").isIntegralNumber() || !node.path("seq").canConvertToLong()
                || node.path("seq").longValue() < 0 || node.path("seq").longValue() > 9_007_199_254_740_991L) throw invalid();
        for (String field : Set.of("roomId", "attemptId", "role", "kind", "payload", "mac")) {
            if (!node.path(field).isString()) throw invalid();
        }
        String roomId = node.path("roomId").asText(), attemptId = node.path("attemptId").asText();
        String role = node.path("role").asText(), kind = node.path("kind").asText();
        String payload = node.path("payload").asText(), mac = node.path("mac").asText();
        if (!roomId.matches("[A-Za-z0-9_-]{24}") || !attemptId.matches("[A-Za-z0-9_-]{16,128}")
                || !Set.of("sender", "receiver").contains(role) || !Set.of("offer", "answer", "ice").contains(kind)
                || !payload.matches("[A-Za-z0-9_-]{1,60000}") || !mac.matches("[A-Za-z0-9_-]{43}")) throw invalid();
        return new SignalEnvelope(roomId, attemptId, role, node.path("seq").longValue(), kind, payload, mac);
    }

    Map<String, ?> asMap() {
        return Map.of("type", "signal", "version", 1, "roomId", roomId, "attemptId", attemptId,
                "role", role, "seq", seq, "kind", kind, "payload", payload, "mac", mac);
    }

    private static ApiException invalid() { return new ApiException(400, "invalid_signal", "Invalid signaling envelope."); }
}
