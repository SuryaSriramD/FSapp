package dev.fsapp.backend;

import java.io.IOException;
import java.time.Duration;
import java.util.Map;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;
import tools.jackson.databind.ObjectMapper;

@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
final class SecurityHeadersFilter extends OncePerRequestFilter {
    private final AppProperties config;
    private final RateLimits limits;
    private final ObjectMapper json;
    SecurityHeadersFilter(AppProperties config, RateLimits limits, ObjectMapper json) {
        this.config = config; this.limits = limits; this.json = json;
    }

    @Override protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String origin = config.publicOrigin().isBlank() ? request.getScheme() + "://" + request.getHeader("Host") : config.publicOrigin();
        String websocketOrigin = origin.replaceFirst("^http", "ws");
        response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; "
                + "img-src 'self' data: blob:; font-src 'self'; connect-src 'self' " + websocketOrigin
                + "; worker-src 'self' blob:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'");
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("X-Frame-Options", "DENY");
        response.setHeader("Referrer-Policy", "no-referrer");
        response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
        response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
        if (origin.startsWith("https://")) response.setHeader("Strict-Transport-Security", "max-age=31536000");

        if (request.getRequestURI().startsWith("/v1/") || request.getServletPath().startsWith("/v1/")) {
            response.setHeader("Cache-Control", "no-store");
            try {
                if (!request.getRequestURI().equals(request.getContextPath() + request.getServletPath())) {
                    throw new ApiException(400, "noncanonical_path", "Use the canonical API path.");
                }
                String suppliedOrigin = request.getHeader("Origin");
                if (suppliedOrigin != null && !suppliedOrigin.equals(origin) && !config.origins().contains(suppliedOrigin)) {
                    throw new ApiException(403, "origin_rejected", "This origin cannot access the connection service.");
                }
                if ("cross-site".equals(request.getHeader("Sec-Fetch-Site")) && suppliedOrigin == null) {
                    throw new ApiException(403, "origin_rejected", "This origin cannot access the connection service.");
                }
                String clientIp = request.getRemoteAddr();
                limits.require("http:" + clientIp, config.requestPerMinute(), Duration.ofMinutes(1));
                if (request.getMethod().equals("POST") && request.getRequestURI().equals("/v1/sessions")) {
                    limits.require("create:" + clientIp, config.createPerMinute(), Duration.ofMinutes(1));
                }
                boolean pairing = request.getMethod().equals("POST") && request.getRequestURI().equals("/v1/pairings");
                if (pairing) {
                    limits.require("pairing:" + clientIp, config.pairingAttemptsPerMinute(), Duration.ofMinutes(1));
                    limits.require("pairing:global", config.pairingGlobalAttemptsPerMinute(), Duration.ofMinutes(1));
                    if (request.getContentLengthLong() > SessionController.MAX_PAIRING_BODY_BYTES) {
                        throw new ApiException(413, "too_large", "The pairing request is too large.");
                    }
                    String contentType = request.getContentType();
                    if (contentType == null || !contentType.split(";", 2)[0].trim().equalsIgnoreCase("application/json")) {
                        throw new ApiException(415, "unsupported_media_type", "Send the pairing code as JSON.");
                    }
                } else if (request.getContentLengthLong() > 0 || request.getHeader("Transfer-Encoding") != null) {
                    throw new ApiException(413, "unexpected_body", "These endpoints do not accept request bodies.");
                }
            } catch (ApiException error) {
                response.setStatus(error.status);
                if (error.status == 429) response.setHeader("Retry-After", "60");
                response.setContentType("application/json");
                response.getWriter().write(json.writeValueAsString(Map.of("code", error.code, "message", error.getMessage())));
                return;
            }
        }
        chain.doFilter(request, response);
    }
}
