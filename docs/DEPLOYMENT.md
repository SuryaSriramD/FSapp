# Deployment

## Docker

The multi-stage image builds the TypeScript client, packages its assets into the
Java application, runs backend tests, and uses a non-root Java 21 runtime.

```sh
docker build -t fsapp .
docker run --rm --name fsapp -p 8080:8080 --env-file .env fsapp
```

On a macOS external volume where Docker reports extended-attribute errors, use
`./scripts/docker-build.sh fsapp` to stream a clean build context.

Copy `.env.example` to `.env` first. The file is ignored by Git. The local URL is
`http://localhost:8080`; localhost is a browser secure-context exception.
Phone access through an arbitrary LAN HTTP address is not a substitute for HTTPS.

## Render

1. Connect the repository in Render and create the service from `render.yaml`.
2. Keep **one instance** and the Docker runtime. Configure the assigned HTTPS URL
   as `FSAPP_PUBLIC_ORIGIN`, with no trailing slash.
3. Configure `/actuator/health` as the health-check path. Do not expose additional
   management endpoints.
4. Deploy and verify the HTTPS home page, six-digit and QR pairing, sender approval, security headers,
   and two-browser transfer before sharing the URL.
5. Manually verify a two-device transfer with the default guessing limits. Run
   the full browser suite against a separate test service as described below.

The blueprint does not automatically deploy or create an account. Free services
can sleep and take time to start again. Active signaling uses heartbeat traffic;
there is no external perpetual keep-awake job. Deployments/restarts discard RAM
state. [Render free-service behavior](https://render.com/docs/free).

## Cloudflare TURN

Create a TURN key in Cloudflare Realtime, then configure these **server-only**
variables in Render:

```text
FSAPP_TURN_ENABLED=true
FSAPP_TURN_KEY_ID=<key id>
FSAPP_TURN_API_TOKEN=<key API token>
```

The backend issues expiring client credentials. Never commit the master key or
copy it into frontend configuration. Without these settings the app uses STUN
and direct connectivity; cross-network delivery is best-effort and must not be
reported as relay-tested.

Check Cloudflare's current free allowance and actual egress usage before a public
demo. Set provider usage alerts, review usage after demos, and disable
`FSAPP_TURN_ENABLED` if usage becomes unexpected. Disable/revoke credentials at
the provider for an incident; toggling issuance does not revoke existing ones.
There is no guaranteed zero-charge budget cap.

- [Credential configuration](https://developers.cloudflare.com/realtime/turn/generate-credentials/)
- [Provider pricing](https://developers.cloudflare.com/realtime/sfu/pricing/)
- [Provider usage analytics](https://developers.cloudflare.com/realtime/turn/analytics/)

## Service limits and usage

The default caps are 500 rooms, 1,000 WebSockets, 20 session creations per minute
per remote socket address, 120 API requests per minute per address, six ICE
requests per minute per participant, and 300 signaling messages per ten seconds.
Code redemption additionally permits five attempts per minute per remote socket
address and sixty per minute globally, including invalid and successful requests.
Set `FSAPP_PAIRING_ATTEMPTS_PER_MINUTE` and
`FSAPP_PAIRING_GLOBAL_ATTEMPTS_PER_MINUTE` to configure these bounds. Codes expire
after ten minutes and are consumed by the first successful redemption. If someone
claims the wrong code, the sender can reject it by cancelling and creating another.
The bounded rate-limit map rejects new keys at capacity. TURN issuance additionally
has a bounded per-participant cache and concurrent request deduplication.

Forwarded IP headers are deliberately not trusted. Behind Render, the socket
address may be a shared proxy, so request limits may apply to multiple visitors
together. Treat this as a conservative public-demo limit; use trusted edge rate
controls if you need higher traffic. Do not blindly trust client-supplied
`X-Forwarded-For` to make limits appear per-user.

TURN credentials default to the remaining live-room lifetime, at most two hours.
`FSAPP_TURN_TTL` can shorten that window; v1 does not renew an established relay
allocation through an ICE restart. Shortening it may require users to re-pair
sooner. The kill switch takes effect through server configuration/restart and
stops new issuance; revoke at Cloudflare for an immediate provider response.

Check Render memory/CPU, restarts, and 429/503 response counts. Review Cloudflare
TURN usage and allocation/egress analytics after test runs. Avoid access-log
formats containing headers, SDP, request bodies, or pairing codes. Health intentionally
exposes no internal state or secrets.

## Automated pairing tests

Repeated browser tests exceed the public code-guessing allowance by design. The
Playwright-managed local server uses explicit test-only pairing limits. For an
already running `FSAPP_BASE_URL`, use a separate local container/test deployment
with `FSAPP_PAIRING_ATTEMPTS_PER_MINUTE=1000` and
`FSAPP_PAIRING_GLOBAL_ATTEMPTS_PER_MINUTE=1000`, then stop it after validation.
Do not weaken the public demo's guessing limits to accommodate CI. Low-limit
backend tests separately verify rejection and rate-window expiry.

## Rollback

Redeploy the last tested Docker revision. Deploy frontend and backend as one
artifact. Pending sessions must re-pair; established peer connections may finish
independently. Do not run incompatible application revisions as parallel room
servers. Keep secrets in provider configuration rather than image layers.
