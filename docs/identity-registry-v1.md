# Coordinator Identity Registry V1 — isolated reference

Status: development reference, not imported by the production Router. The
registry stores public identity bindings, not network membership or access
authorization.

## Storage contract

- A distinct local SQLite database contains schema version 1, application ID
  CDI1, a stable 32-byte randomly generated network identifier (canonical
  base64url), a monotonic binding revision, and immutable one-to-one mappings
  of the existing Device ID (route ID) to the canonical Identity V1 public key
  and derived Identity ID. No token, private key, device display name, path or
  permission grant is stored.
- Explicit initialization exclusively reserves a new file. Open requires the
  expected network ID from separately trusted configuration or an approved
  transfer. Missing, incomplete, corrupt, wrong-network or unsupported-format
  state fails closed. An interrupted initial creation requires operator
  recovery; never silently reinitialize the network. There is no automatic
  restore, rebind, key rotation or delete operation in this reference.
- A single SQLite transaction (BEGIN IMMEDIATE, rollback journal, FULL
  synchronous) checks route and identity uniqueness, inserts the binding and
  advances the revision. Repeating the same binding is idempotent; a different
  key for an existing route or a different route for the same key is rejected.
  Existing route IDs and routing/workspace records are not rewritten.
- A consistent read transaction validates schema, integrity, public-key
  fingerprints and contiguous revisions. No binding deletions are supported;
  the revision corresponds to the number of committed bindings. Open writers
  reject a replaced database inode, unsafe directory or inconsistent revision. The reference
  caps bindings at 10,000. A future lifecycle schema may introduce retained
  tombstones or append-only events under a separately reviewed migration.
- Reference file adapter is POSIX only: existing owner-only local directory,
  owner-only regular single-link database file, no final symlinks or unexpected
  WAL/SHM sidecars. SQLite must use a local filesystem with working locks.
  Windows Coordinator storage needs an ACL/reparse-point-safe adapter; this is
  independent of Windows Agent native key storage. Same-user adversarial
  modification, rollback to an old valid backup and filesystem/power-loss
  behavior outside SQLite's guarantees are not solved by this reference.
  Use a supported Node 22.13+ runtime with node:sqlite (experimental on Node 22).
  No production package or runtime upgrade is introduced here.

## Trusted binding boundary

recordTrustedBinding is an internal persistence primitive. It assumes a
separately authorized and verified coordinator decision; it does not accept
tokens or proof assertions and must not be exposed directly as an endpoint.
A stored public key or valid signature never grants membership.

## Legacy migration contract (design, not deployed)

1. A previously enrolled device retains its original Device ID, current
   credential and workspace configuration. It explicitly creates or loads a
   persistent platform-protected P-256 key. An unavailable/corrupt key requires
   recovery; an old name or Installation ID is not evidence of continuity.
2. The coordinator authenticates an existing, specific active device grant.
   A reusable enrollment/pairing secret, public route ID, display name or
   unverified installation metadata does not authorize migration. Before live
   migration is enabled, prevent legacy shared-pairing enrollment from
   overwriting existing route records or rotating their credentials. Otherwise
   a newly replaced legacy token could defeat the migration trust assumption.
   Require an administrator-confirmed baseline for existing grants, and a
   separate approved recovery flow for ambiguous or unexpectedly rotated grants.
   Rejecting overwrite must not disconnect already-authorized sessions.
3. The coordinator issues a short-lived Identity V1 challenge and stores an
   internal association with the exact existing route, grant ID/generation,
   network ID, public key fingerprint, operation (legacy binding), and expiry.
   The client checks the expected authenticated network and proves key
   possession. Only the stored association determines the target route.
4. At commit, consume the challenge once, recheck the same grant is still
   active and unchanged, recheck administrator/local-consent requirements and
   conflicts, then atomically persist the mapping under the same transactional
   authority used for grant changes. Revocation or rotation that wins the race
   rejects migration; stale, unrelated or replayed proofs cannot bind another
   route. No new grant is issued or existing credential rotated by binding.
5. Keep the legacy connection and workspace bindings unchanged until successful
   migration acknowledgement; retry of an already committed exact binding is
   idempotent, but only after current authorization checks. A revoked device
   cannot restore access through identity proof. Loss of key requires explicit
   recovery and a separate audited administrator decision.

Important: today's Router grants live in a separate legacy JSON state store.
A SQLite registry transaction does not atomically revalidate that JSON store.
The reference deliberately adds no live migration endpoints or automatic
migration. Before integration, implement a single writer/transaction authority
for migration, credential generations, revocation and lifecycle mutations,
and exercise concurrency and restart failure cases. Native key-store and
cross-platform signature tests remain required.

## Future coordinator transfer

The stable network identity and committed registry are necessary, not
sufficient, for secure transfer. A consistent, authenticated transfer must
also include access grants, revocation history, admin roles and pending state;
the new coordinator must prove authorized succession, reject stale snapshots
and enforce a single active mutation authority. SQLite alone does not provide
distributed consensus or protect against rollback. Do not implement automatic
Core switching in this stage.
