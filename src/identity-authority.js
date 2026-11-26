// Unified coordinator authority reference. NOT wired into the live Router.
// All trusted mutations and final identity binding share one SQLite transaction
// authority. The transport, administrator and local-consent adapters are future
// work; never expose any *Trusted method directly to a network request.
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import {
  invariant, isNetworkId, checkedPath, checkedFile, checkSidecars,
  syncDirectory, connect, transaction
} from './identity-registry-storage.js';
import { normalizeDeviceIdentity, planIdentityBinding, IdentityChallenges } from './device-identity.js';

const VERSION = 2;
const APP_ID = 0x43444931; // Same family as the isolated V1 registry.
const MAX_GRANTS = 10_000;
const MAX_EVENTS = 100_000;
const MAX_PENDING = 256;
const FACTORY = Symbol('authority factory');
const META = 'CREATE TABLE authority_meta (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), network_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 0)) STRICT';
const GRANTS = "CREATE TABLE device_grants (route_id TEXT PRIMARY KEY NOT NULL, grant_id TEXT NOT NULL UNIQUE, generation INTEGER NOT NULL CHECK(generation > 0), state TEXT NOT NULL CHECK(state IN ('active','revoked')), token_hash TEXT UNIQUE, scope_hash TEXT NOT NULL, expires_at INTEGER, CHECK((state = 'active' AND token_hash IS NOT NULL) OR (state = 'revoked' AND token_hash IS NULL))) STRICT";
const HISTORY = 'CREATE TABLE credential_history (token_hash TEXT PRIMARY KEY NOT NULL, route_id TEXT NOT NULL REFERENCES device_grants(route_id), generation INTEGER NOT NULL CHECK(generation > 0), UNIQUE(route_id, generation)) STRICT';
const BINDINGS = 'CREATE TABLE identity_bindings (route_id TEXT PRIMARY KEY NOT NULL REFERENCES device_grants(route_id), identity_id TEXT NOT NULL UNIQUE, public_key TEXT NOT NULL, bound_revision INTEGER NOT NULL UNIQUE CHECK(bound_revision > 0)) STRICT';
const EVENTS = "CREATE TABLE authority_events (revision INTEGER PRIMARY KEY CHECK(revision > 0), kind TEXT NOT NULL CHECK(kind IN ('import','bind','rotate','revoke')), route_id TEXT NOT NULL REFERENCES device_grants(route_id), grant_id TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation > 0)) STRICT";
const SCHEMA = new Map([
  ['authority_events', EVENTS], ['authority_meta', META], ['credential_history', HISTORY],
  ['device_grants', GRANTS], ['identity_bindings', BINDINGS]
]);

