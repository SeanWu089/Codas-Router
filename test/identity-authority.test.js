import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { generateDeviceIdentity, createIdentityFile } from '../src/device-identity.js';
import { initializeIdentityRegistry, openIdentityRegistry } from '../src/identity-registry.js';
import { initializeIdentityAuthority, openIdentityAuthority } from '../src/identity-authority.js';

const posix={skip:process.platform==='win32'};
const url=new URL('../src/identity-authority.js',import.meta.url).href;
const identityURL=new URL('../src/device-identity.js',import.meta.url).href;
const digest=v=>createHash('sha256').update(v).digest('base64url');
const credential=()=>randomBytes(32).toString('base64url');
function fixture(t,options={}){
  const dir=mkdtempSync(path.join(os.tmpdir(),'codas-authority-test-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'authority.sqlite');
  const a=initializeIdentityAuthority(file,options);
  t.after(()=>a.close());
  return {a,file,dir,network:a.networkId};
}
function add(a,routeId='legacy-a',options={}){
  const token=options.token??credential();
  const input={routeId,tokenHash:digest(token),scopeHash:digest('fixture-scope-'+routeId),
    expiresAt:options.expiresAt??null};
  return {token,input,grant:a.importTrustedLegacyGrant(input)};
}
function prepare(a,token,key){
  const request=a.beginLegacyBinding(token,key.identity);
  a.approveTrustedAdministrator(request.scope);
  a.confirmTrustedLocalConsent(request.scope);
  return {...request,proof:key.prove(request.challenge,a.networkId)};
}
function child(code,...args){
  return new Promise((resolve,reject)=>{
    const p=spawn(process.execPath,['--input-type=module','-e',code,...args],
      {stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';
    p.stdout.on('data',c=>stdout+=c);p.stderr.on('data',c=>stderr+=c);
    const timer=setTimeout(()=>p.kill('SIGKILL'),15000);
    p.on('error',e=>{clearTimeout(timer);reject(e)});
    p.on('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,stdout:stdout.trim(),stderr})});
  });
}
test('V2 is explicit; V1 and V2 do not silently open or overwrite each other',posix,t=>{
  const {a,file,network,dir}=fixture(t);
  assert.deepEqual(a.snapshot(),{version:2,networkId:network,revision:0,grants:[],bindings:[],events:[]});
  assert.throws(()=>initializeIdentityAuthority(file),{code:'EEXIST'});
  assert.throws(()=>openIdentityAuthority(file,credential()),/NETWORK_MISMATCH/);
  assert.throws(()=>openIdentityRegistry(file,network),/FORMAT_INVALID/);
  const v1file=path.join(dir,'v1.sqlite'),v1=initializeIdentityRegistry(v1file);
  t.after(()=>v1.close());
  assert.throws(()=>openIdentityAuthority(v1file,v1.networkId),/FORMAT_INVALID/);
  assert.throws(()=>initializeIdentityAuthority(v1file),{code:'EEXIST'});
  assert.equal(v1.snapshot().revision,0);
  const missing=path.join(dir,'missing.sqlite');
  assert.throws(()=>openIdentityAuthority(missing,network),{code:'ENOENT'});
});
test('only a trusted baseline import creates a legacy grant; duplicate routes and reused credentials cannot overwrite it',posix,t=>{
  const {a}=fixture(t),x=add(a);
  assert.deepEqual(a.authenticate(x.token),x.grant);
  assert.equal(a.authenticate('fixture-shared-pairing'),null);
  const before=a.snapshot();
  assert.throws(()=>a.importTrustedLegacyGrant(x.input),/ROUTE_EXISTS/);
  assert.throws(()=>add(a,'legacy-a'),/ROUTE_EXISTS/);
  assert.throws(()=>add(a,'legacy-b',{token:x.token}),/CREDENTIAL_REUSE/);
  assert.throws(()=>a.importTrustedLegacyGrant({...x.input,routeId:'new',token:x.token}),/IMPORT_INVALID/);
  assert.deepEqual(a.snapshot(),before);
  assert.equal(a.authenticate(x.token).generation,1);
});
test('key possession without both separately scoped trusted approvals cannot bind a device',posix,t=>{
  const {a}=fixture(t),x=add(a),key=generateDeviceIdentity();
  const r=a.beginLegacyBinding(x.token,key.identity),proof=key.prove(r.challenge,a.networkId);
  const before=a.snapshot();
  assert.throws(()=>a.finishLegacyBinding(x.token,proof),/APPROVAL_REQUIRED/);
  assert.throws(()=>a.approveTrustedAdministrator({...r.scope,routeId:'different'}),/APPROVAL_SCOPE_INVALID/);
  assert.throws(()=>a.confirmTrustedLocalConsent({...r.scope,scopeHash:digest('other')}),/APPROVAL_SCOPE_INVALID/);
  assert.throws(()=>a.confirmTrustedLocalConsent({...r.scope,localConsent:true}),/APPROVAL_SCOPE_INVALID/);
  a.approveTrustedAdministrator(r.scope);
  assert.throws(()=>a.finishLegacyBinding(x.token,proof),/APPROVAL_REQUIRED/);
  assert.deepEqual(a.snapshot(),before);
  a.confirmTrustedLocalConsent(r.scope);
  const result=a.finishLegacyBinding(x.token,proof);
  assert.equal(result.created,true);
  assert.equal(result.binding.routeId,x.grant.routeId);
  assert.equal(result.binding.identity.identityId,key.identity.identityId);
  assert.deepEqual(result.grant,x.grant);
  assert.deepEqual(a.authenticate(x.token),x.grant);
});
test('a valid proof cannot bind another route, network, key or altered challenge',posix,t=>{
  const {a}=fixture(t),x=add(a),y=add(a,'legacy-b'),k=generateDeviceIdentity(),other=generateDeviceIdentity();
  const r=prepare(a,x.token,k),s=prepare(a,y.token,other);
  assert.throws(()=>a.finishLegacyBinding(y.token,r.proof),/STALE_GRANT/);
  assert.throws(()=>a.finishLegacyBinding(x.token,s.proof),/STALE_GRANT/);
  const forged=other.prove({...r.challenge,identityId:other.identity.identityId},a.networkId);
  assert.throws(()=>a.finishLegacyBinding(x.token,{...forged,identityId:k.identity.identityId}),/PROOF_INVALID/);
  const nonce=randomBytes(32).toString('base64url');
  const altered=k.prove({...r.challenge,nonce},a.networkId);
  assert.throws(()=>a.finishLegacyBinding(x.token,altered),/PROOF_INVALID/);
  assert.equal(a.finishLegacyBinding(x.token,r.proof).binding.routeId,'legacy-a');
  assert.equal(a.finishLegacyBinding(y.token,s.proof).binding.routeId,'legacy-b');
});
test('successful proof is consumed, fresh approved exact retry is idempotent without issuing a credential',posix,t=>{
  const {a}=fixture(t),x=add(a),key=generateDeviceIdentity(),r=prepare(a,x.token,key);
  const first=a.finishLegacyBinding(x.token,r.proof);
  assert.throws(()=>a.finishLegacyBinding(x.token,r.proof),/UNKNOWN_OR_EXPIRED/);
  const retry=prepare(a,x.token,key);
  const result=a.finishLegacyBinding(x.token,retry.proof);
  assert.equal(result.created,false);
  assert.equal(result.revision,first.revision);
  assert.deepEqual(result.binding,first.binding);
  assert.deepEqual(a.authenticate(x.token),x.grant);
  assert.equal(Object.hasOwn(result,'token'),false);
});
test('one key cannot claim a second route and existing route cannot silently replace its key',posix,t=>{
  const {a}=fixture(t),x=add(a),y=add(a,'legacy-b'),k=generateDeviceIdentity();
  const r=prepare(a,x.token,k),s=prepare(a,y.token,k);
  a.finishLegacyBinding(x.token,r.proof);
  assert.throws(()=>a.finishLegacyBinding(y.token,s.proof),/IDENTITY_BINDING_COLLISION/);
  assert.throws(()=>a.finishLegacyBinding(y.token,s.proof),/UNKNOWN_OR_EXPIRED/);
  assert.throws(()=>a.beginLegacyBinding(x.token,generateDeviceIdentity().identity),/IDENTITY_BINDING_COLLISION/);
  assert.equal(a.snapshot().bindings.length,1);
});
test('revocation between challenge and completion rejects the proof and retains a tombstone',posix,t=>{
  const {a}=fixture(t),x=add(a),k=generateDeviceIdentity(),r=prepare(a,x.token,k);
  const revoked=a.revokeTrustedGrant(x.grant);
  assert.equal(revoked.state,'revoked');
  assert.equal(revoked.generation,2);
  assert.equal(a.authenticate(x.token),null);
  assert.throws(()=>a.finishLegacyBinding(x.token,r.proof),/STALE_GRANT/);
  assert.throws(()=>a.beginLegacyBinding(x.token,k.identity),/GRANT_INACTIVE/);
  assert.throws(()=>a.importTrustedLegacyGrant(x.input),/ROUTE_EXISTS/);
  assert.throws(()=>add(a,'legacy-b',{token:x.token}),/CREDENTIAL_REUSE/);
  assert.throws(()=>a.rotateTrustedGrant(revoked),/GRANT_INACTIVE/);
  assert.equal(a.snapshot().bindings.length,0);
});
test('rotation changes generation and credential; both old proof plus old token and old proof plus new token fail',posix,t=>{
  const {a}=fixture(t),x=add(a),k=generateDeviceIdentity(),r=prepare(a,x.token,k);
  const rotated=a.rotateTrustedGrant(x.grant);
  assert.equal(rotated.grant.generation,2);
  assert.notEqual(rotated.token,x.token);
  assert.equal(a.authenticate(x.token),null);
  assert.deepEqual(a.authenticate(rotated.token),rotated.grant);
  assert.throws(()=>a.finishLegacyBinding(x.token,r.proof),/STALE_GRANT/);
  assert.throws(()=>a.finishLegacyBinding(rotated.token,r.proof),/STALE_GRANT/);
  assert.throws(()=>a.revokeTrustedGrant(x.grant),/STALE_GRANT/);
  assert.throws(()=>a.approveTrustedAdministrator(r.scope),/STALE_GRANT/);
  const fresh=prepare(a,rotated.token,k);
  assert.equal(a.finishLegacyBinding(rotated.token,fresh.proof).created,true);
});
test('another coordinator connection revokes after precheck but before the final write transaction',posix,t=>{
  let calls=0,armed=false,other,grant;
  const clock=()=>{
    if(armed && ++calls===3){
      // Called during IdentityChallenges.verify, after the preliminary read
      // transaction and before final BEGIN IMMEDIATE. A separate connection
      // wins the revoke race while this request still has a valid signature.
      other.revokeTrustedGrant(grant);
    }
    return 1000;
  };
  const {a,file,network}=fixture(t,{clock}),x=add(a);
  other=openIdentityAuthority(file,network,{clock:()=>1000});t.after(()=>other.close());
  grant=x.grant;
  const r=prepare(a,x.token,generateDeviceIdentity());
  armed=true;
  assert.throws(()=>a.finishLegacyBinding(x.token,r.proof),/STALE_GRANT/);
  armed=false;
  assert.ok(calls>=4);
  const state=other.snapshot();
  assert.equal(state.grants[0].state,'revoked');
  assert.equal(state.bindings.length,0);
  assert.throws(()=>a.finishLegacyBinding(x.token,r.proof),/UNKNOWN_OR_EXPIRED/);
});
test('rotation winning immediately before final write invalidates old proof, including with the new token',posix,t=>{
  let calls=0,armed=false,other,grant,rotated;
  const clock=()=>{
    if(armed && ++calls===3)rotated=other.rotateTrustedGrant(grant);
    return 1000;
  };
  const {a,file,network}=fixture(t,{clock}),x=add(a);grant=x.grant;
  other=openIdentityAuthority(file,network,{clock:()=>1000});t.after(()=>other.close());
  const r=prepare(a,x.token,generateDeviceIdentity());
  armed=true;
  assert.throws(()=>a.finishLegacyBinding(x.token,r.proof),/STALE_GRANT/);
  armed=false;
  assert.equal(a.snapshot().bindings.length,0);
  assert.equal(a.authenticate(x.token),null);
  assert.equal(a.authenticate(rotated.token).generation,2);
  assert.throws(()=>a.finishLegacyBinding(rotated.token,r.proof),/UNKNOWN_OR_EXPIRED/);
});
test('expiry, cancellation, clock rollback and restart reject pending requests',posix,t=>{
  let now=1000;
  const {a,file,network}=fixture(t,{clock:()=>now}),x=add(a),k=generateDeviceIdentity();
  let r=prepare(a,x.token,k);
  now+=60000;
  assert.throws(()=>a.finishLegacyBinding(x.token,r.proof),/UNKNOWN_OR_EXPIRED/);
  r=prepare(a,x.token,k);
  assert.equal(a.cancelTrustedBinding({...r.scope,routeId:'wrong'}),false);
  assert.equal(a.cancelTrustedBinding(r.scope),true);
  assert.throws(()=>a.finishLegacyBinding(x.token,r.proof),/UNKNOWN_OR_EXPIRED/);
  r=prepare(a,x.token,k);now--;
  assert.throws(()=>a.finishLegacyBinding(x.token,r.proof),/UNKNOWN_OR_EXPIRED/);
  now++;
  r=prepare(a,x.token,k);
  a.close();
  const reopened=openIdentityAuthority(file,network,{clock:()=>now});t.after(()=>reopened.close());
  assert.throws(()=>reopened.finishLegacyBinding(x.token,r.proof),/UNKNOWN_OR_EXPIRED/);
  assert.equal(reopened.snapshot().bindings.length,0);
  assert.equal(reopened.finishLegacyBinding(x.token,prepare(reopened,x.token,k).proof).created,true);
});
test('grant expiry is rechecked at the exact expiry boundary and cannot be bypassed by key proof',posix,t=>{
  let now=1000;
  const {a}=fixture(t,{clock:()=>now}),x=add(a,'legacy-a',{expiresAt:2000});
  const k=generateDeviceIdentity(),r=prepare(a,x.token,k);
  now=2000;
  assert.equal(a.authenticate(x.token),null);
  assert.throws(()=>a.finishLegacyBinding(x.token,r.proof),/STALE_GRANT/);
  assert.throws(()=>a.rotateTrustedGrant(x.grant),/GRANT_INACTIVE/);
  assert.throws(()=>add(a,'already-expired',{expiresAt:now}),/GRANT_EXPIRED/);
  assert.equal(a.snapshot().bindings.length,0);
  assert.equal(a.revokeTrustedGrant(x.grant).state,'revoked');
});
test('revocation after binding preserves verified identity but never revives membership',posix,t=>{
  const {a,file,network}=fixture(t),x=add(a),k=generateDeviceIdentity();
  const r=a.finishLegacyBinding(x.token,prepare(a,x.token,k).proof);
  const rotated=a.rotateTrustedGrant(x.grant),revoked=a.revokeTrustedGrant(rotated.grant);
  const before=a.snapshot();
  assert.deepEqual(before.bindings,[r.binding]);
  assert.deepEqual(before.events.map(e=>e.kind),['import','bind','rotate','revoke']);
  assert.equal(a.authenticate(x.token),null);
  assert.equal(a.authenticate(rotated.token),null);
  assert.deepEqual(a.revokeTrustedGrant(revoked),revoked);
  assert.deepEqual(a.snapshot(),before);
  a.close();
  const reopened=openIdentityAuthority(file,network);t.after(()=>reopened.close());
  assert.deepEqual(reopened.snapshot(),before);
  assert.throws(()=>reopened.beginLegacyBinding(rotated.token,k.identity),/GRANT_INACTIVE/);
  assert.throws(()=>add(reopened,'new-route',{token:rotated.token}),/CREDENTIAL_REUSE/);
});
test('two actual processes racing to bind the same key to different authorized routes can commit only one',posix,async t=>{
  const {a,file,network,dir}=fixture(t),x=add(a),y=add(a,'legacy-b');
  const identityFile=path.join(dir,'fixture-key.json');await createIdentityFile(identityFile);
  const code='import {openIdentityAuthority} from '+JSON.stringify(url)+';'+
    'import {loadIdentityFile} from '+JSON.stringify(identityURL)+';'+
    'const a=openIdentityAuthority(process.argv[1],process.argv[2]);const k=await loadIdentityFile(process.argv[3]);'+
    'try{const r=a.beginLegacyBinding(process.argv[4],k.identity);a.approveTrustedAdministrator(r.scope);a.confirmTrustedLocalConsent(r.scope);'+
    'await new Promise(r=>setTimeout(r,40));console.log(JSON.stringify(a.finishLegacyBinding(process.argv[4],k.prove(r.challenge,a.networkId))))}'+
    'catch(e){console.log(e.message);process.exitCode=2}finally{a.close()}';
  const outcomes=await Promise.all([child(code,file,network,identityFile,x.token),child(code,file,network,identityFile,y.token)]);
  assert.equal(outcomes.filter(o=>o.code===0).length,1,JSON.stringify(outcomes));
  assert.equal(outcomes.filter(o=>o.code===2&&o.stdout==='IDENTITY_BINDING_COLLISION').length,1,JSON.stringify(outcomes));
  assert.equal(a.snapshot().bindings.length,1);
  assert.equal(a.snapshot().revision,3);
});
test('two actual processes racing to revoke and rotate the same grant cannot both commit the stale generation',posix,async t=>{
  const {a,file,network}=fixture(t),x=add(a);
  const code='import {openIdentityAuthority} from '+JSON.stringify(url)+';'+
    'const a=openIdentityAuthority(process.argv[1],process.argv[2]),g=JSON.parse(process.argv[3]);'+
    'try{if(process.argv[4]==="revoke")a.revokeTrustedGrant(g);else a.rotateTrustedGrant(g);console.log("committed")}'+
    'catch(e){console.log(e.message);process.exitCode=2}finally{a.close()}';
  const outcomes=await Promise.all(['revoke','rotate'].map(op=>child(code,file,network,JSON.stringify(x.grant),op)));
  assert.equal(outcomes.filter(o=>o.code===0).length,1,JSON.stringify(outcomes));
  assert.equal(outcomes.filter(o=>o.code===2&&o.stdout==='AUTHORITY_STALE_GRANT').length,1,JSON.stringify(outcomes));
  assert.equal(a.snapshot().revision,2);
  assert.equal(a.snapshot().grants[0].generation,2);
  assert.equal(a.authenticate(x.token),null);
});
test('uncommitted revoke transaction dies without persisting a half-revoked grant; committed revoke survives process death',posix,async t=>{
  const {a,file,network}=fixture(t),x=add(a);
  const before=a.snapshot();
  const interrupted='import {DatabaseSync} from "node:sqlite";const d=new DatabaseSync(process.argv[1]);'+
    'd.exec("PRAGMA synchronous=FULL; PRAGMA cache_size=1; BEGIN IMMEDIATE");'+
    'd.exec("UPDATE device_grants SET generation=2,state=\'revoked\',token_hash=NULL; UPDATE authority_meta SET revision=2");'+
    'process.kill(process.pid,"SIGKILL")';
  const result=await child(interrupted,file);
  assert.equal(result.signal,'SIGKILL',JSON.stringify(result));
  a.close();
  const reopened=openIdentityAuthority(file,network);t.after(()=>reopened.close());
  assert.deepEqual(reopened.snapshot(),before);
  assert.deepEqual(reopened.authenticate(x.token),x.grant);
  const commit='import {openIdentityAuthority} from '+JSON.stringify(url)+';'+
    'const a=openIdentityAuthority(process.argv[1],process.argv[2]);a.revokeTrustedGrant(JSON.parse(process.argv[3]));process.kill(process.pid,"SIGKILL")';
  const killed=await child(commit,file,network,JSON.stringify(x.grant));
  assert.equal(killed.signal,'SIGKILL',JSON.stringify(killed));
  reopened.close();
  const after=openIdentityAuthority(file,network);t.after(()=>after.close());
  assert.equal(after.snapshot().grants[0].state,'revoked');
  assert.equal(after.authenticate(x.token),null);
});
test('corrupted history, schema and audit replay are rejected when reopening',posix,t=>{
  const {a,file,network}=fixture(t),x=add(a);
  a.revokeTrustedGrant(x.grant);a.close();
  const db=new DatabaseSync(file);
  db.exec('UPDATE authority_events SET generation=3 WHERE revision=2');db.close();
  assert.throws(()=>openIdentityAuthority(file,network),/EVENT_INVALID/);
  const restore=new DatabaseSync(file);
  restore.exec('UPDATE authority_events SET generation=2 WHERE revision=2; DELETE FROM credential_history');restore.close();
  assert.throws(()=>openIdentityAuthority(file,network),/EVENT_INVALID/);
});
test('no plaintext credential or private key is persisted or returned by public snapshot',posix,t=>{
  const {a,file}=fixture(t),x=add(a),k=generateDeviceIdentity();
  a.finishLegacyBinding(x.token,prepare(a,x.token,k).proof);
  const rotated=a.rotateTrustedGrant(x.grant);
  const state=JSON.stringify(a.snapshot());
  assert.equal(state.includes(x.token),false);
  assert.equal(state.includes(rotated.token),false);
  assert.equal(state.includes(x.input.tokenHash),false);
  a.close();
  const raw=readFileSync(file);
  assert.equal(raw.includes(Buffer.from(x.token)),false);
  assert.equal(raw.includes(Buffer.from(rotated.token)),false);
  const db=new DatabaseSync(file,{readOnly:true});t.after(()=>db.close());
  const columns=db.prepare('PRAGMA table_info(identity_bindings)').all().map(r=>r.name);
  assert.deepEqual(columns,['route_id','identity_id','public_key','bound_revision']);
});
test('pending request capacity is bounded and expired requests free capacity',posix,t=>{
  let now=1000;
  const {a}=fixture(t,{clock:()=>now}),x=add(a),key=generateDeviceIdentity();
  for(let n=0;n<256;n++)a.beginLegacyBinding(x.token,key.identity);
  assert.throws(()=>a.beginLegacyBinding(x.token,key.identity),/PENDING_LIMIT/);
  now+=60000;
  assert.ok(a.beginLegacyBinding(x.token,key.identity).challenge);
});

test('an interrupted binding transaction is rolled back; a committed proof binding survives coordinator death',posix,async t=>{
  const {a,file,network,dir}=fixture(t),x=add(a);
  const keyFile=path.join(dir,'binding-key.json'),k=await createIdentityFile(keyFile);
  const before=a.snapshot();
  const interrupted='import {DatabaseSync} from "node:sqlite";const d=new DatabaseSync(process.argv[1]);'+
    'const g=JSON.parse(process.argv[2]),i=JSON.parse(process.argv[3]);'+
    'd.exec("PRAGMA synchronous=FULL; PRAGMA cache_size=1; BEGIN IMMEDIATE");'+
    'd.prepare("INSERT INTO identity_bindings VALUES (?,?,?,?)").run(g.routeId,i.identityId,i.publicKey,2);'+
    'd.prepare("INSERT INTO authority_events VALUES (?,?,?,?,?)").run(2,"bind",g.routeId,g.grantId,g.generation);'+
    'd.exec("UPDATE authority_meta SET revision=2");process.kill(process.pid,"SIGKILL")';
  const crashed=await child(interrupted,file,JSON.stringify(x.grant),JSON.stringify(k.identity));
  assert.equal(crashed.signal,'SIGKILL',JSON.stringify(crashed));
  a.close();
  const reopened=openIdentityAuthority(file,network);t.after(()=>reopened.close());
  assert.deepEqual(reopened.snapshot(),before);
  assert.deepEqual(reopened.authenticate(x.token),x.grant);
  const committed='import {openIdentityAuthority} from '+JSON.stringify(url)+';'+
    'import {loadIdentityFile} from '+JSON.stringify(identityURL)+';'+
    'const a=openIdentityAuthority(process.argv[1],process.argv[2]),k=await loadIdentityFile(process.argv[3]),token=process.argv[4];'+
    'const r=a.beginLegacyBinding(token,k.identity);a.approveTrustedAdministrator(r.scope);a.confirmTrustedLocalConsent(r.scope);'+
    'a.finishLegacyBinding(token,k.prove(r.challenge,a.networkId));process.kill(process.pid,"SIGKILL")';
  const killed=await child(committed,file,network,keyFile,x.token);
  assert.equal(killed.signal,'SIGKILL',JSON.stringify(killed));
  reopened.close();
  const after=openIdentityAuthority(file,network);t.after(()=>after.close());
  const state=after.snapshot();
  assert.equal(state.revision,2);
  assert.deepEqual(state.bindings,[{routeId:x.grant.routeId,identity:k.identity,boundRevision:2}]);
  assert.deepEqual(after.authenticate(x.token),x.grant);
});
test('simultaneous trusted imports cannot replace the first existing route or create a second credential',posix,async t=>{
  const {a,file,network}=fixture(t);
  const tokens=[credential(),credential()];
  const inputs=tokens.map(token=>({routeId:'legacy-race',tokenHash:digest(token),
    scopeHash:digest('same-scope'),expiresAt:null}));
  const code='import {openIdentityAuthority} from '+JSON.stringify(url)+';'+
    'const a=openIdentityAuthority(process.argv[1],process.argv[2]);'+
    'try{a.importTrustedLegacyGrant(JSON.parse(process.argv[3]));console.log("committed")}'+
    'catch(e){console.log(e.message);process.exitCode=2}finally{a.close()}';
  const outcomes=await Promise.all(inputs.map(input=>child(code,file,network,JSON.stringify(input))));
  assert.equal(outcomes.filter(o=>o.code===0).length,1,JSON.stringify(outcomes));
  assert.equal(outcomes.filter(o=>o.code===2&&o.stdout==='AUTHORITY_ROUTE_EXISTS').length,1);
  assert.equal(a.snapshot().revision,1);
  assert.equal(tokens.filter(token=>a.authenticate(token)).length,1);
});
test('independent requests cannot borrow approvals even for the same grant and key',posix,t=>{
  const {a}=fixture(t),x=add(a),key=generateDeviceIdentity();
  const first=a.beginLegacyBinding(x.token,key.identity);
  const second=a.beginLegacyBinding(x.token,key.identity);
  a.approveTrustedAdministrator(first.scope);
  a.confirmTrustedLocalConsent(second.scope);
  assert.throws(()=>a.finishLegacyBinding(x.token,key.prove(first.challenge,a.networkId)),/APPROVAL_REQUIRED/);
  assert.throws(()=>a.finishLegacyBinding(x.token,key.prove(second.challenge,a.networkId)),/APPROVAL_REQUIRED/);
  assert.equal(a.snapshot().bindings.length,0);
});
