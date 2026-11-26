using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;

// Native Windows reference. CNG persisted keys; no production Agent integration.
namespace Codas.Identity {
internal static class Wire {
    internal const string Prefix="codas-id-v1:";
    internal static readonly byte[] SpkiPrefix=Hex("3059301306072a8648ce3d020106082a8648ce3d030107034200");
    internal static void Require(bool b,string code){if(!b)throw new InvalidOperationException(code);}
    static byte[] Hex(string s){byte[] b=new byte[s.Length/2];for(int i=0;i<b.Length;i++)b[i]=Convert.ToByte(s.Substring(i*2,2),16);return b;}
    internal static bool Token(string s){return !String.IsNullOrEmpty(s)&&s.All(c=>c>='A'&&c<='Z'||c>='a'&&c<='z'||c>='0'&&c<='9'||c=='-'||c=='_');}
    internal static string B64(byte[] b){return Convert.ToBase64String(b).TrimEnd('=').Replace('+','-').Replace('/','_');}
    internal static byte[] Decode(string s,int min,int max){
        Require(Token(s)&&s.Length<=(max*8+5)/6,"IDENTITY_ENCODING_INVALID");
        string p=s.Replace('-','+').Replace('_','/');byte[] b=Convert.FromBase64String(p+new string('=',(4-p.Length%4)%4));
        Require(b.Length>=min&&b.Length<=max&&B64(b)==s,"IDENTITY_ENCODING_INVALID");return b;
    }
    internal sealed class Descriptor {
        internal readonly string Id,PublicKey;
        internal Descriptor(string id,string pub){Id=id;PublicKey=pub;}
    }
    internal static Descriptor Describe(CngKey k) {
        byte[] blob=k.Export(CngKeyBlobFormat.EccPublicBlob);
        // BCRYPT_ECDSA_PUBLIC_P256_MAGIC 'ECS1'; 32-byte coordinates.
        Require(blob.Length==72&&BitConverter.ToUInt32(blob,0)==0x31534345&&BitConverter.ToUInt32(blob,4)==32,"IDENTITY_KEY_INVALID");
        byte[] spki=SpkiPrefix.Concat(new byte[]{4}).Concat(blob.Skip(8)).ToArray();
        using(var sha=SHA256.Create())return new Descriptor(Prefix+B64(sha.ComputeHash(spki)),B64(spki));
    }
    internal static CngKey PublicKey(string spki,string id){
        byte[] bytes=Decode(spki,91,91);
        Require(bytes.Take(SpkiPrefix.Length).SequenceEqual(SpkiPrefix)&&bytes[SpkiPrefix.Length]==4,"IDENTITY_KEY_INVALID");
        byte[] blob=new byte[]{69,67,83,49,32,0,0,0}.Concat(bytes.Skip(SpkiPrefix.Length+1)).ToArray();
        CngKey key=CngKey.Import(blob,CngKeyBlobFormat.EccPublicBlob);
        try{Descriptor d=Describe(key);Require(d.Id==id&&d.PublicKey==spki,"IDENTITY_FINGERPRINT_MISMATCH");return key;}
        catch{key.Dispose();throw;}
    }
    static byte[] Integer(byte[] p) {
        int i=0;while(i<p.Length-1&&p[i]==0)i++;
        byte[] value=p.Skip(i).ToArray();
        Require(value.Any(b=>b!=0),"IDENTITY_SIGNATURE_INVALID");
        if((value[0]&128)!=0)value=new byte[]{0}.Concat(value).ToArray();
        return new byte[]{2,(byte)value.Length}.Concat(value).ToArray();
    }
    internal static byte[] ToDer(byte[] raw){
        Require(raw.Length==64,"IDENTITY_SIGNATURE_INVALID");
        byte[] body=Integer(raw.Take(32).ToArray()).Concat(Integer(raw.Skip(32).ToArray())).ToArray();
        return new byte[]{0x30,(byte)body.Length}.Concat(body).ToArray();
    }
    internal static byte[] FromDer(byte[] der){
        Require(der.Length>=8&&der.Length<=72&&der[0]==0x30&&der[1]==der.Length-2,"IDENTITY_SIGNATURE_INVALID");
        int p=2;byte[] raw=new byte[64];
        for(int part=0;part<2;part++){
            Require(p+2<=der.Length&&der[p++]==2,"IDENTITY_SIGNATURE_INVALID");int n=der[p++];
            Require(n>=1&&n<=33&&p+n<=der.Length&&(der[p]&128)==0&&!(n>1&&der[p]==0&&(der[p+1]&128)==0),"IDENTITY_SIGNATURE_INVALID");
            if(n==33){Require(der[p]==0,"IDENTITY_SIGNATURE_INVALID");p++;n--;}
            Array.Copy(der,p,raw,part*32+32-n,n);p+=n;
        }
        Require(p==der.Length&&ToDer(raw).SequenceEqual(der),"IDENTITY_SIGNATURE_INVALID");return raw;
    }
    internal sealed class Challenge {
        internal readonly string Network,Identity,Id,Nonce;
        internal readonly long Issued,Expires;
        internal Challenge(IDictionary<string,string> f){
            string[] fields={"version","purpose","networkId","identityId","challengeId","nonce","issuedAt","expiresAt"};
            Require(f.Count==fields.Length&&fields.All(f.ContainsKey)&&f["version"]=="1"&&f["purpose"]=="device-identity-proof","IDENTITY_CHALLENGE_INVALID");
            Network=f["networkId"];Identity=f["identityId"];Id=f["challengeId"];Nonce=f["nonce"];
            Require(Token(Network)&&Network.Length>=16&&Network.Length<=128&&Identity.StartsWith(Prefix,StringComparison.Ordinal),"IDENTITY_CHALLENGE_INVALID");
            Decode(Identity.Substring(Prefix.Length),32,32);Decode(Id,16,16);Decode(Nonce,32,32);
            Issued=Int64.Parse(f["issuedAt"],CultureInfo.InvariantCulture);Expires=Int64.Parse(f["expiresAt"],CultureInfo.InvariantCulture);
            Require(Issued>=0&&Expires>=Issued&&Expires<=9007199254740991L&&Expires-Issued==60000&&
                Issued.ToString(CultureInfo.InvariantCulture)==f["issuedAt"]&&Expires.ToString(CultureInfo.InvariantCulture)==f["expiresAt"],"IDENTITY_CHALLENGE_INVALID");
        }
        internal byte[] Transcript(string network,string identity){
            Require(Network==network&&Identity==identity,"IDENTITY_CHALLENGE_SCOPE_MISMATCH");
            return Encoding.UTF8.GetBytes("[\"codas/device-identity-proof/v1\",\""+Network+"\",\""+Identity+"\",\""+Id+"\",\""+Nonce+"\","+
                Issued.ToString(CultureInfo.InvariantCulture)+","+Expires.ToString(CultureInfo.InvariantCulture)+"]");
        }
        internal void RequireCurrent(){
            long now=(long)(DateTime.UtcNow-new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc)).TotalMilliseconds;
            Require(now>=Issued&&now<Expires,"IDENTITY_CHALLENGE_EXPIRED");
        }
    }
    internal static bool Verify(CngKey key,byte[] data,string signature) {
        using(var e=new ECDsaCng(key)){e.HashAlgorithm=CngAlgorithm.Sha256;return e.VerifyData(data,FromDer(Decode(signature,8,72)));}
    }
}
internal sealed class WindowsIdentityStore {
    private readonly string name;
    private static readonly CngProvider Provider=CngProvider.MicrosoftSoftwareKeyStorageProvider;
    internal WindowsIdentityStore(string name){Wire.Require(Wire.Token(name)&&name.Length<=128,"IDENTITY_NAMESPACE_INVALID");this.name=name;}
    private CngKey Open(){
        // No create-if-missing or legacy fallback.
        Wire.Require(CngKey.Exists(name,Provider,CngKeyOpenOptions.None),"IDENTITY_KEY_MISSING");
        CngKey key=CngKey.Open(name,Provider,CngKeyOpenOptions.None);
        try{Check(key);return key;}catch{key.Dispose();throw;}
    }
    private static void Check(CngKey key){
        Wire.Require(key.Algorithm==CngAlgorithm.ECDsaP256&&key.KeySize==256&&!key.IsMachineKey&&
            key.ExportPolicy==CngExportPolicies.None&&key.Provider==Provider,"IDENTITY_KEY_NOT_PROTECTED");
    }
    internal Wire.Descriptor Create(){
        Wire.Require(!CngKey.Exists(name,Provider,CngKeyOpenOptions.None),"IDENTITY_ALREADY_EXISTS");
        var p=new CngKeyCreationParameters { Provider=Provider,ExportPolicy=CngExportPolicies.None,KeyUsage=CngKeyUsages.Signing,KeyCreationOptions=CngKeyCreationOptions.None };
        // CNG create without OverwriteExistingKey is the atomic no-replacement boundary.
        using(CngKey k=CngKey.Create(CngAlgorithm.ECDsaP256,name,p)){
            Check(k);Wire.Descriptor d=Wire.Describe(k);
            using(CngKey reopened=Open()){Wire.Require(Wire.Describe(reopened).Id==d.Id,"IDENTITY_KEY_NOT_PERSISTED");}
            return d;
        }
    }
    internal Wire.Descriptor Load(string expected){
        using(CngKey k=Open()){Wire.Descriptor d=Wire.Describe(k);Wire.Require(d.Id==expected,"IDENTITY_FINGERPRINT_MISMATCH");return d;}
    }
    internal string Prove(Wire.Challenge challenge,string expectedNetwork,string expectedIdentity){
        using(CngKey k=Open()){
            Wire.Descriptor d=Wire.Describe(k);Wire.Require(d.Id==expectedIdentity,"IDENTITY_FINGERPRINT_MISMATCH");
            challenge.RequireCurrent();byte[] data=challenge.Transcript(expectedNetwork,expectedIdentity);
            using(var e=new ECDsaCng(k)){e.HashAlgorithm=CngAlgorithm.Sha256;return Wire.B64(Wire.ToDer(e.SignData(data)));}
        }
    }
    internal void DeleteFixture(){
        Wire.Require(name.StartsWith("codas-test-",StringComparison.Ordinal),"IDENTITY_TEST_SCOPE");
        if(CngKey.Exists(name,Provider,CngKeyOpenOptions.None)){using(CngKey k=Open()){k.Delete();}}
        Wire.Require(!CngKey.Exists(name,Provider,CngKeyOpenOptions.None),"IDENTITY_FIXTURE_DELETE_FAILED");
    }
}
internal static class Probe {
    static Dictionary<string,string> Fields(string file){
        var map=new Dictionary<string,string>(StringComparer.Ordinal);
        foreach(string line in File.ReadAllLines(file)){int i=line.IndexOf('=');Wire.Require(i>0,"FIXTURE_INVALID");map.Add(line.Substring(0,i),line.Substring(i+1));}
        return map;
    }
    static Wire.Challenge Challenge(Dictionary<string,string> f){
        string[] keys={"version","purpose","networkId","identityId","challengeId","nonce","issuedAt","expiresAt"};
        return new Wire.Challenge(f.Where(kv=>keys.Contains(kv.Key)).ToDictionary(kv=>kv.Key,kv=>kv.Value));
    }
    static void Emit(Wire.Descriptor d){Console.WriteLine("IDENTITY="+d.Id);Console.WriteLine("PUBLIC="+d.PublicKey);}
    static int Main(string[] args){
        try{
            if(args.Length==2&&args[0]=="vector"){
                var f=Fields(args[1]);Wire.Challenge c=Challenge(f);
                using(CngKey pub=Wire.PublicKey(f["publicKey"],c.Identity)){
                    byte[] bytes=c.Transcript(c.Network,c.Identity);
                    Wire.Require(Wire.B64(bytes)==f["transcript"],"VECTOR_TRANSCRIPT_MISMATCH");
                    Wire.Require(Wire.Verify(pub,bytes,f["signature"]),"VECTOR_SIGNATURE_INVALID");
                    Wire.Require(!Wire.Verify(pub,bytes.Concat(new byte[]{0}).ToArray(),f["signature"]),"VECTOR_TAMPER_ACCEPTED");
                }
                try{c.Transcript("another-network-fixture",c.Identity);throw new Exception("WRONG_SCOPE_ACCEPTED");}
                catch(InvalidOperationException e){Wire.Require(e.Message=="IDENTITY_CHALLENGE_SCOPE_MISMATCH","WRONG_ERROR");}
                Console.WriteLine("VECTOR_OK");return 0;
            }
            Wire.Require(args.Length>=2&&args[1].StartsWith("codas-test-",StringComparison.Ordinal),"FIXTURE_SCOPE_INVALID");
            var store=new WindowsIdentityStore(args[1]);
            switch(args[0]){
                case "create":Wire.Require(args.Length==2,"FIXTURE_INVALID");Emit(store.Create());break;
                case "load":Wire.Require(args.Length==3,"FIXTURE_INVALID");Emit(store.Load(args[2]));break;
                case "prove":Wire.Require(args.Length==5,"FIXTURE_INVALID");Console.WriteLine("SIGNATURE="+store.Prove(Challenge(Fields(args[4])),args[3],args[2]));break;
                case "delete":Wire.Require(args.Length==2,"FIXTURE_INVALID");store.DeleteFixture();Console.WriteLine("DELETE_OK");break;
                default:throw new Exception("FIXTURE_INVALID");
            }
            return 0;
        }catch(Exception e){Console.Error.WriteLine(e.GetType().Name+": "+e.Message);return 2;}
    }
}
}
