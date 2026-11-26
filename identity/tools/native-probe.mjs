// Standalone native interoperability harness. Only random codas-test-* keys.
// No production identity, enrollment state, or network access is used.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { randomUUID, randomBytes } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

const reference=process.argv[2], probe=process.argv[3], fixture=process.argv[4];
if(!reference||!probe||!fixture)throw Error('usage: native-probe.mjs <identity module> <probe exe> <vector>');
const {normalizeDeviceIdentity,IdentityChallenges}=await import(reference);
const dir=mkdtempSync(path.join(os.tmpdir(),'codas-native-identity-fixture-'));
const tag='codas-test-'+randomUUID();
const lock=path.join(dir,'identity.lock');
const file=path.join(dir,'challenge.properties');
const network=randomBytes(32).toString('base64url');
const parse=text=>Object.fromEntries(text.trim().split(/\r?\n/).filter(s=>s.includes('=')).map(s=>[s.slice(0,s.indexOf('=')),s.slice(s.indexOf('=')+1)]));
function raw(args){
    return execFileSync(probe,args,{encoding:'utf8',timeout:12000,windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
}
function args(command,...more){return process.platform==='darwin'?[command,tag,lock,...more]:[command,tag,...more];}
function reject(command,expected,...more){
    try {raw(args(command,...more));}
    catch(e){
        const message=String(e.stderr??'')+' '+String(e.stdout??'');
        assert.ok(message.includes(expected), 'unexpected native failure: '+message.slice(0,500));
        return;
    }
    throw Error('native rejection missing: '+expected);
}
function challengeFile(c){
    writeFileSync(file,Object.entries(c).map(([k,v])=>k+'='+v).join('\n')+'\n',{mode:0o600});
}
let mayOwnKey=false,cleanup=false;
try{
    assert.equal(raw(['vector',fixture]),'VECTOR_OK');
    console.log('VECTOR_OK');
    // Probe a new unique alias before creating anything. Never remove a
    // pre-existing key or treat a failed/ambiguous lookup as permission.
    reject('load','IDENTITY_KEY_MISSING','codas-id-v1:'+randomBytes(32).toString('base64url'));
    mayOwnKey=true;
    const created=parse(raw(args('create')));
    const d=normalizeDeviceIdentity({version:1,algorithm:'P-256',
        identityId:created.IDENTITY,publicKey:created.PUBLIC});
    reject('create','IDENTITY_ALREADY_EXISTS');
    const loaded=parse(raw(args('load',d.identityId)));
    assert.deepEqual(loaded,created);
    reject('load','IDENTITY_FINGERPRINT_MISMATCH','codas-id-v1:'+randomBytes(32).toString('base64url'));
    console.log('PERSISTENT_KEY_REOPEN_AND_NO_OVERWRITE_OK');
    const challenges=new IdentityChallenges(network);
    const c=challenges.issue(d);
    challengeFile(c);
    reject('prove','IDENTITY_CHALLENGE_SCOPE_MISMATCH',d.identityId,'other-network-fixture-001',file);
    challengeFile({...c,issuedAt:0,expiresAt:60000});
    reject('prove','IDENTITY_CHALLENGE_EXPIRED',d.identityId,network,file);
    challengeFile(c);
    const sig=parse(raw(args('prove',d.identityId,network,file))).SIGNATURE;
    const proof={identityId:d.identityId,challengeId:c.challengeId,signature:sig};
    assert.deepEqual(challenges.verify(proof),d);
    assert.equal(challenges.verify(proof),null);
    console.log('NATIVE_SIGNATURE_NODE_VERIFIED_AND_REPLAY_REJECTED');
    const altered=challenges.issue(d);
    challengeFile({...altered,nonce:randomBytes(32).toString('base64url')});
    const alteredSig=parse(raw(args('prove',d.identityId,network,file))).SIGNATURE;
    assert.equal(challenges.verify({identityId:d.identityId,challengeId:altered.challengeId,signature:alteredSig}),null);
    console.log('WRONG_SCOPE_EXPIRY_AND_TAMPER_REJECTED');
} finally {
    try{
        if(mayOwnKey){
            assert.equal(raw(args('delete')),'DELETE_OK');
            reject('load','IDENTITY_KEY_MISSING','codas-id-v1:'+randomBytes(32).toString('base64url'));
            cleanup=true;
            console.log('FIXTURE_KEY_REMOVED_AND_ABSENT');
        }
    } finally {
        rmSync(dir,{recursive:true,force:true});
    }
}
assert.ok(cleanup);
console.log('NATIVE_INTEROP_OK');
