# Postal 2B — cross-machine broker

- Status: blocked on an external relay/trust-model decision
- Scope: transport for mail between OpenCode servers; M0–M3 semantics are unchanged
- Follows: M1 grants, M2 delivery/task separation, R-03 receiver dedupe

## 1. Why a broker

Pairing and HMAC keys live in the per-server plugin KV store. Two sessions on
different machines cannot share that store, so `postal_send` can only reach a
local session. A broker relays ciphertext between servers without becoming a
second authority model: grants, approvals, and task state stay local to each
plugin.

## 2. Proposed protocol

### Identity and pairing

1. Each session generates an Ed25519 signing key and an X25519 key-agreement
   key on first use; the public halves are registered with the broker under the
   session ID.
2. Pairing starts with a one-time 128-bit code shown in both TUIs. Each side
   resolves the code to the peer's public keys through the broker, derives a
   pair secret with X25519, and displays a short fingerprint. Both users
   confirm the fingerprint (TOFU), which prevents a broker from silently
   substituting keys.
3. The existing local `grants/<from>/<to>` records remain authoritative. A
   remote peer must still hold `send` for mail to be admitted.

### Envelope

- AEAD: XChaCha20-Poly1305 with the pair secret.
- AAD: `from`, `to`, `msg_id`, `issued_at`, `key_id`, and the envelope kind.
- The broker sees only routing metadata (from, to, msg_id, issued_at, size) and
  ciphertext. Message bodies, task IDs, and reply IDs stay inside the
  ciphertext.
- Size cap: 8 KiB cleartext per letter (matching the current letter cap), with
  a hard broker limit on ciphertext.

### Replay and delivery

- Signed requests use Ed25519 over method, path, body hash, and timestamp;
  the broker enforces a ±120s window and a nonce store.
- Receiver replay protection reuses the M0 `seen/<from>/<to>/<msg_id>` marker.
- Delivery is at-least-once with idempotent `msg_id`; the local outbox keeps
  its retry/backoff and `revoked` semantics.
- The broker stores undelivered ciphertext for a bounded TTL (proposed 7 days)
  and deletes it after acknowledgement.

### Key rotation and revocation

- `postal_rekey` sends a signed rotation notice; the old key verifies for the
  existing `keyGraceHours` grace window.
- Disconnect sends a revocation notice; the peer and broker drop the pair
  secret. Local grants are revoked as today.

## 3. Proposed configuration

| Option | Default | Effect |
| --- | --- | --- |
| `brokerURL` | unset | HTTPS relay base URL; unset keeps local-only mode |
| `brokerToken` | unset | Deployment credential for the relay |
| `brokerPollSeconds` | 30 | Fallback poll interval when SSE is unavailable |
| `brokerMaxBytes` | 16384 | Ciphertext size cap |
| `brokerReplaySeconds` | 120 | Accepted request timestamp skew |

`brokerURL` must be `https:`; plain `http:` is allowed only for loopback in
tests. A broker failure queues mail locally and never falls back to plaintext.

## 4. Test plan (when a transport exists)

- In-process mock broker: paired A→B delivery, ciphertext-only storage,
  duplicate `msg_id` rejection, tampered AAD rejection, expired timestamp,
  unknown sender, oversized ciphertext, rekey grace, disconnect revocation.
- Cross-plugin integration: two plugin instances with separate KV stores and
  one mock relay; grants stay per-instance; a remote peer without `send` is
  rejected at admission.
- Failure recovery: broker 5xx/timeout retries, outbox remains pending, then
  delivers after recovery.

## 5. Blocker

There is no deployed relay, TLS certificate, or agreed trust model. A local
mock can prove the protocol but not the real authentication boundary, and the
repository must not invent a hosted service. A human decision is required:

1. **Self-hosted relay** in this repository (needs a deployment target and
   certificate management).
2. **Existing hosted relay** (needs URL, credentials, retention/ToS review).
3. **Defer 2B** until cross-machine transport is selected.

Until one option is chosen, `brokerURL` stays unset and Postal remains
local-only. No broker code is shipped, so there is no half-configured transport
that could silently weaken authentication.
