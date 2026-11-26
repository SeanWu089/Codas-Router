# Identity V1 native interoperability checkpoint

This is a development reference, not deployed Agent authentication.
The established Identity V1 challenge transcript remains unchanged:
P-256, canonical 91-byte uncompressed DER SPKI, SHA-256 identity
fingerprint, ECDSA SHA-256 ASN.1 DER signature, canonical unpadded
base64url. The public fixture is historical and contains no private key.
The fixture parser is a test input format, not a production JSON decoder.

## Platform adapters

- macOS: CryptoKit Secure Enclave P-256 signing. Persist only the opaque
  hardware-wrapped dataRepresentation, never a plaintext private scalar,
  in an explicitly initialized owner-only local state directory. The
  file is created exclusively, synced and published atomically; every
  create/load/sign uses the same namespace lock. Reopening requires the
  independently expected identity ID. No software-key fallback. An
  attempted legacy Keychain reference was rejected because the reported
  key was extractable; a Data Protection Keychain reference could not
  be accepted in the unsigned development context. Use the hardware-wrapped
  adapter as the tested reference rather than require developer certificates.
  This is not the original proposed Keychain-item storage implementation.
  The data file must remain local, outside iCloud and backups intended for
  another computer. Same-user compromise is not an isolation boundary.
- Windows: CNG Microsoft Software Key Storage Provider, current-user
  persisted ECDSA P-256 signing key, export policy None. Atomic creation
  does not request OverwriteExistingKey. Loading requires the expected
  identity. Convert CNG raw 64-byte R||S signatures to canonical DER;
  validate the reverse encoding when verifying the public fixture.
  This is OS-protected storage, not a claim that a TPM was used.
- Android: AndroidKeyStore P-256 key with SHA-256 signing purpose; private
  key encoding must be unavailable. Explicit alias creation and a shared
  app-private lock serialize reference callers. Missing or changed keys
  fail closed. The Java wire library and Android adapter compile against
  API 35 with minimum API 30. Actual AndroidKeyStore behavior on hardware
  remains pending, including hardware security level; do not assert
  StrongBox or TEE-backed storage from compilation or JVM tests.

All proof functions accept a validated, current challenge and expected
network/identity, not an arbitrary byte-string signing interface. Production
must provide trustworthy, independently persisted network/identity anchors
and authenticated local consent. Keys are not automatically recreated when
missing or invalid. The wrappers and test-only deletion methods must not
be exposed as lifecycle or arbitrary remote-signing APIs.

## Reproducible checks

The normal Node suite validates the shared public fixture. The independent
native tools directory is deliberately not a Node auto-discovery test path.

On macOS, compile IdentityStore.swift and main.swift with swiftc; run
identity/tools/native-probe.mjs with the file URL of src/device-identity.js,
the compiled executable, and identity/vectors/p256-v1.properties.

On Windows, compile IdentityStore.cs with the available .NET Framework C#
compiler or an equivalent supported toolchain. Run the same native-probe
with the Node reference module (ES module), executable and vector.
The harness uses unique synthetic aliases and cleans them up in finally.
It verifies a real Node-issued challenge through IdentityChallenges,
replay rejection, persisted reopen, duplicate creation, identity mismatch,
wrong network, expiry and tampered nonce. It never signs production data.

Compile the Java wire library and VectorProbe with JDK 17 and run VectorProbe
with the public fixture. The JVM-generated public proof can be checked
using identity/tools/verify-jvm-proof.mjs. This is JVM interoperability,
not Android device acceptance.

Build the isolated Android instrumentation fixture with
identity/native/android/build-probe.sh and an unused absolute output APK
path. It has a separate package (com.codas.identityprobe), no requested
permissions, no access to the installed Agent's storage, and a temporary
test signer. It is not a Codas update. The test runner must explicitly
select an authorized ADB device, check the package is absent, install the
fixture, run create/prove/delete in separate instrumentation invocations,
verify the returned proof in Node, then uninstall only the installed
fixture. No device was attached during this checkpoint, so these device
checks are pending. Do not claim an APK build proves AndroidKeyStore behavior.

## Observed acceptance

- Mac: Swift compile, public-vector verify, Secure Enclave availability,
  hardware-wrapped reopen, all standalone native probe checks passed.
  Final synthetic fixture removed. No production key or app changed.
- Windows: real installed RC7 host compiled the CNG probe with .NET Framework,
  verified the vector and passed all native-probe checks. Temporary CNG
  fixture removed and absence checked; temporary desktop directory removed.
  Existing RC7 installation was not modified.
- Java: shared vector verified; actual ephemeral JVM ECDSA proof verified
  by Node; tampered transcript rejected.
- Android: API 35 compile and separate signed instrumentation APK build
  and signature verification passed; physical device unavailable.
- Node: 135/135 full isolated regression, no skips.

Keep this checkpoint isolated from production. Actual app upgrade/restart
persistence, signed-app key ownership, secure migration, local/admin consent,
live authorization and session termination still require integration and
acceptance. Do not rotate or replace existing credentials during this stage.
