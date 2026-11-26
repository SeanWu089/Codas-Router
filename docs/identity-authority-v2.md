# Coordinator Identity and Grant Authority V2 — reference

Status: isolated development reference. Not imported by the live Router and
not an HTTP/MCP API. It is a candidate replacement for the separate legacy
grant and identity stores, **not** an additional live writer or migration
of production state. V1 and V2 have distinct schemas; opening one as the
other fails. V2 is explicitly initialized with a fresh reference network.
No deployed network ID or legacy registry is converted in this stage.

## Atomic authority

One local SQLite transaction authority owns five tables:

- authority_meta: stable network ID, schema marker, global mutation revision;
- device_grants: existing route ID, random immutable grant ID, current
  generation, active/revoked state, current token hash, trusted scope hash,
  optional absolute expiry;
- credential_history: retained SHA-256 token hashes per route/generation.
  Historical hashes are never accepted as credentials or reused;
- identity_bindings: one-to-one canonical P-256 identity and public key
  bound to the existing route ID, with its commit revision;
- authority_events: committed import/bind/rotate/revoke event sequence with
  revision, route, grant ID and generation.

The schema contains no private identity keys or plaintext tokens. A rotation
returns a freshly generated token exactly once to the trusted internal
caller; only its hash is persisted. Neither snapshots nor events reveal
token hashes or credentials. The event sequence is a logical consistency
check, not a tamper-evident security log. The scope hash is an opaque trusted
binding to the approved permission scope; canonical workspace/capability
encoding and actual access enforcement belong to the later policy adapter.

BEGIN IMMEDIATE serializes writes across processes. Each grant mutation or
first identity binding updates its state and event revision in the same
transaction. Reopening checks schema, SQLite integrity, foreign keys,
canonical identity fingerprints, complete credential history and event
replay consistency. Existing bindings are immutable. A repeat of an exact
binding is idempotent only after fresh authorization and proof.

Import is an internal, independently reviewed legacy baseline operation.
It accepts a canonical token hash from the trusted baseline, not an
enrollment secret or a route name as evidence. It cannot overwrite existing
routes, including revoked routes, or reuse any historical credential.
Revocation clears the active token hash, advances the generation, and retains
the identity binding and revoked grant record. Rotation requires a current
active grant, advances the generation, preserves its scope and expiry, and
invalidates old tokens and migration requests. Compare-and-set on the
expected grant snapshot prevents competing stale administrative actions.
An expired grant is not authenticatable; expiry is checked at use time.
No reactivation, new-device enrollment, renewal, permission edits or grant
recovery are implemented in this reference.

## Legacy binding transaction

1. Authenticate the existing active device bearer credential. Only the
   authenticated grant identifies the route; a request cannot choose
   another route. Normalize the new key and reject known binding conflicts.
2. Issue the existing Identity V1 60-second one-use challenge. Internally
   associate it with the operation, network, exact route, immutable grant
   ID, grant generation, scope hash and identity fingerprint. The wire
   signature transcript remains Identity V1; the server-owned association
   is not user-supplied routing metadata.
3. Require separately trusted administrator and on-device local consent
   decisions for that exact request scope. The two internal approval methods
   are not authority proofs in themselves. Their authenticated UI/OS adapters
   must be built and reviewed before exposing endpoints. No request-provided
   boolean or self-declared role is accepted as an approval. Cancellation
   invalidates that request; approvals cannot be borrowed by a second request.
4. On finish, verify both approvals, exact bearer/grant and the key proof;
   consume a successful proof once, even if the later transaction fails.
   Reauthenticate the same credential and unchanged grant generation,
   scope, state and expiry inside BEGIN IMMEDIATE immediately before
   committing. Recheck the challenge time and binding conflicts. This
   closes the gap between preliminary authentication and final commit.
5. Binding preserves the existing grant, token, route and permission scope.
   It neither issues a token nor enables membership. A fresh approved
   retry with the same key may be idempotent, but replay of an old proof
   cannot complete or resurrect a revoked grant.

Pending challenges and approvals are bounded (256 per reference instance)
and memory-only. Restart loses them by design; expiry or cancellation
requires a new request. A canceled challenge may occupy the underlying
challenge book until expiry. The authenticated transport and rate-limit
layer still needs its own design. Multiple local reference handles may
compete over the same SQLite file; this is not distributed consensus.

## Release and security boundaries

- Production continues to use its current JSON authorization and SSE
  sessions. Do not create two live authorities or wire this reference into
  production until a reviewed, quiesced import/cutover and rollback strategy
  exists. Stop legacy shared-pairing overwrite before any live identity
  binding; preserve existing valid credentials and established sessions.
- Legacy import in reference tests uses synthetic credentials only. No
  actual state files, tokens, keys, paths or production devices are read,
  copied or migrated.
- Mac Keychain, Windows protected key storage and Android Keystore, native
  signature interoperability, authentic administrator roles/local consent,
  actual workspace authorization, lease/session invalidation, queued-job
  cancellation and already-running-task boundaries remain separate work.
- A bound identity does not yet change normal bearer authentication to a
  proof-of-possession transport. No live token renewal or rejoin API exists.
- Uses the shared POSIX-only local SQLite reference storage from Registry V1,
  Node 22.13+ node:sqlite, SQLite FULL synchronous rollback journaling,
  explicit initialization and expected-network checks. Windows coordinator
  storage requires an equivalent protected adapter. The synchronous
  reference is not yet suitable for unbounded work on a live event loop.
- No automatic restoration from backups or automatic coordinator transfer.
  Old valid snapshot rollback, malicious same-user filesystem modification,
  host compromise and cross-machine single-writer consensus are not solved.
