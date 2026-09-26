package dev.fsapp.backend;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;
import org.springframework.web.socket.server.standard.ServletServerContainerFactoryBean;
import org.springframework.web.socket.server.support.WebSocketHandlerMapping;

@Configuration
@EnableWebSocket
class WebConfiguration implements WebSocketConfigurer {
    private final SignalingHandler handler;
    private final AppProperties config;
    WebConfiguration(SignalingHandler handler, AppProperties config) { this.handler = handler; this.config = config; }

    @Override public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        var registration = registry.addHandler(handler, "/v1/sessions/*");
        if (!config.origins().isEmpty()) registration.setAllowedOrigins(config.origins().toArray(String[]::new));
    }

    @Bean
    static BeanPostProcessor upgradeOnlyMapping() {
        return new BeanPostProcessor() {
            @Override public Object postProcessBeforeInitialization(Object bean, String name) {
                // GET upgrades and DELETE share the room path. Match only upgrades before MVC's method checks.
                if (bean instanceof WebSocketHandlerMapping mapping) {
                    mapping.setOrder(-1);
                    mapping.setWebSocketUpgradeMatch(true);
                }
                return bean;
            }
        };
    }

    @Bean
    ServletServerContainerFactoryBean webSocketContainer() {
        var container = new ServletServerContainerFactoryBean();
        container.setMaxTextMessageBufferSize(SignalingHandler.MAX_MESSAGE_BYTES);
        container.setMaxBinaryMessageBufferSize(1);
        container.setAsyncSendTimeout(5000L);
        container.setMaxSessionIdleTimeout(2 * 60 * 60 * 1000L);
        return container;
    }
}
