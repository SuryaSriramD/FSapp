package dev.fsapp.backend;

import java.util.Map;

interface Peer {
    String id();
    void send(Map<String, ?> message);
    void close(String reason);
}