function exact(value, fields) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every(f => Object.hasOwn(value, f));
}
function validRoute(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 &&
    value === value.trim() && !/[\x00-\x1f\x7f]/.test(value);
}
function validGrantId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{22}$/.test(value) &&
    Buffer.from(value, 'base64url').toString('base64url') === value;
}
function generation(value) { return Number.isSafeInteger(value) && value > 0; }
function validTime(value) { return Number.isSafeInteger(value) && value >= 0; }
function validExpiry(value) { return value === null || validTime(value); }
function hashToken(token) {
  invariant(typeof token === 'string' && token.length >= 32 && token.length <= 512 &&
    /^[A-Za-z0-9_-]+$/.test(token), 'AUTHORITY_CREDENTIAL_INVALID');
  return createHash('sha256').update(token, 'utf8').digest('base64url');
}
function schema(db) {
  invariant(db.prepare('PRAGMA application_id').get().application_id === APP_ID &&
    db.prepare('PRAGMA user_version').get().user_version === VERSION,
    'AUTHORITY_FORMAT_INVALID');
  const rows = db.prepare("SELECT name,type,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();
  invariant(rows.length === SCHEMA.size && rows.every(r =>
    r.type === 'table' && SCHEMA.get(r.name) === r.sql), 'AUTHORITY_SCHEMA_INVALID');
}
function meta(db, networkId) {
  const rows = db.prepare('SELECT singleton,network_id,revision FROM authority_meta LIMIT 2').all();
  const m = rows[0];
  invariant(rows.length === 1 && m.singleton === 1 && isNetworkId(m.network_id) &&
    Number.isSafeInteger(m.revision) && m.revision >= 0 && m.revision <= MAX_EVENTS,
    'AUTHORITY_METADATA_INVALID');
  invariant(m.network_id === networkId, 'AUTHORITY_NETWORK_MISMATCH');
  const range = db.prepare('SELECT count(*) AS n,min(revision) AS first,max(revision) AS last FROM authority_events').get();
  invariant(range.n === m.revision && (range.n === 0 || (range.first === 1 && range.last === m.revision)),
    'AUTHORITY_REVISION_INVALID');
  return m.revision;
}
function publicGrant(row) {
  invariant(row && validRoute(row.route_id) && validGrantId(row.grant_id) &&
    generation(row.generation) && ['active','revoked'].includes(row.state) &&
    isNetworkId(row.scope_hash) && validExpiry(row.expires_at) &&
    (row.state === 'active' ? isNetworkId(row.token_hash) : row.token_hash === null),
    'AUTHORITY_GRANT_INVALID');
  return { routeId: row.route_id, grantId: row.grant_id, generation: row.generation,
    state: row.state, scopeHash: row.scope_hash, expiresAt: row.expires_at };
}
function binding(row) {
  invariant(row && validRoute(row.route_id) && generation(row.bound_revision) &&
    row.bound_revision <= MAX_EVENTS, 'AUTHORITY_BINDING_INVALID');
  const identity = normalizeDeviceIdentity({version:1, algorithm:'P-256',
    identityId:row.identity_id, publicKey:row.public_key});
  return { ...planIdentityBinding([],row.route_id,identity)[0], boundRevision:row.bound_revision };
}
function selectRoute(db, routeId) {
  invariant(validRoute(routeId), 'AUTHORITY_ROUTE_INVALID');
  return db.prepare('SELECT * FROM device_grants WHERE route_id = ?').get(routeId);
}
function active(row, now) {
  return row && row.state === 'active' && (row.expires_at === null || now < row.expires_at);
}
function authenticate(db, token, now) {
  let hash;
  try { hash = hashToken(token); } catch { return null; }
  const row = db.prepare('SELECT * FROM device_grants WHERE token_hash = ?').get(hash);
  if (!row) return null;
  const grant = publicGrant(row);
  invariant(db.prepare('SELECT token_hash FROM credential_history WHERE route_id = ? AND generation = ?')
    .get(grant.routeId,grant.generation)?.token_hash === hash, 'AUTHORITY_CREDENTIAL_HISTORY_INVALID');
  return active(row,now) ? grant : null;
}
function sameGrant(a,b) {
  return a && b && a.routeId === b.routeId && a.grantId === b.grantId &&
    a.generation === b.generation && a.state === b.state &&
    a.scopeHash === b.scopeHash && a.expiresAt === b.expiresAt;
}
function event(db, revision, kind, grant) {
  invariant(revision < MAX_EVENTS, 'AUTHORITY_CAPACITY');
  const next = revision + 1;
  db.prepare('INSERT INTO authority_events VALUES (?,?,?,?,?)')
    .run(next,kind,grant.routeId,grant.grantId,grant.generation);
  invariant(db.prepare('UPDATE authority_meta SET revision = ? WHERE singleton=1 AND revision=?')
    .run(next,revision).changes === 1, 'AUTHORITY_REVISION_INVALID');
  return next;
}
function rememberCredential(db, hash, route, gen) {
  invariant(isNetworkId(hash), 'AUTHORITY_HASH_INVALID');
  invariant(!db.prepare('SELECT 1 FROM credential_history WHERE token_hash=?').get(hash),
    'AUTHORITY_CREDENTIAL_REUSE');
  db.prepare('INSERT INTO credential_history VALUES (?,?,?)').run(hash,route,gen);
}
function reviewBinding(db, routeId, identity) {
  const rows = db.prepare('SELECT * FROM identity_bindings WHERE route_id=? OR identity_id=?')
    .all(routeId,identity.identityId);
  if (!rows.length) return null;
  invariant(rows.length === 1 && rows[0].route_id === routeId &&
    rows[0].identity_id === identity.identityId && rows[0].public_key === identity.publicKey,
    'IDENTITY_BINDING_COLLISION');
  return binding(rows[0]);
}
function stateSnapshot(db,networkId) {
  const revision = meta(db,networkId);
  const grants = db.prepare('SELECT * FROM device_grants ORDER BY route_id LIMIT ?').all(MAX_GRANTS+1);
  invariant(grants.length <= MAX_GRANTS,'AUTHORITY_CAPACITY');
  const history = db.prepare('SELECT * FROM credential_history LIMIT ?').all(MAX_EVENTS+1);
  const bindings = db.prepare('SELECT * FROM identity_bindings ORDER BY bound_revision LIMIT ?').all(MAX_GRANTS+1);
  const events = db.prepare('SELECT * FROM authority_events ORDER BY revision LIMIT ?').all(MAX_EVENTS+1);
  invariant(history.length <= MAX_EVENTS && bindings.length <= grants.length &&
    events.length === revision,'AUTHORITY_STATE_INVALID');
  const routes = new Map(grants.map(r => [r.route_id,publicGrant(r)]));
  const credentials = new Map();
  for (const h of history) {
    invariant(isNetworkId(h.token_hash) && generation(h.generation) && routes.has(h.route_id),
      'AUTHORITY_CREDENTIAL_HISTORY_INVALID');
    const key = JSON.stringify([h.route_id,h.generation]);
    invariant(!credentials.has(key),'AUTHORITY_CREDENTIAL_HISTORY_INVALID');
    credentials.set(key,h.token_hash);
  }
  const identities = bindings.map(binding);
  const byRoute = new Map(identities.map(b=>[b.routeId,b]));
  const replay = new Map();
  let expectedHistory=0,expectedBindings=0;
  for (const [i,e] of events.entries()) {
    const g=routes.get(e.route_id);
    invariant(e.revision===i+1 && g && e.grant_id===g.grantId && generation(e.generation),
      'AUTHORITY_EVENT_INVALID');
    const prev=replay.get(e.route_id);
    const key=JSON.stringify([e.route_id,e.generation]);
    if(e.kind==='import'){
      invariant(!prev && e.generation===1 && credentials.has(key),'AUTHORITY_EVENT_INVALID');
      replay.set(e.route_id,{generation:1,state:'active',bound:false});
      expectedHistory++;
    } else {
      invariant(prev && prev.state==='active','AUTHORITY_EVENT_INVALID');
      if(e.kind==='bind'){
        invariant(!prev.bound && e.generation===prev.generation &&
          byRoute.get(e.route_id)?.boundRevision===e.revision,'AUTHORITY_EVENT_INVALID');
        prev.bound=true;expectedBindings++;
      }else if(e.kind==='rotate'){
        invariant(e.generation===prev.generation+1 && credentials.has(key),'AUTHORITY_EVENT_INVALID');
        prev.generation=e.generation;expectedHistory++;
      }else if(e.kind==='revoke'){
        invariant(e.generation===prev.generation+1 && !credentials.has(key),'AUTHORITY_EVENT_INVALID');
        prev.generation=e.generation;prev.state='revoked';
      }else throw Error('AUTHORITY_EVENT_INVALID');
    }
  }
  invariant(expectedHistory===history.length && expectedBindings===identities.length &&
    replay.size===routes.size,'AUTHORITY_STATE_INVALID');
  for(const row of grants){
    const p=replay.get(row.route_id), g=routes.get(row.route_id);
    invariant(p.generation===g.generation && p.state===g.state &&
      p.bound===byRoute.has(g.routeId),'AUTHORITY_STATE_INVALID');
    if(g.state==='active'){
      invariant(credentials.get(JSON.stringify([g.routeId,g.generation]))===row.token_hash,
        'AUTHORITY_CREDENTIAL_HISTORY_INVALID');
    }
  }
  invariant(!db.prepare('PRAGMA foreign_key_check').get(),'AUTHORITY_FOREIGN_KEY_INVALID');
  return {version:VERSION,networkId,revision,grants:[...routes.values()],bindings:identities,
    events:events.map(e=>({revision:e.revision,kind:e.kind,routeId:e.route_id,
      grantId:e.grant_id,generation:e.generation}))};
}
function immutableScope(challenge,grant,identity) {
  return Object.freeze({operation:'legacy-identity-binding',networkId:challenge.networkId,
    challengeId:challenge.challengeId,identityId:identity.identityId,
    routeId:grant.routeId,grantId:grant.grantId,generation:grant.generation,
    scopeHash:grant.scopeHash,expiresAt:challenge.expiresAt});
}
function matchesScope(a,b) {
  return exact(a,Object.keys(b)) && Object.keys(b).every(k=>a[k]===b[k]);
}

export class IdentityAuthority {
  #db; #file; #fileIdentity; #networkId; #clock; #book; #pending=new Map();
  constructor(key,db,file,fileIdentity,networkId,clock){
    invariant(key===FACTORY,'AUTHORITY_USE_FACTORY');
    this.#db=db;this.#file=file;this.#fileIdentity=fileIdentity;
    this.#networkId=networkId;this.#clock=clock;
    this.#book=new IdentityChallenges(networkId,{clock:()=>this.#now()});
  }
  get networkId(){return this.#networkId;}
  #now(){
    const now=this.#clock();
    invariant(validTime(now) && now<=Number.MAX_SAFE_INTEGER-60_000,'AUTHORITY_CLOCK_INVALID');
    return now;
  }
  #connection(){
    invariant(this.#db!==null,'AUTHORITY_CLOSED');
    invariant(checkedPath(this.#file)===this.#file,'AUTHORITY_STORAGE_UNSAFE');
    const current=checkedFile(this.#file);
    invariant(current.dev===this.#fileIdentity.dev && current.ino===this.#fileIdentity.ino,
      'AUTHORITY_FILE_REPLACED');
    checkSidecars(this.#file);
    return this.#db;
  }
  #tx(write,fn){
    const db=this.#connection();
    return transaction(db,write,()=>{
      schema(db);
      const revision=meta(db,this.#networkId);
      return fn(db,revision);
    });
  }
  #prune(now){
    for(const [id,p] of this.#pending){
      if(now<p.challenge.issuedAt || now>=p.challenge.expiresAt)this.#pending.delete(id);
    }
  }
  snapshot(){return this.#tx(false,db=>stateSnapshot(db,this.#networkId));}
  authenticate(token){return this.#tx(false,db=>authenticate(db,token,this.#now()));}

  // Explicit trusted import of an independently reviewed existing grant.
  // There is intentionally no shared-pairing-secret enrollment path here.
  // Neither import nor re-import may overwrite even a revoked route.
  importTrustedLegacyGrant(record){
    invariant(exact(record,['routeId','tokenHash','scopeHash','expiresAt']) &&
      validRoute(record.routeId) && isNetworkId(record.tokenHash) &&
      isNetworkId(record.scopeHash) && validExpiry(record.expiresAt),'AUTHORITY_IMPORT_INVALID');
    return this.#tx(true,(db,rev)=>{
      invariant(record.expiresAt===null || record.expiresAt>this.#now(),'AUTHORITY_GRANT_EXPIRED');
      invariant(!selectRoute(db,record.routeId),'AUTHORITY_ROUTE_EXISTS');
      invariant(!db.prepare('SELECT 1 FROM credential_history WHERE token_hash=?').get(record.tokenHash),'AUTHORITY_CREDENTIAL_REUSE');
      invariant(db.prepare('SELECT count(*) AS n FROM device_grants').get().n<MAX_GRANTS,'AUTHORITY_CAPACITY');
      const grantId=randomBytes(16).toString('base64url');
      db.prepare('INSERT INTO device_grants VALUES (?,?,?,?,?,?,?)')
        .run(record.routeId,grantId,1,'active',record.tokenHash,record.scopeHash,record.expiresAt);
      rememberCredential(db,record.tokenHash,record.routeId,1);
      const grant=publicGrant(selectRoute(db,record.routeId));
      event(db,rev,'import',grant);
      return grant;
    });
  }
  // Administrative CAS operations. The future authenticated control plane
  // supplies a trusted, previously observed grant snapshot.
  #mutationGrant(db,expected){
    invariant(expected && validRoute(expected.routeId),'AUTHORITY_EXPECTED_GRANT_REQUIRED');
    const row=selectRoute(db,expected.routeId);
    invariant(row && sameGrant(publicGrant(row),expected),'AUTHORITY_STALE_GRANT');
    return publicGrant(row);
  }
  rotateTrustedGrant(expected){
    return this.#tx(true,(db,rev)=>{
      const g=this.#mutationGrant(db,expected);
      invariant(active(selectRoute(db,g.routeId),this.#now()),'AUTHORITY_GRANT_INACTIVE');
      invariant(generation(g.generation+1),'AUTHORITY_GENERATION_INVALID');
      const token=randomBytes(32).toString('base64url'),hash=hashToken(token);
      rememberCredential(db,hash,g.routeId,g.generation+1);
      db.prepare('UPDATE device_grants SET generation=?,token_hash=? WHERE route_id=?')
        .run(g.generation+1,hash,g.routeId);
      const grant=publicGrant(selectRoute(db,g.routeId));
      event(db,rev,'rotate',grant);
      return {grant,token}; // Plain credential returned once, never stored or logged.
    });
  }
  revokeTrustedGrant(expected){
    return this.#tx(true,(db,rev)=>{
      const g=this.#mutationGrant(db,expected);
      if(g.state==='revoked')return g;
      invariant(generation(g.generation+1),'AUTHORITY_GENERATION_INVALID');
      db.prepare("UPDATE device_grants SET generation=?,state='revoked',token_hash=NULL WHERE route_id=?")
        .run(g.generation+1,g.routeId);
      const grant=publicGrant(selectRoute(db,g.routeId));
      event(db,rev,'revoke',grant);
      return grant;
    });
  }
  beginLegacyBinding(token,identity){
    const canonical=normalizeDeviceIdentity(identity);
    const now=this.#now();
    this.#prune(now);
    invariant(this.#pending.size<MAX_PENDING,'AUTHORITY_PENDING_LIMIT');
    const grant=this.#tx(false,db=>{
      const g=authenticate(db,token,this.#now());
      invariant(g,'AUTHORITY_GRANT_INACTIVE');
      reviewBinding(db,g.routeId,canonical);
      return g;
    });
    const challenge=this.#book.issue(canonical);
    const scope=immutableScope(challenge,grant,canonical);
    this.#pending.set(challenge.challengeId,{challenge,grant,identity:canonical,scope,admin:false,local:false});
    return {challenge,scope};
  }
  #approve(scope,kind){
    const now=this.#now();this.#prune(now);
    const p=this.#pending.get(scope?.challengeId);
    invariant(p && matchesScope(scope,p.scope),'AUTHORITY_APPROVAL_SCOPE_INVALID');
    this.#tx(false,db=>{
      const row=selectRoute(db,p.grant.routeId);
      invariant(active(row,this.#now()) && sameGrant(publicGrant(row),p.grant),'AUTHORITY_STALE_GRANT');
    });
    p[kind]=true;
  }
  // These two adapters require independent trusted decisions from the future
  // authenticated admin UI and on-device consent channel. Neither is an
  // endpoint, nor accepts caller-supplied "isAdmin"/"localConsent" flags.
  approveTrustedAdministrator(scope){this.#approve(scope,'admin');}
  confirmTrustedLocalConsent(scope){this.#approve(scope,'local');}
  cancelTrustedBinding(scope){
    const p=this.#pending.get(scope?.challengeId);
    if(!p || !matchesScope(scope,p.scope))return false;
    this.#pending.delete(scope.challengeId);
    return true;
  }
  finishLegacyBinding(token,proof){
    const now=this.#now();this.#prune(now);
    const p=this.#pending.get(proof?.challengeId);
    invariant(p,'AUTHORITY_REQUEST_UNKNOWN_OR_EXPIRED');
    invariant(p.admin && p.local,'AUTHORITY_APPROVAL_REQUIRED');
    // A wrong bearer must not consume another device's valid proof.
    // Recheck once more INSIDE the final write transaction; an independent
    // process may rotate or revoke after this preliminary authentication.
    const initial=this.#tx(false,db=>authenticate(db,token,this.#now()));
    invariant(sameGrant(initial,p.grant),'AUTHORITY_STALE_GRANT');
    const verified=this.#book.verify(proof);
    invariant(verified && verified.identityId===p.identity.identityId,'AUTHORITY_PROOF_INVALID');
    this.#pending.delete(p.challenge.challengeId); // One use, even if commit fails.
    return this.#tx(true,(db,rev)=>{
      const now=this.#now();
      invariant(now>=p.challenge.issuedAt && now<p.challenge.expiresAt,'AUTHORITY_REQUEST_UNKNOWN_OR_EXPIRED');
      const grant=authenticate(db,token,now);
      invariant(sameGrant(grant,p.grant),'AUTHORITY_STALE_GRANT');
      const prior=reviewBinding(db,grant.routeId,verified);
      if(prior)return {created:false,revision:rev,binding:prior,grant};
      const next=event(db,rev,'bind',grant);
      db.prepare('INSERT INTO identity_bindings VALUES (?,?,?,?)')
        .run(grant.routeId,verified.identityId,verified.publicKey,next);
      return {created:true,revision:next,
        binding:{routeId:grant.routeId,identity:verified,boundRevision:next},grant};
    });
  }
  close(){
    if(this.#db!==null){this.#db.close();this.#db=null;}
    this.#pending.clear();
    this.#book=null;
  }
}

function reserve(file){
  const fd=openSync(file,'wx',0o600);closeSync(fd);
}
export function initializeIdentityAuthority(filePath,{clock=Date.now}={}){
  invariant(typeof clock==='function','AUTHORITY_CLOCK_INVALID');
  const file=checkedPath(filePath);
  function alreadyExists(){const e=Error('AUTHORITY_ALREADY_EXISTS');e.code='EEXIST';throw e;}
  if(checkedFile(file,true))alreadyExists();
  try{checkSidecars(file,true);}
  catch(error){if(checkedFile(file,true))alreadyExists();throw error;}
  reserve(file);
  const id=randomBytes(32).toString('base64url');
  const db=connect(file);
  try{
    transaction(db,true,()=>{
      db.exec('PRAGMA application_id='+APP_ID+'; PRAGMA user_version='+VERSION+';');
      // FK dependencies require the grant table to be created first.
      for(const sql of [META,GRANTS,HISTORY,BINDINGS,EVENTS])db.exec(sql);
      db.prepare('INSERT INTO authority_meta VALUES (1,?,0)').run(id);
    });
  }finally{db.close();}
  syncDirectory(file);
  return openIdentityAuthority(file,id,{clock});
}
export function openIdentityAuthority(filePath,networkId,{clock=Date.now}={}){
  invariant(isNetworkId(networkId),'AUTHORITY_EXPECTED_NETWORK_REQUIRED');
  invariant(typeof clock==='function','AUTHORITY_CLOCK_INVALID');
  const file=checkedPath(filePath),fileIdentity=checkedFile(file);
  checkSidecars(file);
  const db=connect(file);
  try{
    transaction(db,false,()=>{
      schema(db);
      invariant(db.prepare('PRAGMA integrity_check(1)').get()?.integrity_check==='ok','AUTHORITY_INTEGRITY_FAILED');
      stateSnapshot(db,networkId);
    });
    const current=checkedFile(file);
    invariant(current.dev===fileIdentity.dev && current.ino===fileIdentity.ino,'AUTHORITY_FILE_REPLACED');
    return new IdentityAuthority(FACTORY,db,file,fileIdentity,networkId,clock);
  }catch(e){db.close();throw e;}
}
