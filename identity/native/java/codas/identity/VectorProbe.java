package codas.identity;
import java.nio.file.*;
import java.security.*;
import java.security.spec.*;
import java.util.*;

public final class VectorProbe {
    static Map<String,String> fields(String file)throws Exception{
        Map<String,String> f=new HashMap<>();
        for(String line:Files.readAllLines(Path.of(file))){
            int i=line.indexOf('=');
            IdentityWire.require(i>0&&f.put(line.substring(0,i),line.substring(i+1))==null,"FIXTURE_INVALID");
        }
        return f;
    }
    static IdentityWire.Challenge challenge(Map<String,String> f){
        Map<String,String> selected=new HashMap<>();
        for(String key:Arrays.asList("version","purpose","networkId","identityId","challengeId","nonce","issuedAt","expiresAt"))
            selected.put(key,f.get(key));
        return new IdentityWire.Challenge(selected);
    }
    public static void main(String[] args)throws Exception{
        IdentityWire.require(args.length==2&&args[0].equals("vector"),"FIXTURE_INVALID");
        Map<String,String> f=fields(args[1]);IdentityWire.Challenge c=challenge(f);
        PublicKey pub=IdentityWire.parsePublic(f.get("publicKey"),c.identityId);
        byte[] bytes=c.transcript(c.networkId,c.identityId);
        IdentityWire.require(IdentityWire.b64(bytes).equals(f.get("transcript")),"VECTOR_TRANSCRIPT_MISMATCH");
        IdentityWire.require(IdentityWire.verify(pub,bytes,f.get("signature")),"VECTOR_SIGNATURE_INVALID");
        byte[] modified=Arrays.copyOf(bytes,bytes.length+1);
        IdentityWire.require(!IdentityWire.verify(pub,modified,f.get("signature")),"VECTOR_TAMPER_ACCEPTED");
        try{c.transcript("another-network-fixture",c.identityId);throw new AssertionError("WRONG_SCOPE_ACCEPTED");}
        catch(IllegalArgumentException e){IdentityWire.require(e.getMessage().equals("IDENTITY_CHALLENGE_SCOPE_MISMATCH"),"WRONG_ERROR");}
        KeyPairGenerator g=KeyPairGenerator.getInstance("EC");g.initialize(new ECGenParameterSpec("secp256r1"));
        KeyPair k=g.generateKeyPair();IdentityWire.Descriptor d=IdentityWire.describe(k.getPublic());
        long now=System.currentTimeMillis();
        Map<String,String> own=new HashMap<>(f);
        for(String n:Arrays.asList("publicKey","transcript","signature"))own.remove(n);
        own.put("identityId",d.identityId);own.put("issuedAt",Long.toString(now-1000));own.put("expiresAt",Long.toString(now+59000));
        IdentityWire.Challenge oc=new IdentityWire.Challenge(own);
        String proof=IdentityWire.sign(k.getPrivate(),oc,oc.networkId,d.identityId);
        IdentityWire.require(IdentityWire.verify(k.getPublic(),oc.transcript(oc.networkId,d.identityId),proof),"LOCAL_SIGN_FAILED");
        System.out.println("IDENTITY="+d.identityId);System.out.println("PUBLIC="+d.publicKey);
        System.out.println("ISSUED="+oc.issuedAt);System.out.println("EXPIRES="+oc.expiresAt);
        System.out.println("SIGNATURE="+proof);System.out.println("VECTOR_OK");
    }
}
