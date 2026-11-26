import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync, symlinkSync, linkSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { generateDeviceIdentity, IdentityChallenges } from '../src/device-identity.js';
import { RouterPrivateState } from '../src/private-state.js';
import { initializeIdentityRegistry, openIdentityRegistry } from '../src/identity-registry.js';

const posix = { skip: process.platform === 'win32' };
const moduleURL = new URL('../src/identity-registry.js', import.meta.url).href;
const actor = () => generateDeviceIdentity().identity;
function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'codas-identity-registry-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'identity.sqlite');
}
function initialize(t, file) {
  const registry = initializeIdentityRegistry(file);
  t.after(() => registry.close());
  return registry;
}
function child(code, ...args) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', code, ...args],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    p.stdout.on('data', c => { stdout += c; });
    p.stderr.on('data', c => { stderr += c; });
    const timer = setTimeout(() => { p.kill('SIGKILL'); }, 15_000);
    p.on('error', e => { clearTimeout(timer); reject(e); });
    p.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout: stdout.trim(), stderr });
    });
  });
}

test('explicit initialization creates a durable network ID without replacing existing state', posix, t => {
  const file = fixture(t);
  const r = initialize(t, file);
  const id = r.networkId;
  assert.match(id, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(r.snapshot(), { version: 1, networkId: id, revision: 0, bindings: [] });
  r.close();
  const before = readFileSync(file);
  assert.throws(() => initializeIdentityRegistry(file), { code: 'EEXIST' });
  assert.deepEqual(readFileSync(file), before);
  const reopened = openIdentityRegistry(file, id);
  t.after(() => reopened.close());
  assert.equal(reopened.networkId, id);
  assert.deepEqual(reopened.snapshot().bindings, []);
  assert.throws(() => reopened.close() || reopened.snapshot(), /IDENTITY_REGISTRY_CLOSED/);
});

test('missing, incomplete and wrong-network state never auto-initializes', posix, t => {
  const file = fixture(t), wrong = randomBytes(32).toString('base64url');
  assert.throws(() => openIdentityRegistry(file, wrong), { code: 'ENOENT' });
  assert.equal(existsSync(file), false);
  assert.throws(() => openIdentityRegistry(file), /EXPECTED_NETWORK_REQUIRED/);
  writeFileSync(file, '', { mode: 0o600 });
  assert.throws(() => openIdentityRegistry(file, wrong));
  assert.equal(readFileSync(file).length, 0);
  assert.throws(() => initializeIdentityRegistry(file), { code: 'EEXIST' });
  const other = path.join(path.dirname(file), 'second.sqlite');
  const r = initialize(t, other);
  assert.throws(() => openIdentityRegistry(other, wrong), /NETWORK_MISMATCH/);
  assert.equal(r.snapshot().revision, 0);
});

test('binding is immutable, one-to-one, idempotent and retains the legacy route ID', posix, t => {
  const file = fixture(t), r = initialize(t, file);
  const a = actor(), b = actor();
  const first = r.recordTrustedBinding('legacy-route-a', a);
  assert.deepEqual(first, { created: true, revision: 1,
    binding: { routeId: 'legacy-route-a', identity: a, boundRevision: 1 } });
  assert.equal(r.recordTrustedBinding('legacy-route-b', b).revision, 2);
  assert.deepEqual(r.recordTrustedBinding('legacy-route-a', a),
    { created: false, revision: 2, binding: first.binding });
  const before = r.snapshot();
  assert.throws(() => r.recordTrustedBinding('legacy-route-a', b), /COLLISION/);
  assert.throws(() => r.recordTrustedBinding('legacy-route-c', a), /COLLISION/);
  assert.throws(() => r.recordTrustedBinding(' invalid ', actor()));
  assert.throws(() => r.recordTrustedBinding('legacy-route-c', { ...actor(), accessToken: 'fixture' }));
  assert.deepEqual(r.snapshot(), before);
  r.close();
  const reopened = openIdentityRegistry(file, before.networkId);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.snapshot(), before);
});

test('storage refuses unsafe permissions, symlinks, hard links and unsafe journal files', posix, t => {
  const file = fixture(t), r = initialize(t, file), id = r.networkId;
  r.close();
  const alias = path.join(path.dirname(file), 'alias.sqlite');
  symlinkSync(file, alias);
  assert.throws(() => openIdentityRegistry(alias, id), /STORAGE_UNSAFE/);
  const hardLink = path.join(path.dirname(file), 'hard-link.sqlite');
  linkSync(file, hardLink);
  assert.throws(() => openIdentityRegistry(file, id), /STORAGE_UNSAFE/);
  rmSync(hardLink);
  chmodSync(file, 0o644);
  assert.throws(() => openIdentityRegistry(file, id), /STORAGE_UNSAFE/);
  chmodSync(file, 0o600);
  symlinkSync(file, file + '-journal');
  assert.throws(() => openIdentityRegistry(file, id), /STORAGE_UNSAFE/);
  rmSync(file + '-journal');
  const unsafe = path.join(path.dirname(file), 'unsafe');
  mkdirSync(unsafe, { mode: 0o755 });
  assert.throws(() => initializeIdentityRegistry(path.join(unsafe,'new.sqlite')), /STORAGE_UNSAFE/);
});

