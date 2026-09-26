# Validation and release evidence

Local implementation validation began on 14 September 2026 UTC (15 September
in Asia/Kolkata). This is a portfolio beta, with physical-device and live-hosting
gates remaining. The Android prototype is excluded from these results.

## Executed checks

| Check | Result and boundary |
| --- | --- |
| Backend | 37 tests pass: 22 signaling/pairing integration tests with real HTTP/WebSocket clients, 2 real HTTP guessing-limit tests, 3 real HTTP mock-provider tests, 10 concurrency/resource tests |
| Browser protocol | 61 Vitest tests pass; real Web Crypto HMAC fixture, altered/replayed messages, bounds, consent, offset/hash/size failures, backpressure, sink failures and cancellation |
| Build | TypeScript, ESLint, Vite production build, Maven verify pass |
| Chromium 153 | 18 tests pass, including the real Java restart case; 1 live-TURN check gated |
| Backend restart | A dedicated Java process was terminated and restarted during an 8 MiB direct transfer with controlled 250 ms write-ACK delay; the old room returned 410, the transfer completed, and downloaded bytes matched |
| Firefox 155 / WebKit 26.6 | 17 tests pass in each engine; 1 live-TURN gate and 1 duplicate restart case skipped per engine |
| Dependencies | OSV Scanner 2.6.0 scanned 82 resolved Java components (including tests) and 196 npm lockfile packages; no known advisories after updating Tomcat to 11.0.25. npm audit also found none |
| Docker | Multi-stage image passes all 37 Java tests; Chromium batch transfer passes with default pairing limits, UID 999, 512 MiB/1 CPU and nondefault PORT; healthy runtime and graceful shutdown confirmed |

[Machine-readable browser results](measurements/browser-validation.json) record
the final run. All three engines transferred empty, binary, Unicode/duplicate-name
files and ten-file batches with the exact 100 MiB boundary. Tests also cover
single-use codes, matching phrases, the sender-approval barrier, corrupted pairing keys,
cancellation during a real pending code claim, restored-page cleanup, retained
downloads, and limits. The receiver sees no filenames and neither browser requests
ICE before sender approval.
Unicode filenames may be canonically normalized by macOS/WebKit; file content
is compared byte-for-byte.

The final six-digit run completed 52 browser tests with 5 expected skips and no
failures or retries against an immutable packaged Java application on loopback
port 8092. Tests use real browser WebRTC and actual downloaded bytes. The dedicated
test server raises guessing limits to allow repeated automation; separate backend
tests prove the production defaults of five attempts per address per minute and
sixty globally, plus rate-window recovery. The cold-start cancellation test controls request latency; it does not
measure a real sleeping Render service. Provider tests use a local HTTP fixture;
they do not prove Cloudflare credentials or relay connectivity.

[Docker runtime evidence](measurements/docker-code-validation.json) records a separate
Chromium transfer of empty, Unicode, and binary files through the production image
with default guessing limits. Four subsequent invalid code requests returned 404;
the next two returned 429 after the successful browser claim had used one attempt.
The health check was UP, the process ran as UID 999 with 512 MiB/1 CPU, and SIGTERM
logged graceful shutdown with no OOM kill. The refreshed local review app uses
this same image on port 8091 with the production limits.

