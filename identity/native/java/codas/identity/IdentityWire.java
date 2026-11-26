package codas.identity;

import java.nio.charset.StandardCharsets;
import java.security.*;
import java.security.interfaces.ECPublicKey;
import java.security.spec.*;
import java.util.*;

public final class IdentityWire {
    private IdentityWire() {}
    public static final String PREFIX="codas-id-v1:";
    private static final byte[] SPKI_PREFIX=hex("3059301306072a8648ce3d020106082a8648ce3d030107034200");
    private static byte[] hex(String s){
        byte[] a=new byte[s.length()/2];for(int i=0;i<a.length;i++)a[i]=(byte)Integer.parseInt(s.substring(2*i,2*i+2),16);return a;
    }
    static void require(boolean condition,String code){if(!condition)throw new IllegalArgumentException(code);}
    static boolean token(String s){return s!=null&&s.matches("[A-Za-z0-9_-]+");}
    public static String b64(byte[] bytes){return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);}
    public static byte[] decode(String s,int min,int max){
        require(s!=null&&s.length()<=(max*8+5)/6&&token(s),"IDENTITY_ENCODING_INVALID");
        byte[] v=Base64.getUrlDecoder().decode(s);
        require(v.length>=min&&v.length<=max&&b64(v).equals(s),"IDENTITY_ENCODING_INVALID");return v;
    }
    public static final class Descriptor{
        public final String identityId,publicKey;
        private Descriptor(String i,String p){identityId=i;publicKey=p;}
    }
    public static Descriptor describe(PublicKey key) throws GeneralSecurityException {
        require(key instanceof ECPublicKey,"IDENTITY_KEY_INVALID");
        byte[] encoded=key.getEncoded();
        require(encoded!=null&&encoded.length==91&&Arrays.equals(Arrays.copyOf(encoded,SPKI_PREFIX.length),SPKI_PREFIX)
                &&encoded[SPKI_PREFIX.length]==4,"IDENTITY_KEY_INVALID");
        PublicKey canonical=KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(encoded));
        require(Arrays.equals(canonical.getEncoded(),encoded),"IDENTITY_KEY_INVALID");
        return new Descriptor(PREFIX+b64(MessageDigest.getInstance("SHA-256").digest(encoded)),b64(encoded));
    }
    public static PublicKey parsePublic(String spki,String expected) throws GeneralSecurityException {
        byte[] bytes=decode(spki,91,91);
        PublicKey key=KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(bytes));
        Descriptor d=describe(key);
        require(d.publicKey.equals(spki)&&d.identityId.equals(expected),"IDENTITY_FINGERPRINT_MISMATCH");
        return key;
    }
    public static final class Challenge{
        public final String networkId,identityId,challengeId,nonce;
        public final long issuedAt,expiresAt;
        public Challenge(Map<String,String> f){
            Set<String> keys=new HashSet<>(Arrays.asList("version","purpose","networkId","identityId","challengeId","nonce","issuedAt","expiresAt"));
            require(f.keySet().equals(keys)&&"1".equals(f.get("version"))&&"device-identity-proof".equals(f.get("purpose")),"IDENTITY_CHALLENGE_INVALID");
            networkId=f.get("networkId");identityId=f.get("identityId");challengeId=f.get("challengeId");nonce=f.get("nonce");
            require(token(networkId)&&networkId.length()>=16&&networkId.length()<=128&&identityId.startsWith(PREFIX),"IDENTITY_CHALLENGE_INVALID");
            decode(identityId.substring(PREFIX.length()),32,32);decode(challengeId,16,16);decode(nonce,32,32);
            issuedAt=Long.parseLong(f.get("issuedAt"));expiresAt=Long.parseLong(f.get("expiresAt"));
            require(Long.toString(issuedAt).equals(f.get("issuedAt"))&&Long.toString(expiresAt).equals(f.get("expiresAt"))&&
                issuedAt>=0&&expiresAt<=9007199254740991L&&expiresAt>=issuedAt&&expiresAt-issuedAt==60000L,"IDENTITY_CHALLENGE_INVALID");
        }
        public byte[] transcript(String expectedNetwork,String expectedIdentity){
            require(networkId.equals(expectedNetwork)&&identityId.equals(expectedIdentity),"IDENTITY_CHALLENGE_SCOPE_MISMATCH");
            return ("[\"codas/device-identity-proof/v1\",\""+networkId+"\",\""+identityId+"\",\""+challengeId+"\",\""+nonce+"\","+issuedAt+","+expiresAt+"]").getBytes(StandardCharsets.UTF_8);
        }
        public void requireCurrent(long now){require(now>=issuedAt&&now<expiresAt,"IDENTITY_CHALLENGE_EXPIRED");}
    }
    static boolean canonicalDer(byte[] s){
        if(s.length<8||s.length>72||s[0]!=0x30||(s[1]&255)!=s.length-2)return false;
        int p=2;
        for(int i=0;i<2;i++){
            if(p+2>s.length||s[p++]!=2)return false;
            int n=s[p++]&255;
            if(n<1||n>33||p+n>s.length||(s[p]&128)!=0||(n>1&&s[p]==0&&(s[p+1]&128)==0))return false;
            if(n==33&&s[p]!=0)return false;
            boolean nonzero=false;for(int j=0;j<n;j++)nonzero|=s[p+j]!=0;
            if(!nonzero)return false;
            p+=n;
        }
        return p==s.length;
    }
    public static boolean verify(PublicKey key,byte[] data,String signature) throws GeneralSecurityException{
        byte[] der=decode(signature,8,72);
        require(canonicalDer(der),"IDENTITY_SIGNATURE_INVALID");
        Signature s=Signature.getInstance("SHA256withECDSA");s.initVerify(key);s.update(data);return s.verify(der);
    }
    // Package-private, so the protected adapter only offers challenge-specific signing.
    static String sign(PrivateKey key,Challenge c,String network,String identity) throws GeneralSecurityException{
        c.requireCurrent(System.currentTimeMillis());byte[] data=c.transcript(network,identity);
        Signature s=Signature.getInstance("SHA256withECDSA");s.initSign(key);s.update(data);
        byte[] der=s.sign();require(canonicalDer(der),"IDENTITY_SIGNATURE_INVALID");return b64(der);
    }
}
