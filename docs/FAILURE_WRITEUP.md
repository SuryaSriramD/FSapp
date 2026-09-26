# Debugging a WebSocket handshake that returned HTTP 405

FSApp uses the same room URL for two operations: a WebSocket connection starts
with `GET /v1/sessions/{id}` and an HTTP upgrade, while a participant closes the room
with `DELETE /v1/sessions/{id}`. During implementation, room creation succeeded,
but a real Java WebSocket client could not connect. Its opening handshake failed
with `Unexpected HTTP response status code 405` instead of the required `101
Switching Protocols`.

## Cause

The application registered a Spring MVC DELETE endpoint in
[`SessionController.delete()`](../backend/src/main/java/dev/fsapp/backend/SessionController.java)
and a WebSocket handler for `/v1/sessions/*`. Both registrations were individually
valid, but their handler mappings were evaluated in the wrong order for this
shared path.

MVC examined the upgrade request first. It found a matching room path, recognized
that GET was unsupported by the controller, and returned 405. Processing ended
before the WebSocket mapping could handle the upgrade. The failure happened
before participant authentication or WebRTC negotiation.

Calling the room registry directly in unit tests would not reproduce this bug;
it required a request through the actual embedded server and its handler mappings.

## Fix

[`WebConfiguration.upgradeOnlyMapping()`](../backend/src/main/java/dev/fsapp/backend/WebConfiguration.java)
configures each `WebSocketHandlerMapping` before initialization:

```java
mapping.setOrder(-1);
mapping.setWebSocketUpgradeMatch(true);
```

The first setting lets WebSocket upgrades be considered before MVC's method
checks. The second restricts that mapping to upgrade requests, allowing ordinary
DELETE requests to reach the controller. Applying precedence alone would risk
the WebSocket mapping intercepting the REST operation.

The fix preserves the public URLs and their separate authorization flows. It
does not broaden the configured origin allowlist.

## Regression evidence

[`SignalingIntegrationTest`](../backend/src/test/java/dev/fsapp/backend/SignalingIntegrationTest.java)
starts the actual Spring Boot server on a random port and uses Java HTTP and
WebSocket clients:

- `realWebSocketsAuthenticatePairAndForwardOnlyValidRoleMessages()` opens both
  sockets, authenticates their roles, explicitly approves pairing, observes peer readiness, and exchanges
  offer, answer, and ICE envelope fixtures.
- `requiresJoinedParticipantForIceAndParticipantForDelete()` exercises the same room
  path through both protocols. It verifies participant requirements for ICE,
  rejects an unauthorized DELETE, and accepts a participant's DELETE with HTTP 204
  and a session-closed notification. The six-digit pairing revision also permits
  a claimed receiver to close the room before its WebSocket connects, so a
  cancelled code lookup cannot strand the sender.

Run these checks from the repository root:

```sh
cd backend
./mvnw '-Dtest=SignalingIntegrationTest#realWebSocketsAuthenticatePairAndForwardOnlyValidRoleMessages+requiresJoinedParticipantForIceAndParticipantForDelete' test
```

On filesystems that create AppleDouble `._*.class` sidecars, add
`-Dfsapp.buildDirectory=/tmp/fsapp-backend-review` so compiled classes stay on a
native filesystem. The full backend suite passed 25 tests after this fix and the
subsequent resource-limit regressions on September 15, 2026.

These tests establish routing, authorization, and signaling behavior. Their
fixture payloads do not establish browser interoperability, valid SDP/HMAC
handling in the clients, file-transfer throughput, or functioning managed TURN.
Those require the separate browser and deployment checks.
