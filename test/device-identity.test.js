import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, chmod, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  generateDeviceIdentity, normalizeDeviceIdentity, createIdentityFile,
  loadIdentityFile, IdentityChallenges, planIdentityBinding
} from '../src/device-identity.js';

const NETWORK = 'test-network-0123456789';
const OTHER = 'other-network-0123456789';
function actor() { return generateDeviceIdentity(); }
const posix = { skip: process.platform === 'win32' };

test('identity is public-key-derived, distinct, canonical, and contains no secret', () => {
  const a = actor(), b = actor();
  assert.notEqual(a.identity.identityId, b.identity.identityId);
  assert.deepEqual(normalizeDeviceIdentity(a.identity), a.identity);
  assert.deepEqual(Object.keys(a.identity).sort(), ['algorithm','identityId','publicKey','version']);
  assert.throws(() => normalizeDeviceIdentity({...a.identity, identityId:b.identity.identityId}));
  assert.throws(() => normalizeDeviceIdentity({...a.identity, publicKey:a.identity.publicKey+'='}));
  assert.throws(() => normalizeDeviceIdentity({...a.identity, algorithm:'RSA'}));
  assert.throws(() => normalizeDeviceIdentity({...a.identity, privateKey:'invalid'}));
});

test('explicit key creation persists identity; repeat create never replaces it', posix, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(),'codas-identity-test-'));
  try {
    const file = path.join(dir,'key.json');
    await assert.rejects(loadIdentityFile(file), {code:'ENOENT'});
    const a = await createIdentityFile(file);
    const before = await readFile(file);
    await assert.rejects(createIdentityFile(file), {code:'EEXIST'});
    assert.deepEqual(await readFile(file), before);
    const b = await loadIdentityFile(file);
    assert.deepEqual(b.identity,a.identity);
    const book = new IdentityChallenges(NETWORK);
    assert.deepEqual(book.verify(b.prove(book.issue(a.identity),NETWORK)),a.identity);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('concurrent explicit creation publishes exactly one complete identity', posix, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(),'codas-identity-race-'));
  try {
    const file=path.join(dir,'key.json');
    const results=await Promise.allSettled([createIdentityFile(file),createIdentityFile(file)]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(results.find(r=>r.status==='rejected').reason.code,'EEXIST');
    assert.deepEqual((await loadIdentityFile(file)).identity,
      results.find(r=>r.status==='fulfilled').value.identity);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('corrupt state, mismatched keys, permissive files and symlinks fail closed',posix,async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'codas-identity-bad-'));
  try {
    const file=path.join(dir,'key.json');
    const a=await createIdentityFile(file);
    const other=actor();
    const saved=JSON.parse(await readFile(file,'utf8'));
    await writeFile(file,JSON.stringify({...saved,identity:other.identity}));
    await assert.rejects(loadIdentityFile(file),/IDENTITY_STORAGE_KEY_MISMATCH/);
    await writeFile(file,JSON.stringify(saved));
    await chmod(file,0o644);
    await assert.rejects(loadIdentityFile(file),/IDENTITY_STORAGE_UNSAFE/);
    await chmod(file,0o600);
    await symlink(file,path.join(dir,'alias.json'));
    await assert.rejects(loadIdentityFile(path.join(dir,'alias.json')));
    await writeFile(file,'{');
    await assert.rejects(loadIdentityFile(file));
    assert.equal(await readFile(file,'utf8'),'{');
    await assert.rejects(createIdentityFile(file),{code:'EEXIST'});
    assert.notEqual(a.identity.identityId,other.identity.identityId);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('one successful proof consumes its challenge; restart invalidates pending proofs',()=>{
  const a=actor(), book=new IdentityChallenges(NETWORK);
  const c=book.issue(a.identity), proof=a.prove(c,NETWORK);
  assert.equal(new IdentityChallenges(NETWORK).verify(proof),null);
  assert.deepEqual(book.verify(proof),a.identity);
  assert.equal(book.verify(proof),null);
  assert.equal(book.verify({...proof,accessToken:'not a valid proof'}),null);
});

test('wrong device, nonce, network and challenge scope cannot prove identity',()=>{
  const a=actor(), b=actor(), book=new IdentityChallenges(NETWORK);
  const c=book.issue(a.identity);
  assert.throws(()=>b.prove(c,NETWORK),/SCOPE_MISMATCH/);
  assert.throws(()=>a.prove(c,OTHER),/SCOPE_MISMATCH/);
  assert.throws(()=>a.prove({...c,purpose:'grant-access'},NETWORK));
  const forged=b.prove({...c,identityId:b.identity.identityId},NETWORK);
  assert.equal(book.verify({...forged,identityId:a.identity.identityId}),null);
  const changedNonce=c.nonce[0]==='A'?'B':'A';
  assert.equal(book.verify(a.prove({...c,nonce:changedNonce+c.nonce.slice(1)},NETWORK)),null);
  assert.equal(book.verify(a.prove({...c,networkId:OTHER},OTHER)),null);
  const proof=a.prove(c,NETWORK);
  assert.equal(book.verify({...proof,signature:'invalid='}),null);
  assert.deepEqual(book.verify(proof),a.identity);
});

test('expired or clock-rollback challenges are invalid and capacity is bounded',()=>{
  let now=1000;
  const a=actor(), book=new IdentityChallenges(NETWORK,{clock:()=>now});
  const proof=a.prove(book.issue(a.identity),NETWORK);
  now+=60_000;
  assert.equal(book.verify(proof),null);
  for(let i=0;i<256;i++)book.issue(a.identity);
  assert.throws(()=>book.issue(a.identity),/IDENTITY_CHALLENGE_LIMIT/);
  now+=60_000;
  const next=a.prove(book.issue(a.identity),NETWORK);
  now--;
  assert.equal(book.verify(next),null);
});

test('trusted binding plan preserves route identity and rejects duplicate or changed keys',()=>{
  const a=actor(), b=actor();
  const records=planIdentityBinding([],'legacy-route-a',a.identity);
  assert.deepEqual(planIdentityBinding(records,'legacy-route-a',a.identity),records);
  assert.throws(()=>planIdentityBinding(records,'legacy-route-a',b.identity),/COLLISION/);
  assert.throws(()=>planIdentityBinding(records,'legacy-route-b',a.identity),/COLLISION/);
  assert.throws(()=>planIdentityBinding([...records,...records],'route-c',b.identity),/COLLISION/);
  assert.equal(planIdentityBinding(records,'legacy-route-b',b.identity).length,2);
  assert.equal(records.length,1);
});