test('invalid database format, schema and logical revisions fail closed', posix, t => {
  const file = fixture(t), r = initialize(t, file), id = r.networkId;
  r.recordTrustedBinding('legacy-a', actor());
  r.close();
  const raw = new DatabaseSync(file);
  raw.exec('UPDATE registry_meta SET revision = 2');
  raw.close();
  assert.throws(() => openIdentityRegistry(file, id), /REVISION_INVALID/);
  const restore = new DatabaseSync(file);
  restore.exec('UPDATE registry_meta SET revision = 1; CREATE TABLE unexpected(x TEXT)');
  restore.close();
  assert.throws(() => openIdentityRegistry(file, id), /SCHEMA_INVALID/);
  const malformed = path.join(path.dirname(file), 'malformed.sqlite');
  writeFileSync(malformed, 'not sqlite', { mode: 0o600 });
  assert.throws(() => openIdentityRegistry(malformed, id));
  assert.equal(readFileSync(malformed, 'utf8'), 'not sqlite');
});

test('corrupt public key/fingerprint data is rejected when reopened', posix, t => {
  const file = fixture(t), r = initialize(t, file), id = r.networkId;
  r.recordTrustedBinding('legacy-a', actor());
  r.close();
  const raw = new DatabaseSync(file);
  raw.prepare('UPDATE identity_bindings SET public_key = ?').run(actor().publicKey);
  raw.close();
  assert.throws(() => openIdentityRegistry(file, id), /FINGERPRINT_MISMATCH/);
});

test('simultaneous initialization creates exactly one network', posix, async t => {
  const file = fixture(t);
  const code = 'import {initializeIdentityRegistry} from '+JSON.stringify(moduleURL)+';'+
    'try {const r=initializeIdentityRegistry(process.argv[1]);console.log(r.networkId);r.close()}'+
    'catch(e){console.log(e.code||e.message);process.exitCode=2}';
  const outcomes = await Promise.all(Array.from({length: 4}, () => child(code, file)));
  const good = outcomes.filter(x => x.code === 0);
  assert.equal(good.length, 1, JSON.stringify(outcomes));
  assert.equal(outcomes.filter(x => x.code === 2 && x.stdout === 'EEXIST').length, 3);
  const r = openIdentityRegistry(file, good[0].stdout);
  t.after(() => r.close());
  assert.equal(r.snapshot().revision, 0);
});

function bindInChild(file, network, route, identity) {
  const code = 'import {openIdentityRegistry} from '+JSON.stringify(moduleURL)+';'+
    'try {const r=openIdentityRegistry(process.argv[1],process.argv[2]);'+
    'try {console.log(JSON.stringify(r.recordTrustedBinding(process.argv[3],JSON.parse(process.argv[4]))))}finally{r.close()}}'+
    'catch(e){console.log(e.code||e.message);process.exitCode=2}';
  return child(code, file, network, route, JSON.stringify(identity));
}

test('concurrent processes cannot bind one route to different identities', posix, async t => {
  const file = fixture(t), r = initialize(t, file), id = r.networkId;
  const outcomes = await Promise.all([bindInChild(file,id,'legacy-a',actor()),bindInChild(file,id,'legacy-a',actor())]);
  assert.equal(outcomes.filter(x=>x.code===0).length, 1, JSON.stringify(outcomes));
  assert.equal(outcomes.filter(x=>x.code===2&&x.stdout==='IDENTITY_BINDING_COLLISION').length, 1);
  assert.equal(r.snapshot().revision, 1);
});

test('concurrent processes cannot bind one identity to different routes', posix, async t => {
  const file = fixture(t), r = initialize(t, file), id = r.networkId, a = actor();
  const outcomes = await Promise.all([bindInChild(file,id,'legacy-a',a),bindInChild(file,id,'legacy-b',a)]);
  assert.equal(outcomes.filter(x=>x.code===0).length, 1, JSON.stringify(outcomes));
  assert.equal(outcomes.filter(x=>x.code===2&&x.stdout==='IDENTITY_BINDING_COLLISION').length, 1);
  assert.equal(r.snapshot().revision, 1);
});

test('distinct concurrent bindings serialize without lost updates', posix, async t => {
  const file = fixture(t), r = initialize(t, file), id = r.networkId;
  const outcomes = await Promise.all(Array.from({length: 6}, (_,i)=>bindInChild(file,id,'legacy-'+i,actor())));
  assert.ok(outcomes.every(x=>x.code===0), JSON.stringify(outcomes));
  const state = r.snapshot();
  assert.equal(state.revision, 6);
  assert.deepEqual(state.bindings.map(x=>x.boundRevision), [1,2,3,4,5,6]);
  assert.equal(new Set(state.bindings.map(x=>x.routeId)).size, 6);
});

