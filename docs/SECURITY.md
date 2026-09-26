# Security model

FSApp is a portfolio application, not an independently audited secure-messaging
product. Its implementation must be evaluated against the tests and limitations
recorded in VALIDATION.md.

## Intended protection

The Java service generates a 256-bit random pairing secret, a connection-attempt
ID, participant tokens, and a unique six-digit code. Creating a session returns
the strong secret to the sender over HTTPS. Redeeming the code returns it and
the receiver token to one receiver, atomically consuming the code. The code is
a lookup credential, never the HMAC key. Unapproved rooms expire after ten minutes.

Both browsers derive a matching four-word confirmation phrase from the strong
secret and session context. The sender must compare it with the intended receiver
through an existing trusted channel or by looking at both devices, then approve.
Java refuses ICE issuance and signaling before approval; filenames are not sent
until the resulting authenticated DataChannel opens. Receiver consent is still
required separately for every file.

Six digits have one million possible values. An attacker may guess and consume
a valid code, causing a failed pairing or presenting an unexpected confirmation
request. Sender approval is essential: do not approve a request merely because
it arrived. A device name would not authenticate the recipient. Cancel an
unexpected request and create a new code. The phrase checks that the intended
devices share the same pairing context; it does not identify a person or protect
against a malicious pairing service.

Each direction derives a signing key with HKDF-SHA-256. HMAC-SHA-256 authenticates
the versioned signaling envelope, including the offer/answer SDP fingerprints.
Clients verify it before applying remote negotiation data. Role, room, attempt,
message type, and sequence binding prevent accepting another session's messages
or downgrading to unauthenticated negotiation. WebRTC's DTLS transport protects
the peer DataChannel; there is no custom file cipher.

File names and sizes are exchanged only after establishing the authenticated
channel. Receipt requires exact byte count and incremental SHA-256 verification.
The hash detects transfer/implementation errors; its authentication comes from
the established channel, not from an unkeyed hash by itself.

## Trust and limitations

- The Java pairing service knows the strong secret and is trusted to pair the
  correct devices. Unlike the earlier browser-generated invitation design,
  HMAC does not authenticate against a compromised pairing backend. The service
  could impersonate a peer or substitute negotiation data if compromised.
- Anyone who obtains or guesses an unused code can claim the receiver slot.
  Single use and sender approval limit what follows; they do not make six digits
  a high-entropy secret. Rejected or abandoned claims require a fresh code.
- The application host, shipped JavaScript, browser, operating system, and both
  endpoints remain trusted. A compromised host can ship code that steals secrets.
- HMAC authenticates signaling; it does not hide SDP or network metadata from
  the service. Direct peers can learn each other's network addresses. Hosting and
  relay providers can observe addresses, timing, and traffic volume.
- TURN traffic passes through a server, encrypted. The promise is no cloud file
  storage, not that packets never pass through servers.
- Browser downloads are not proof of successful OS saves. Fallback UI reports
  verified receipt and download initiation separately.
- There is no malware scanning. Received content is never automatically opened
  or inserted as active HTML/SVG. Filenames are sanitized before saving.
- Background tabs, screen locks, VPNs, firewalls, and constrained devices may
  interrupt transfers. Files are limited to 100 MiB and one recipient.

## Deployment safeguards

Serve HTTPS, configure the canonical origin, keep provider credentials in server
environment variables, and never place them in frontend `VITE_*` settings.
Do not log request bodies, pairing codes or secrets, authorization tokens, or SDP.
Use the bundled restrictive content security policy and no third-party runtime
scripts. Provider logs have their own retention and privacy policies.

Use one server instance, bounded rooms, message limits, authorization timeouts,
rate limiting, temporary TURN credentials, and the relay issuance kill switch.
Code redemption counts successful, unsuccessful, and malformed attempts, with
defaults of five requests per minute per remote socket address and sixty per
minute globally. These bounded fixed windows limit online guessing; they are
not a guarantee against distributed abuse, boundary bursts, or denial of service.
Do not raise production limits merely to run the automated browser suite.
Application rate limits do not replace an edge abuse-control service. Client
file caps and provider alerts do not impose a hard billing ceiling. A kill switch
prevents new credentials; already issued credentials can remain usable until
expiry or provider revocation.

Report suspected security issues privately to the repository owner rather than
including working secrets or live pairing codes in public issues.

The optional QR URL contains only `#code=123456`, not participant tokens or the
strong secret. The browser removes this fragment from its current history entry
immediately after parsing, and does not persist pairing data in local storage.
The code is submitted in the HTTPS POST body, never a lookup URL or query string.