The dependency check initially caught three Tomcat advisories inherited through
Spring Boot 4.1.1. The POM pins Tomcat 11.0.25, and the full backend suite and OSV
scan passed afterward. See [Apache's fixed-version report](https://tomcat.apache.org/security-11).
Dependency advisories can change after this snapshot.

## Measured local transfer

[Raw JSON with samples](measurements/chromium-same-host.json) was recorded at
2026-09-14T19:11:26Z on Apple M4, 24 GiB RAM, macOS Darwin 25.6.0, Node 24.19.0,
Chromium 153.0.8010.12. Two isolated browser contexts shared one dedicated browser
process tree; Java served a warm loopback origin. The Blob fallback was selected.
Other system workload was uncontrolled. One repetition per size; this is not an
internet throughput claim or a mobile benchmark. Pairing measurements include
automated code entry, phrase comparison, and sender approval; they do not measure
how long a person takes to compare and approve.

| Measurement | Result |
| --- | --- |
| Create code to receiver consent (including automated sender approval) | 495 ms |
| Sender approval click to receiver consent | 83 ms |
| 1 MiB accept to verified | 120 ms |
| 100 MiB accept to verified | 10,177 ms |
| Verified download comparison | Byte-identical for both files |
| Maximum observed DataChannel buffered bytes | 49,152 bytes over the run |
| Maximum binary frame | 16,384 bytes |
| Dedicated browser tree RSS before transfer | 554.53 MiB |
| Sampled RSS peak during 100 MiB transfer | 865.47 MiB |
| RSS one second after file release | 880.36 MiB |
| RSS one second after closing both contexts | 192.08 MiB |

RSS sums only that browser and its children; shared resident pages may be counted
more than once. It includes both pages and browser utilities, excludes Java and
Node, and was sampled every 250 ms. JS heap figures in the JSON exclude Blob and
native WebRTC storage. No forced garbage collection was used. The observed peak
shows why a 100 MiB Blob fallback still needs physical phone validation. Protocol
queue limits are not a claim that total browser memory stays below 100 MiB.

Reproduce with Node 24, a packaged server, and installed Chromium:

```sh
cd web
npm run benchmark
```

The script writes a new JSON artifact under `.artifacts/benchmarks`. Set
`FSAPP_BASE_URL` to change origin. An optional `FSAPP_CHROMIUM_EXECUTABLE` selects
an already installed browser; record its version when comparing results.

Render access was checked in the browser and showed its sign-in page. No Render
credentials or Cloudflare TURN master credentials were available in this session.
No public deployment or live provider relay test is claimed.

## Release gates requiring deployment or hardware

| Gate | Required evidence |
| --- | --- |
| HTTPS Render demo | Public URL, one instance, health check, canonical origin/CSP, host-assigned port, cold-start retry, graceful restart |
| Cloudflare managed TURN | Direct and `?relay=only` routes across different networks; actual temporary credential issuance; usage observation and issuance switch |
| Android Chrome, physical device | Exact browser/device/OS; empty, binary, Unicode/duplicate names, ten-file and 100 MiB transfers; memory and download behavior |
| Safari, physical iPhone | Same cases plus save/share behavior, screen lock, reload, foreground/background transitions and cleanup |
| Faults on target devices | Cancellation in flight, lost network, save denial, failed peer connection, backend restart; partial-file cleanup and retained completed downloads |
| Two-minute phone/computer recording | Actual HTTPS application and physical devices, as described in [the demo storyboard](DEMO.md) |

Record each run with date, application revision, device/OS/browser versions,
network topology, direct/relay route, file sizes and hashes, connection/transfer
time, memory method, outcome, and artifact links. Desktop WebKit and a narrow
viewport do not substitute for a physical iPhone or Android phone.

Run the gated managed-relay suite only after configuring server credentials:

```sh
cd web
FSAPP_BASE_URL=https://your-test-service.onrender.com FSAPP_TEST_TURN=1 FSAPP_SKIP_RESTART_TEST=1 npm run test:e2e
```

Use a dedicated test service with the [test-only pairing limits](DEPLOYMENT.md#automated-pairing-tests)
for this full suite; keep public-demo limits conservative.

`FSAPP_SKIP_RESTART_TEST=1` skips the local Java process test when testing only a
remote host. Physical tests are intentionally outside CI. The repository's GitHub
issue list was empty when queried during this audit; outstanding project work is
tracked here and in [the roadmap](../FUTURE_SCOPE.md).

## Portfolio claims supported by this evidence

Describe a Java/Spring trusted pairing service with atomic single-use six-digit
code redemption, sender approval, two-participant admission, authorization,
expiration, bounded outgoing queues, and real-WebSocket tests.
Describe client-side WebRTC transfers with authenticated signaling, incremental
verification, receiver consent, and reproducible same-host results. Link the
[technical failure write-up](FAILURE_WRITEUP.md). Do not claim universal browser
support, physical mobile verification, an operational HTTPS demo, or live relay
testing until those gates have actual evidence.
