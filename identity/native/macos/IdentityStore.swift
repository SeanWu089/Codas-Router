import Foundation
import Security
import CryptoKit
import LocalAuthentication
import Darwin

// Reference adapter, deliberately not linked into the production menu app.
enum IdentityFailure: Error { case invalid(String) }
func require(_ condition: @autoclosure () throws -> Bool, _ code: String) throws {
    if try !condition() { throw IdentityFailure.invalid(code) }
}
let spkiPrefix = Data([0x30,0x59,0x30,0x13,0x06,0x07,0x2a,0x86,0x48,0xce,0x3d,0x02,0x01,
                       0x06,0x08,0x2a,0x86,0x48,0xce,0x3d,0x03,0x01,0x07,0x03,0x42,0x00])
let identityPrefix = "codas-id-v1:"
func b64(_ bytes: Data) -> String {
    bytes.base64EncodedString().replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
}
func asciiToken(_ s: String) -> Bool {
    !s.isEmpty && s.utf8.allSatisfy {
        (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95
    }
}
func decode(_ s: String, _ count: Int) throws -> Data {
    try require(asciiToken(s) && s.utf8.count == (count * 8 + 5) / 6, "IDENTITY_ENCODING_INVALID")
    let p = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    guard let d = Data(base64Encoded: p + String(repeating:"=",count:(4-p.count%4)%4))
    else { throw IdentityFailure.invalid("IDENTITY_ENCODING_INVALID") }
    try require(d.count == count && b64(d) == s, "IDENTITY_ENCODING_INVALID")
    return d
}
struct Descriptor {
    let publicKey: String
    let identityId: String
    init(point: Data) throws {
        try require(point.count == 65 && point.first == 4, "IDENTITY_KEY_INVALID")
        _ = try P256.Signing.PublicKey(x963Representation: point)
        let spki = spkiPrefix + point
        publicKey = b64(spki)
        identityId = identityPrefix + b64(Data(SHA256.hash(data: spki)))
    }
    init(spki: String, expectedIdentity: String) throws {
        let data = try decode(spki,91)
        try require(data.prefix(spkiPrefix.count) == spkiPrefix, "IDENTITY_KEY_INVALID")
        try self.init(point: Data(data.dropFirst(spkiPrefix.count)))
        try require(identityId == expectedIdentity && publicKey == spki, "IDENTITY_FINGERPRINT_MISMATCH")
    }
}
struct Challenge {
    let networkId, identityId, challengeId, nonce: String
    let issuedAt, expiresAt: Int64
    init(_ fields: [String:String]) throws {
        let keys: Set<String> = ["version","purpose","networkId","identityId","challengeId","nonce","issuedAt","expiresAt"]
        try require(Set(fields.keys) == keys && fields["version"] == "1" &&
                    fields["purpose"] == "device-identity-proof", "IDENTITY_CHALLENGE_INVALID")
        networkId = fields["networkId"]!
        identityId = fields["identityId"]!
        challengeId = fields["challengeId"]!
        nonce = fields["nonce"]!
        try require(asciiToken(networkId) && (16...128).contains(networkId.utf8.count), "IDENTITY_NETWORK_INVALID")
        try require(identityId.hasPrefix(identityPrefix), "IDENTITY_CHALLENGE_INVALID")
        _ = try decode(String(identityId.dropFirst(identityPrefix.count)),32)
        _ = try decode(challengeId,16)
        _ = try decode(nonce,32)
        guard let i = Int64(fields["issuedAt"]!), let e = Int64(fields["expiresAt"]!),
              String(i) == fields["issuedAt"], String(e) == fields["expiresAt"],
              i >= 0, e <= 9_007_199_254_740_991, e >= i, e-i == 60_000
        else { throw IdentityFailure.invalid("IDENTITY_CHALLENGE_INVALID") }
        issuedAt=i; expiresAt=e
    }
    func transcript(expectedNetwork: String, expectedIdentity: String) throws -> Data {
        try require(networkId == expectedNetwork && identityId == expectedIdentity, "IDENTITY_CHALLENGE_SCOPE_MISMATCH")
        // All interpolated strings are validated ASCII from the restricted alphabet.
        let s = "[\"codas/device-identity-proof/v1\",\"\(networkId)\",\"\(identityId)\",\"\(challengeId)\",\"\(nonce)\",\(issuedAt),\(expiresAt)]"
        return Data(s.utf8)
    }
    func requireCurrent(now: Int64 = Int64(Date().timeIntervalSince1970 * 1000)) throws {
        try require(now >= issuedAt && now < expiresAt, "IDENTITY_CHALLENGE_EXPIRED")
    }
}
// Only a private, local per-namespace lock file is used; no key material is
// written there. All create/load operations for this namespace must share it.
func withIdentityLock<T>(_ lockPath: String, _ fn: () throws -> T) throws -> T {
    let parent = (lockPath as NSString).deletingLastPathComponent
    var ds = stat()
    try require(lstat(parent,&ds) == 0 && (ds.st_mode & S_IFMT) == S_IFDIR &&
                ds.st_uid == getuid() && (ds.st_mode & 0o077) == 0, "IDENTITY_STORAGE_UNSAFE")
    let fd = open(lockPath,O_CREAT|O_RDWR|O_NOFOLLOW,0o600)
    try require(fd >= 0,"IDENTITY_LOCK_UNAVAILABLE")
    defer { close(fd) }
    var st = stat()
    try require(fstat(fd,&st) == 0 && (st.st_mode & S_IFMT) == S_IFREG &&
                st.st_uid == getuid() && st.st_nlink == 1 && (st.st_mode & 0o077) == 0,"IDENTITY_STORAGE_UNSAFE")
    try require(flock(fd,LOCK_EX|LOCK_NB) == 0,"IDENTITY_LOCK_BUSY")
    defer { flock(fd,LOCK_UN) }
    return try fn()
}

// Hardware-backed wrapped-key store for the ad-hoc-signed development
// application. CryptoKit's Secure Enclave dataRepresentation is an opaque,
// encrypted key representation bound to this Secure Enclave, not an
// exported private scalar. No software-key fallback is permitted.
final class MacWrappedIdentityStore {
    private let tag:String
    private let lockPath:String
    private let keyPath:String
    init(tag:String,lockPath:String)throws{
        try require(asciiToken(tag) && tag.count<=128,"IDENTITY_NAMESPACE_INVALID")
        self.tag=tag;self.lockPath=lockPath
        self.keyPath=(lockPath as NSString).deletingLastPathComponent+"/"+tag+".sealed"
    }
    private func context()->LAContext{
        let c=LAContext();c.interactionNotAllowed=true;return c
    }
    private func exists()throws->Bool{
        var st=stat()
        if lstat(keyPath,&st)==0{
            try require((st.st_mode&S_IFMT)==S_IFREG && st.st_uid==getuid() &&
                        st.st_nlink==1 && (st.st_mode&0o077)==0,"IDENTITY_STORAGE_UNSAFE")
            return true
        }
        try require(errno==ENOENT,"IDENTITY_STORAGE_UNSAFE")
        return false
    }
    private func readKey()throws->SecureEnclave.P256.Signing.PrivateKey{
        try require(SecureEnclave.isAvailable,"IDENTITY_SECURE_ENCLAVE_UNAVAILABLE")
        try require(try exists(),"IDENTITY_KEY_MISSING")
        let fd=open(keyPath,O_RDONLY|O_NOFOLLOW)
        try require(fd>=0,"IDENTITY_KEY_READ_FAILED")
        defer{close(fd)}
        var st=stat()
        try require(fstat(fd,&st)==0 && (st.st_mode&S_IFMT)==S_IFREG &&
                    st.st_uid==getuid() && st.st_nlink==1 && (st.st_mode&0o077)==0 &&
                    st.st_size>0 && st.st_size<=16384,"IDENTITY_STORAGE_UNSAFE")
        let handle=FileHandle(fileDescriptor:fd,closeOnDealloc:false)
        let blob=try handle.readToEnd() ?? Data()
        try require(blob.count==Int(st.st_size),"IDENTITY_KEY_READ_FAILED")
        // Unwrap only through the Secure Enclave API. A corrupt blob or a
        // blob copied from a different hardware enclave must fail closed.
        do{return try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation:blob,authenticationContext:context())}
        catch{throw IdentityFailure.invalid("IDENTITY_WRAPPED_KEY_INVALID")}
    }
    private func describe(_ key:SecureEnclave.P256.Signing.PrivateKey)throws->Descriptor{
        try Descriptor(point:key.publicKey.x963Representation)
    }
    private func publish(_ blob:Data)throws{
        try require(blob.count>0 && blob.count<=16384,"IDENTITY_WRAPPED_KEY_INVALID")
        let temp=keyPath+".new-"+UUID().uuidString
        let fd=open(temp,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW,0o600)
        try require(fd>=0,"IDENTITY_KEY_WRITE_FAILED")
        defer{close(fd);unlink(temp)}
        let handle=FileHandle(fileDescriptor:fd,closeOnDealloc:false)
        try handle.write(contentsOf:blob)
        try require(fsync(fd)==0,"IDENTITY_KEY_SYNC_FAILED")
        // link() publishes the complete file without ever replacing a key.
        try require(link(temp,keyPath)==0,"IDENTITY_KEY_PUBLISH_FAILED")
        try require(unlink(temp)==0,"IDENTITY_KEY_PUBLISH_FAILED")
        let parent=(keyPath as NSString).deletingLastPathComponent
        let dir=open(parent,O_RDONLY|O_DIRECTORY|O_NOFOLLOW)
        try require(dir>=0,"IDENTITY_KEY_SYNC_FAILED")
        defer{close(dir)}
        try require(fsync(dir)==0,"IDENTITY_KEY_SYNC_FAILED")
    }
    func create()throws->Descriptor{
        try withIdentityLock(lockPath){
            try require(!(try exists()),"IDENTITY_ALREADY_EXISTS")
            try require(SecureEnclave.isAvailable,"IDENTITY_SECURE_ENCLAVE_UNAVAILABLE")
            var error:Unmanaged<CFError>?
            guard let access=SecAccessControlCreateWithFlags(nil,kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
                    .privateKeyUsage,&error) else {
                throw IdentityFailure.invalid("IDENTITY_KEYCHAIN_ACCESS_CONTROL_FAILED")
            }
            let key=try SecureEnclave.P256.Signing.PrivateKey(accessControl:access,authenticationContext:context())
            let d=try describe(key)
            try publish(key.dataRepresentation)
            let stored=try describe(readKey())
            try require(stored.identityId==d.identityId,"IDENTITY_KEY_NOT_PERSISTED")
            return d
        }
    }
    func load(expectedIdentity:String)throws->Descriptor{
        try withIdentityLock(lockPath){
            let d=try describe(readKey())
            try require(d.identityId==expectedIdentity,"IDENTITY_FINGERPRINT_MISMATCH")
            return d
        }
    }
    func prove(_ challenge:Challenge,expectedNetwork:String,expectedIdentity:String)throws->String{
        try withIdentityLock(lockPath){
            let key=try readKey()
            let d=try describe(key)
            try require(d.identityId==expectedIdentity,"IDENTITY_FINGERPRINT_MISMATCH")
            try challenge.requireCurrent()
            let data=try challenge.transcript(expectedNetwork:expectedNetwork,expectedIdentity:expectedIdentity)
            return b64(try key.signature(for:data).derRepresentation)
        }
    }
    // Isolated test namespace only; never called by identity lifecycle logic.
    func deleteFixture()throws{
        try require(tag.hasPrefix("codas-test-"),"IDENTITY_TEST_SCOPE")
        try withIdentityLock(lockPath){
            if try exists(){try require(unlink(keyPath)==0,"IDENTITY_FIXTURE_DELETE_FAILED")}
            try require(!(try exists()),"IDENTITY_FIXTURE_DELETE_FAILED")
        }
    }
}
