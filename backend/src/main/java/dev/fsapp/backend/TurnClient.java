package dev.fsapp.backend;

import java.time.Duration;
import java.util.List;
import java.util.Map;

interface TurnClient {
    List<Map<String, Object>> issue(Duration ttl);
}
