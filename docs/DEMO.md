# Demonstrating FSApp

## Reproducible local recording

Start the packaged application as described in the README. In another terminal:

```sh
cd web
npm ci
npx playwright install chromium
node scripts/demo.mjs
```

The script uses `http://127.0.0.1:8080` by default. Set `FSAPP_BASE_URL` for an
already deployed HTTPS instance. `FSAPP_CHROMIUM_EXECUTABLE` can specify an
installed Chromium binary; otherwise the script uses Playwright's browser or
falls back to a locally cached headless Chromium revision.

It records a real two-file transfer between separate browser contexts, downloads
both files, and compares the downloaded bytes with their originals. One page is
1060 pixels wide; the receiver is **a simulated 390-pixel viewport in desktop
Chromium**. The beta badges are annotated to make this distinction visible.
The script does not simulate a phone operating system, touch behavior, Safari,
network conditions, or transfer progress.

Artifacts are written under ignored `.artifacts/demo/` at the repository root,
separate from Playwright's frequently cleared test-results directory:

| Artifact | What it shows |
|---|---|
| `desktop-sender.webm` | Actual sender flow with pairing approval. |
| `simulated-phone-viewport.webm` | The narrower receiver's consent, receipt, download, and batch progression. |
| Numbered PNGs | Home, pairing code, confirmation, consent, verified downloads, and sender completion. |
| `recording.json` | Browser version, environment, actual byte counts/timings, and completion status. |

The two WebM files are separate recordings of the same session. Readable pauses
are intentional; timings in `recording.json` exclude those pauses from the
per-file accept-to-verification measurement. These are **same-host demonstration
measurements**, not throughput claims or evidence of cross-network reliability.

The code visible in a recording is single use and temporary. The script resets the sender
and closes both contexts before finishing. Review generated artifacts before
publishing them, and do not present this automated recording as physical-device
validation.

## Two-minute physical phone/computer storyboard

Use a deployed HTTPS instance, a real phone, and a computer. Keep both devices
unlocked and visible in a continuous camera recording; desktop screen capture
alone does not establish phone behavior. Use harmless files that may be shown.

| Time | Action and narration |
|---|---|
| 0:00–0:15 | Show both devices and name the browsers/versions. Explain: “A six-digit code connects two browsers. No account or cloud file storage.” |
| 0:15–0:35 | On the computer, select a text document and a small binary/image file. Create a code. Mention the ten-file and 100 MiB limits. |
| 0:35–0:55 | On the phone, open Receive and type the six digits (or scan the optional QR). Compare the four-word phrase on both devices and approve on the computer. Show that filenames appear only after approval. |
| 0:55–1:15 | Accept the first file. Keep both screens visible while progress changes and verification completes. Explain the displayed direct/relay route without claiming the untested alternative. |
| 1:15–1:35 | Request the download. Open the phone's actual download/file manager and establish that the file is present. Explain that “Download requested” alone cannot confirm an OS save. |
| 1:35–1:50 | Return to the live page, advance to the next file, and accept it. Demonstrate that the next file requires another deliberate action. |
| 1:50–2:00 | Show the final receipt on both devices. State the tested device/network combination and one limitation: both browsers must remain available. |

Do not rush browser or OS dialogs to meet the time target. If switching to the
file manager interrupts the transfer on that browser/device, show the failure
honestly and record the limitation. Save a separate successful continuous flow
after resolving the cause rather than editing failure into apparent success.

## Physical-device and deployment release gate

The automated script does **not** complete these checks:

- A public HTTPS deployment with the correct allowed origin and health checks.
- Physical Android Chrome and iPhone Safari in both sending and receiving roles.
- Same-Wi-Fi and genuinely different-network transfers, including mobile data.
- Configured managed TURN with the forced-relay test enabled; otherwise relay
  remains unverified.
- Real screen lock, camera permission, save denial, browser reload, and OS download
  behavior.
- Byte/hash comparison of files exported by the phone and an exact 100 MiB test
  on the supported physical devices.

Record the date, device model, OS/browser versions, network arrangement, observed
route, file sizes, hashes, timings, and failures. Publish only the combinations
that passed. The portfolio video and compatibility matrix become physical-device
evidence after this gate has actually been run.
