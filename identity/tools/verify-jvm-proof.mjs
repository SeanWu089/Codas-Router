// JVM output contains only public fixture values and one signature.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPublicKey, verify } from 'node:crypto';
import { normalizeDeviceIdentity } from '../../src/device-identity.js';
const fields=file=>Object.fromEntries(readFileSync(file,'utf8').trim().split(/\r?\n/).filter(l=>l.includes('=')).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1)]));
const v=fields(process.argv[2]),j=fields(process.argv[3]);
const d=normalizeDeviceIdentity({version:1,algorithm:'P-256',identityId:j.IDENTITY,publicKey:j.PUBLIC});
const issued=Number(j.ISSUED),expires=Number(j.EXPIRES);
assert.ok(Number.isSafeInteger(issued)&&Number.isSafeInteger(expires)&&expires-issued===60000);
const bytes=Buffer.from(JSON.stringify(['codas/device-identity-proof/v1',v.networkId,d.identityId,v.challengeId,v.nonce,issued,expires]));
const key=createPublicKey({key:Buffer.from(d.publicKey,'base64url'),format:'der',type:'spki'});
const sig=Buffer.from(j.SIGNATURE,'base64url');
assert.ok(verify('sha256',bytes,key,sig));
assert.equal(verify('sha256',Buffer.concat([bytes,Buffer.from([0])]),key,sig),false);
console.log('JVM_SIGNATURE_NODE_VERIFIED');
