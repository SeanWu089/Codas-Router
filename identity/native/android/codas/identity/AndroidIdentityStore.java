package codas.identity;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.security.keystore.KeyInfo;
import java.io.File;
import java.nio.file.LinkOption;
import java.nio.file.StandardOpenOption;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.security.*;
import java.security.spec.ECGenParameterSpec;

// Standalone Android reference adapter, not registered as an app component.
// Pass a stable alias and a lock path in the app's private no-backup directory.
// Every process using that alias must take this same lock. No exported key.
public final class AndroidIdentityStore {
    private final String alias;
    private final File lockFile;
    public AndroidIdentityStore(String alias,File lockFile){
        IdentityWire.require(IdentityWire.token(alias)&&alias.length()<=128,"IDENTITY_NAMESPACE_INVALID");
        IdentityWire.require(lockFile.isAbsolute()&&lockFile.getParentFile().isDirectory(),"IDENTITY_STORAGE_UNSAFE");
        // Android may expose the app-private directory through a system
        // alias (for example /data/user/0). Canonicalize the trusted parent,
        // then reject a symlink at the lock-file leaf.
        this.alias=alias;
        try{this.lockFile=new File(lockFile.getParentFile().getCanonicalFile(),lockFile.getName());}
        catch(java.io.IOException e){throw new IllegalArgumentException("IDENTITY_STORAGE_UNSAFE",e);}
    }
    private interface Action<T>{T run(KeyStore ks)throws Exception;}
    private static final Object LOCK=new Object();
    private <T>T locked(Action<T> action)throws Exception{
        synchronized(LOCK){
            IdentityWire.require(lockFile.getCanonicalFile().equals(lockFile.getAbsoluteFile()),
                "IDENTITY_STORAGE_UNSAFE");
            try(FileChannel c=FileChannel.open(lockFile.toPath(),StandardOpenOption.CREATE,
                    StandardOpenOption.WRITE,LinkOption.NOFOLLOW_LINKS);FileLock l=c.tryLock()){
                IdentityWire.require(l!=null,"IDENTITY_LOCK_BUSY");
                KeyStore ks=KeyStore.getInstance("AndroidKeyStore");ks.load(null);return action.run(ks);
            }
        }
    }
    private KeyStore.PrivateKeyEntry entry(KeyStore ks)throws Exception{
        if(!ks.containsAlias(alias))throw new IllegalStateException("IDENTITY_KEY_MISSING");
        KeyStore.Entry value=ks.getEntry(alias,null);
        IdentityWire.require(value instanceof KeyStore.PrivateKeyEntry,"IDENTITY_KEY_INVALID");
        KeyStore.PrivateKeyEntry e=(KeyStore.PrivateKeyEntry)value;
        IdentityWire.require(e.getPrivateKey().getEncoded()==null,"IDENTITY_KEY_NOT_PROTECTED");
        KeyInfo info=KeyFactory.getInstance(e.getPrivateKey().getAlgorithm(),"AndroidKeyStore")
            .getKeySpec(e.getPrivateKey(),KeyInfo.class);
        IdentityWire.require(info.getKeySize()==256&&(info.getPurposes()&KeyProperties.PURPOSE_SIGN)!=0,
            "IDENTITY_KEY_INVALID");
        return e;
    }
    public IdentityWire.Descriptor create()throws Exception{
        return locked(ks->{
            IdentityWire.require(!ks.containsAlias(alias),"IDENTITY_ALREADY_EXISTS");
            KeyPairGenerator g=KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC,"AndroidKeyStore");
            g.initialize(new KeyGenParameterSpec.Builder(alias,KeyProperties.PURPOSE_SIGN|KeyProperties.PURPOSE_VERIFY)
                .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256).build());
            KeyPair pair=g.generateKeyPair();
            IdentityWire.Descriptor d=IdentityWire.describe(pair.getPublic());
            IdentityWire.Descriptor saved=IdentityWire.describe(entry(ks).getCertificate().getPublicKey());
            IdentityWire.require(saved.identityId.equals(d.identityId),"IDENTITY_KEY_NOT_PERSISTED");
            return saved;
        });
    }
    public IdentityWire.Descriptor load(String expectedIdentity)throws Exception{
        return locked(ks->{
            IdentityWire.Descriptor d=IdentityWire.describe(entry(ks).getCertificate().getPublicKey());
            IdentityWire.require(d.identityId.equals(expectedIdentity),"IDENTITY_FINGERPRINT_MISMATCH");return d;
        });
    }
    public String prove(IdentityWire.Challenge challenge,String network,String expectedIdentity)throws Exception{
        return locked(ks->{
            KeyStore.PrivateKeyEntry e=entry(ks);
            IdentityWire.Descriptor d=IdentityWire.describe(e.getCertificate().getPublicKey());
            IdentityWire.require(d.identityId.equals(expectedIdentity),"IDENTITY_FINGERPRINT_MISMATCH");
            return IdentityWire.sign(e.getPrivateKey(),challenge,network,expectedIdentity);
        });
    }
    // Isolated fixture cleanup only. Never a production leave/revoke operation.
    void deleteFixture()throws Exception{
        IdentityWire.require(alias.startsWith("codas-test-"),"IDENTITY_TEST_SCOPE");
        locked(ks->{
            if(ks.containsAlias(alias))ks.deleteEntry(alias);
            IdentityWire.require(!ks.containsAlias(alias),"IDENTITY_FIXTURE_DELETE_FAILED");
            return null;
        });
    }

}
