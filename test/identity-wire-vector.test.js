import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPublicKey, verify } from 'node:crypto';
import { normalizeDeviceIdentity } from '../src/device-identity.js';
test('shared native P-256 public fixture matches the normative V1 transcript and verifies',()=>{
  const v=Object.fromEntries(readFileSync(new URL('../identity/vectors/p256-v1.properties',import.meta.url),'utf8')
    .trim().split(/\r?\n/).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1)]));
  const identity=normalizeDeviceIdentity({version:1,algorithm:'P-256',identityId:v.identityId,publicKey:v.publicKey});
  const bytes=Buffer.from(JSON.stringify(['codas/device-identity-proof/v1',v.networkId,v.identityId,v.challengeId,v.nonce,Number(v.issuedAt),Number(v.expiresAt)]));
  assert.equal(bytes.toString('base64url'),v.transcript);
  const key=createPublicKey({key:Buffer.from(identity.publicKey,'base64url'),format:'der',type:'spki'});
  const signature=Buffer.from(v.signature,'base64url');
  assert.ok(verify('sha256',bytes,key,signature));
  assert.equal(verify('sha256',Buffer.concat([bytes,Buffer.from([0])]),key,signature),false);
  assert.equal(Number(v.expiresAt)-Number(v.issuedAt),60000);
  assert.equal(Object.keys(v).some(k=>/private/i.test(k)),false);
});
