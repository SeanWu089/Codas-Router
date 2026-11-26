// Explicit isolated hardware acceptance. Run only after the operator authorizes
// the selected physical Android device. Does not touch any existing package.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID,randomBytes } from 'node:crypto';
import { IdentityChallenges,normalizeDeviceIdentity } from '../../src/device-identity.js';
const [adb,serial,apk]=process.argv.slice(2);
assert.ok(adb&&serial&&apk,'usage: android-probe.mjs <adb> <explicit-device-serial> <apk>');
const pkg='com.codas.identityprobe',instrument=pkg+'/codas.identity.IdentityProbe',alias='codas-test-'+randomUUID();
function run(args){return execFileSync(adb,['-s',serial,...args],{encoding:'utf8',timeout:60000,maxBuffer:1024*1024}).trim()}
assert.equal(run(['get-state']),'device');
function installed(){return run(['shell','pm','list','packages',pkg]).split(/\r?\n/).includes('package:'+pkg)}
function probe(mode,extras={}){
 const args=['shell','am','instrument','-w','-e','mode',mode,'-e','alias',alias];
 for(const [k,v] of Object.entries(extras)){assert.match(String(v),/^[A-Za-z0-9_:-]+$/);args.push('-e',k,String(v))}
 const result=run([...args,instrument]);
 const output={};
 for(const l of result.split(/\r?\n/)){
   const m=/^INSTRUMENTATION_RESULT: ([^=]+)=(.*)$/.exec(l);if(m)output[m[1]]=m[2];
 }
 assert.notEqual(output.status,'FAILED',output.error||'Android fixture failed');
 assert.equal(output.status,mode.toUpperCase()+'_OK',result);
 return output;
}
assert.equal(installed(),false,'Existing test package must not be overwritten');
let owned=false;
try{
 const res=run(['install',apk]);assert.match(res,/Success/);owned=true;
 assert.equal(installed(),true);
 const c=probe('create');
 const identity=normalizeDeviceIdentity({version:1,algorithm:'P-256',identityId:c.identityId,publicKey:c.publicKey});
 const network=randomBytes(32).toString('base64url'),book=new IdentityChallenges(network);
 const challenge=book.issue(identity);
 const proof=probe('prove',{...challenge,expectedIdentity:identity.identityId,expectedNetwork:network});
 assert.deepEqual(book.verify({identityId:proof.identityId,challengeId:proof.challengeId,signature:proof.signature}),identity);
 assert.equal(book.verify({identityId:proof.identityId,challengeId:proof.challengeId,signature:proof.signature}),null);
 console.log('ANDROID_KEYSTORE_NATIVE_PROOF_OK');
}finally{
 if(owned){
   try{probe('delete');console.log('ANDROID_FIXTURE_KEY_REMOVED_AND_ABSENT')}
   finally{assert.match(run(['uninstall',pkg]),/Success/);assert.equal(installed(),false);console.log('ANDROID_FIXTURE_UNINSTALLED')}
 }
}
