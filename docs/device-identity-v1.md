# Codas Device Identity V1 — reference protocol

Status: isolated development reference; not exposed by the live Router. This
stage establishes identity and proof of key possession only. It neither enrolls
a device nor grants, revokes or renews an access token.

## Separate concerns

- Identity ID is derived from an installation's persistent public key. It is
  stable across rename, access-off, ordinary app upgrade and re-pairing while
  that key is retained. A physical-machine replacement or loss of the key
  requires explicit recovery; neither a hostname nor hardware serial number
  proves continuity.
- Existing Device ID remains the routing record key. A trusted coordinator
  must link it to one verified identity; an identity cannot claim another
  route record merely by knowing its ID. The binding planner is pure and does
  not authenticate the caller or persist a grant.
- Existing Installation ID remains legacy metadata; it is not proof of key
  ownership. Existing per-device tokens and the access switch are independent.
- Display names are editable labels, not identifiers, and are never used to
  merge records.

## Cross-platform wire encoding

An identity is exactly the four fields version (integer 1), algorithm
(string P-256), identityId and publicKey. publicKey is the unpadded canonical
base64url encoding of the 91-byte DER SubjectPublicKeyInfo for an uncompressed
NIST P-256 public key (secp256r1 / prime256v1). Re-encode and check canonical
bytes. identityId is the literal prefix codas-id-v1: followed by unpadded
base64url SHA-256 of that DER. No private material is transmitted.

A coordinator with a stable, authenticated network identifier issues a
challenge with fields version=1, purpose=device-identity-proof, networkId,
identityId, challengeId, nonce, issuedAt and expiresAt. Network identifiers
are 16–128 ASCII base64url-alphabet characters. challengeId is a random 16-byte
value; nonce is a random 32-byte value; both use unpadded base64url. The
coordinator's integer Unix milliseconds determine the validity interval of
60,000 ms. The client checks the expected network and its own identity before
signing. The exact signed bytes are UTF-8 JSON of the following array, with
no spaces, trailing newline, Unicode normalization or additional fields:

    ["codas/device-identity-proof/v1",networkId,identityId,challengeId,nonce,issuedAt,expiresAt]

All strings in this array are ASCII. Sign using ECDSA P-256 with SHA-256;
the signature is ASN.1 DER (not raw R||S), then unpadded base64url. The proof
has exactly identityId, challengeId, signature. The verifier obtains the
expected transcript and key from its own issued challenge, not from the
proof. Successful verification consumes the challenge; expired or unknown
challenges fail, including after coordinator restart. The in-memory reference
limits the pending count to 256, and invalid attempts do not consume a valid
challenge. Rate limits and authenticated network binding are still required
before any public endpoint is enabled.

Use platform-protected keys for production (Mac Keychain, Windows CNG/DPAPI
or appropriate Windows key storage, Android Keystore). The Node reference
provides explicit, exclusive local POSIX file creation and permission checks
for development; it is not a Windows production key store, not encrypted
at rest and not a same-user-process security boundary. Missing or invalid
existing identity data must stop identity recovery, not silently generate a
new key. Explicit first-time initialization is separate from reading a key.

## Migration / lifecycle boundary

Do not change existing agent or router state during reference testing.
For a legacy record, the coordinator must independently authenticate the
existing credential or use a separately confirmed administrator recovery
flow, verify proof of the new public key, and atomically bind it to that
specific existing route record. Reject conflicting key/route mappings and
never match by hostname, mutable name or unauthenticated installation ID.
A fresh key is a new identity until an explicit recovery procedure proves and
authorizes continuity. Keep binding and access grant mutations under the
same coordinator-controlled transaction design. No live migration is
implemented in this stage.

A joining device may request enrollment, or an authorized administrator
may initiate an invitation. A proof alone does not establish membership:
the later enrollment protocol must bind administrator approval and local
consent to the same identity, network, workspace scope and request. Removal
will revoke the grant/session, while keeping the identity binding for
verified rejoin. No device may silently restore a revoked grant by proving
key possession. Credential rotation, revocation, queued jobs, session
termination, durable coordinator state, authorized legacy migration and
cross-device/native interoperability remain subsequent implementation and
acceptance gates.
