package codas.identity;

import android.app.Activity;
import android.app.Instrumentation;
import android.os.Bundle;
import java.io.File;
import java.util.HashMap;
import java.util.Map;

// Isolated permission-free probe; never bundled into the real Agent.
public final class IdentityProbe extends Instrumentation {
    private Bundle arguments;
    @Override public void onCreate(Bundle args){super.onCreate(args);arguments=args;start();}
    private String arg(String name){
        String v=arguments.getString(name);
        IdentityWire.require(v!=null&&!v.isEmpty(),"FIXTURE_ARGUMENT_MISSING_"+name);return v;
    }
    private interface Throwing{void run()throws Exception;}
    private void mustReject(Throwing action,String code)throws Exception{
        try{action.run();throw new AssertionError("FIXTURE_REJECTION_MISSING_"+code);}
        catch(IllegalArgumentException|IllegalStateException e){IdentityWire.require(code.equals(e.getMessage()),"FIXTURE_WRONG_ERROR");}
    }
    @Override public void onStart(){
        Bundle result=new Bundle();
        try{
            String alias=arg("alias");
            IdentityWire.require(alias.matches("codas-test-[a-zA-Z0-9-]{8,80}"),"FIXTURE_SCOPE_INVALID");
            File lock=new File(getTargetContext().getNoBackupFilesDir(),alias+".lock");
            AndroidIdentityStore store=new AndroidIdentityStore(alias,lock);
            switch(arg("mode")){
                case "create":{
                    IdentityWire.Descriptor d=store.create();
                    mustReject(()->store.create(),"IDENTITY_ALREADY_EXISTS");
                    IdentityWire.require(store.load(d.identityId).publicKey.equals(d.publicKey),"FIXTURE_REOPEN_FAILED");
                    result.putString("identityId",d.identityId);result.putString("publicKey",d.publicKey);
                    result.putString("status","CREATE_OK");break;
                }
                case "prove":{
                    String expected=arg("expectedIdentity"),network=arg("expectedNetwork");
                    Map<String,String> fields=new HashMap<>();
                    for(String k:new String[]{"version","purpose","networkId","identityId","challengeId","nonce","issuedAt","expiresAt"})fields.put(k,arg(k));
                    IdentityWire.Challenge c=new IdentityWire.Challenge(fields);
                    IdentityWire.Descriptor d=store.load(expected);
                    mustReject(()->store.prove(c,"wrong-network-fixture-001",expected),"IDENTITY_CHALLENGE_SCOPE_MISMATCH");
                    Map<String,String> expired=new HashMap<>(fields);
                    expired.put("issuedAt","0");expired.put("expiresAt","60000");
                    mustReject(()->store.prove(new IdentityWire.Challenge(expired),network,expected),"IDENTITY_CHALLENGE_EXPIRED");
                    String signature=store.prove(c,network,expected);
                    IdentityWire.require(IdentityWire.verify(IdentityWire.parsePublic(d.publicKey,d.identityId),c.transcript(network,expected),signature),"FIXTURE_VERIFY_FAILED");
                    result.putString("identityId",d.identityId);result.putString("challengeId",c.challengeId);result.putString("signature",signature);
                    result.putString("status","PROVE_OK");break;
                }
                case "delete":{
                    store.deleteFixture();
                    mustReject(()->store.load("codas-id-v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),"IDENTITY_KEY_MISSING");
                    result.putString("status","DELETE_OK");break;
                }
                default:throw new IllegalArgumentException("FIXTURE_MODE_INVALID");
            }
            finish(Activity.RESULT_OK,result);
        }catch(Throwable error){
            result.putString("status","FAILED");
            result.putString("error",error.getClass().getSimpleName()+":"+error.getMessage());
            finish(Activity.RESULT_CANCELED,result);
        }
    }
}
