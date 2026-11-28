import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm, realpath} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {prepareBackendState, BACKEND_PORT} from '../managed-backend.mjs';
test('fresh backend config isolates its own identity and allowed root',async()=>{
 const base=await mkdtemp(path.join(await realpath(os.tmpdir()),'codas-rc3-'));
 try{
  const root=path.join(base,'workspace'), other=path.join(base,'other');
  await mkdir(root); await mkdir(other);
  const stateDir=path.join(base,'state');
  const backend=await prepareBackendState(stateDir,root);
  const auth=await readFile(backend.authFile,'utf8');
  const cfg=JSON.parse(await readFile(path.join(backend.dir,'config.jsonc'),'utf8'));
  assert.equal(cfg.server.host,'127.0.0.1');assert.equal(cfg.server.port,BACKEND_PORT);
  assert.deepEqual(cfg.workspaces.allowedRoots,[root]);
  assert.equal(cfg.subagents.enabled,false);
  await prepareBackendState(stateDir,root);
  assert.equal(await readFile(backend.authFile,'utf8'),auth);
  await assert.rejects(prepareBackendState(stateDir,other),/BACKEND_SCOPE_MISMATCH/);
  cfg.workspaces.allowedRoots.push(other);
  await writeFile(path.join(backend.dir,'config.jsonc'),JSON.stringify(cfg));
  await assert.rejects(backend.verify(),/BACKEND_SCOPE_MISMATCH/);
 }finally{await rm(base,{recursive:true,force:true});}
});