test('abrupt process death inside transaction cannot leave a partial binding', posix, async t => {
  const file = fixture(t), r = initialize(t, file), id = r.networkId, a = actor();
  const original = r.recordTrustedBinding('legacy-a', a);
  const b = actor();
  const code = 'import {DatabaseSync} from "node:sqlite";'+
    'const db=new DatabaseSync(process.argv[1]);const a=JSON.parse(process.argv[2]);'+
    'db.exec("PRAGMA synchronous=FULL; PRAGMA cache_size=1; BEGIN IMMEDIATE");'+
    'db.prepare("INSERT INTO identity_bindings VALUES (?,?,?,?)").run("legacy-b",a.identityId,a.publicKey,2);'+
    'db.exec("UPDATE registry_meta SET revision=2");'+
    'process.kill(process.pid,"SIGKILL")';
  const result = await child(code, file, JSON.stringify(b));
  assert.equal(result.signal, 'SIGKILL', JSON.stringify(result));
  r.close();
  const reopened = openIdentityRegistry(file,id);
  t.after(()=>reopened.close());
  assert.deepEqual(reopened.snapshot().bindings,[original.binding]);
  assert.equal(reopened.recordTrustedBinding('legacy-b',b).revision,2);
});

test('a committed binding survives abrupt coordinator process death', posix, async t => {
  const file = fixture(t), r = initialize(t, file), id = r.networkId, a = actor();
  r.close();
  const code = 'import {openIdentityRegistry} from '+JSON.stringify(moduleURL)+';'+
    'const r=openIdentityRegistry(process.argv[1],process.argv[2]);'+
    'r.recordTrustedBinding("legacy-a",JSON.parse(process.argv[3]));process.kill(process.pid,"SIGKILL")';
  const result = await child(code,file,id,JSON.stringify(a));
  assert.equal(result.signal,'SIGKILL',JSON.stringify(result));
  const reopened=openIdentityRegistry(file,id);
  t.after(()=>reopened.close());
  assert.deepEqual(reopened.snapshot().bindings,[{routeId:'legacy-a',identity:a,boundRevision:1}]);
});

test('registry format cannot contain private keys, tokens, or permission grants', posix, t => {
  const file = fixture(t), r = initialize(t, file), a = actor();
  r.recordTrustedBinding('legacy-a',a);
  r.close();
  const raw=new DatabaseSync(file,{readOnly:true});
  t.after(()=>raw.close());
  assert.deepEqual(raw.prepare('PRAGMA table_info(identity_bindings)').all().map(x=>x.name),
    ['route_id','identity_id','public_key','bound_revision']);
  assert.deepEqual(raw.prepare('PRAGMA table_info(registry_meta)').all().map(x=>x.name),
    ['singleton','network_id','revision']);
});


test('a replaced database or changed directory permissions stop writes on an open handle', posix, t => {
  const file = fixture(t), r = initialize(t, file), a = actor();
  const dir = path.dirname(file);
  chmodSync(dir,0o755);
  try { assert.throws(() => r.recordTrustedBinding('legacy-a',a), /STORAGE_UNSAFE/); }
  finally { chmodSync(dir,0o700); }
  const before = readFileSync(file);
  renameSync(file,file+'.previous');
  writeFileSync(file,before,{mode:0o600});
  assert.throws(() => r.recordTrustedBinding('legacy-a',a), /FILE_REPLACED/);
  assert.deepEqual(readFileSync(file),before);
  r.close();
});

test('a changed metadata revision cannot be advanced by an already-open writer', posix, t => {
  const file=fixture(t), r=initialize(t,file);
  r.recordTrustedBinding('legacy-a',actor());
  const raw=new DatabaseSync(file);
  raw.exec('UPDATE registry_meta SET revision = 3');
  raw.close();
  assert.throws(()=>r.recordTrustedBinding('legacy-b',actor()),/REVISION_INVALID/);
  assert.throws(()=>r.snapshot(),/REVISION_INVALID/);
});

test('identity proof and trusted binding leave existing legacy credential and route unchanged', posix, async t => {
  const file=fixture(t), r=initialize(t,file);
  const dir=path.dirname(file), legacy=new RouterPrivateState({stateDir:dir});
  await legacy.init();
  const {token}=await legacy.enrollAgent({
    id:'legacy-fixture-device',label:'Fixture name',platform:'win32',
    roots:['fixture-root'],capabilities:['devspace-http']
  });
  const oldBytes=readFileSync(path.join(dir,'router.json'));
  const oldRecord=legacy.authenticateAgent(token);
  assert.equal(oldRecord.id,'legacy-fixture-device');
  const key=generateDeviceIdentity();
  const book=new IdentityChallenges(r.networkId);
  const challenge=book.issue(key.identity);
  const verified=book.verify(key.prove(challenge,r.networkId));
  assert.deepEqual(verified,key.identity);
  // This is a trusted test fixture, not a live migration endpoint.
  const result=r.recordTrustedBinding(oldRecord.id,verified);
  assert.equal(result.binding.routeId,oldRecord.id);
  assert.deepEqual(readFileSync(path.join(dir,'router.json')),oldBytes);
  assert.deepEqual(legacy.authenticateAgent(token),oldRecord);
  assert.equal(legacy.authenticateAgent(legacy.pairingToken),null);
  assert.equal(book.verify(key.prove(challenge,r.networkId)),null);
});
