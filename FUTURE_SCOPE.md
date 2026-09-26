# FSApp roadmap

The selected release is a Java-backed web portfolio project. This supersedes the
previous Android/Firebase and Worker/Durable Object plans. There is no migration
of users or stored files.

## Current implementation

The repository contains the Spring Boot connection service, React client,
authenticated WebRTC protocol, sequential transfers, receiver consent, bounded
buffering, incremental verification, six-digit pairing with sender approval,
optional QR scanning, tests, and Docker/Render
configuration. See [validation](docs/VALIDATION.md) for actual executed checks;
implementation and configuration alone do not establish release readiness.

## Remaining release work

1. Deploy one HTTPS Render instance and configure Cloudflare TURN server secrets.
2. Run direct and forced-relay transfers across different networks; record routes,
   browser versions, connection time, transfer time, and memory observations.
3. Complete physical Android Chrome and iPhone Safari checks, especially save,
   screen lock, network loss, reload, and the 100 MiB fallback.
4. Record a two-minute phone/computer demo on the deployed application. Publish
   measured results with named conditions and the regression write-up.
5. Keep the public demo within monitored relay usage; maintain dependency checks.

A portfolio description should explain Java's room concurrency, authorization,
single-use code redemption, service lifecycle, protocol validation, and
real-WebSocket integration tests.
WebRTC transfers file bytes on the clients. Do not claim identity verification,
zero infrastructure, universal connectivity, background delivery, or browser
support that has not been tested.

## Next milestone: native Android

Build a new Android client against the documented web protocol once the web
release passes its gates. Add native file access, URI permission management,
Keystore integration where appropriate, and lifecycle handling. Reuse protocol
fixtures and interoperability tests; do not promote the existing experimental
Firebase code into a production client without redesign.

## Deferred

Accounts, folders, automatic discovery, more than two participants, cloud file
storage, background transfers, resumability, multi-instance coordination,
Redis/databases, and message brokers. Re-pairing restarts the interrupted file.
Completed downloads remain available on the receiving device.
