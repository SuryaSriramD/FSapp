FROM node:24-bookworm-slim AS frontend
WORKDIR /build/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM maven:3.9.11-eclipse-temurin-21 AS backend
WORKDIR /build/backend
COPY backend/pom.xml ./
RUN mvn -B -ntp dependency:go-offline
COPY backend/src ./src
COPY --from=frontend /build/web/dist ./src/main/resources/static
RUN mvn -B -ntp verify

FROM eclipse-temurin:21-jre-jammy AS runtime
RUN groupadd --system fsapp && useradd --system --gid fsapp --home-dir /app fsapp
WORKDIR /app
COPY --from=backend --chown=fsapp:fsapp /build/backend/target/*.jar ./fsapp.jar
ENV PORT=8080
ENV JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=60.0 -XX:+ExitOnOutOfMemoryError"
USER fsapp
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/fsapp.jar"]
