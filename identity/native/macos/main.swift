import Foundation
import Security
import CryptoKit

func fields(_ file: String) throws -> [String:String] {
    var out:[String:String]=[:]
    for line in try String(contentsOfFile:file,encoding:.utf8).split(separator:"\n") {
        let p=line.split(separator:"=",maxSplits:1,omittingEmptySubsequences:false)
        try require(p.count==2 && out[String(p[0])]==nil,"FIXTURE_INVALID")
        out[String(p[0])]=String(p[1])
    }
    return out
}
func challenge(_ f:[String:String]) throws -> Challenge {
    let keys=["version","purpose","networkId","identityId","challengeId","nonce","issuedAt","expiresAt"]
    return try Challenge(f.filter{keys.contains($0.key)})
}
func emit(_ d: Descriptor) { print("IDENTITY="+d.identityId);print("PUBLIC="+d.publicKey) }
func run() throws {
    let a=Array(CommandLine.arguments.dropFirst())
    if a.count==2 && a[0]=="vector" {
        let f=try fields(a[1]), c=try challenge(f)
        let d=try Descriptor(spki:f["publicKey"]!,expectedIdentity:c.identityId)
        let bytes=try c.transcript(expectedNetwork:c.networkId,expectedIdentity:d.identityId)
        try require(b64(bytes)==f["transcript"],"VECTOR_TRANSCRIPT_MISMATCH")
        let pub=try P256.Signing.PublicKey(x963Representation:Data(try decode(d.publicKey,91).dropFirst(spkiPrefix.count)))
        let sigData=Data(base64Encoded:f["signature"]!.replacingOccurrences(of:"-",with:"+").replacingOccurrences(of:"_",with:"/")+String(repeating:"=",count:(4-f["signature"]!.count%4)%4))!
        let sig=try P256.Signing.ECDSASignature(derRepresentation:sigData)
        try require(b64(sig.derRepresentation)==f["signature"] && pub.isValidSignature(sig,for:bytes),"VECTOR_SIGNATURE_INVALID")
        let wrong=Data(bytes+[0])
        try require(!pub.isValidSignature(sig,for:wrong),"VECTOR_TAMPER_ACCEPTED")
        do { _=try c.transcript(expectedNetwork:"another-network-fixture",expectedIdentity:d.identityId); throw IdentityFailure.invalid("VECTOR_WRONG_SCOPE_ACCEPTED") }
        catch IdentityFailure.invalid(let e) where e=="IDENTITY_CHALLENGE_SCOPE_MISMATCH" {}
        print("VECTOR_OK");return
    }
    // Only explicit, randomly named fixture keys are allowed by this runner.
    try require(a.count>=3 && a[1].hasPrefix("codas-test-"),"FIXTURE_SCOPE_INVALID")
    // Explicit hardware-wrapped fixture store; no automatic fallback.
    let store=try MacWrappedIdentityStore(tag:a[1],lockPath:a[2])
    switch a[0] {
    case "create": try require(a.count==3,"FIXTURE_INVALID");emit(try store.create())
    case "load": try require(a.count==4,"FIXTURE_INVALID");emit(try store.load(expectedIdentity:a[3]))
    case "prove":
        try require(a.count==6,"FIXTURE_INVALID")
        let c=try challenge(fields(a[5]))
        print("SIGNATURE="+(try store.prove(c,expectedNetwork:a[4],expectedIdentity:a[3])))
    case "delete": try require(a.count==3,"FIXTURE_INVALID");try store.deleteFixture();print("DELETE_OK")
    default: throw IdentityFailure.invalid("FIXTURE_INVALID")
    }
}
do { try run() }
catch { FileHandle.standardError.write(Data("\(error)\n".utf8));exit(2) }
