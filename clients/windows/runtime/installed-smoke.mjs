// No public connection or real pairing credentials. Disposable Windows CI only.
import {mkdtemp,mkdir,realpath,rm,writeFile,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {collectCommandResult} from './command-poll.mjs';
import {startManagedBackend,BACKEND_URL} from './managed-backend.mjs';
import {DevSpaceLocalOAuth} from './core/src/devspace-local-auth.js';
if(process.platform!=='win32'||process.env.GITHUB_ACTIONS!=='true')throw Error('CI_ONLY');
const root=await mkdtemp(path.join(await realpath(os.tmpdir()),'codas-smoke-'));
const workspace=path.join(root,'workspace');
const outside=path.join(root,'outside');
await mkdir(workspace);await mkdir(outside);
const stateDir=path.join(root,'state');
await writeFile(path.join(workspace,'existing.txt'),'original fixture\n');
await writeFile(path.join(outside,'outside.txt'),'outside fixture\n');
let backend;
let next=0;
const authClient=backend=>new DevSpaceLocalOAuth({baseUrl:BACKEND_URL,ownerTokenPath:backend.authFile,fetchFn:(url,opts={})=>fetch(url,{...opts,signal:AbortSignal.timeout(30000)})});
async function rpc(client,method,params,{expectDenied=false}={}){
  const id=++next;
  const response=await client.authorizedFetch('/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id,method,params})});
  const body=await response.text();let value;
  if((response.headers.get('content-type')||'').includes('text/event-stream')){
    for(const line of body.split(/\r?\n/))if(line.startsWith('data:'))try{const v=JSON.parse(line.slice(5));if(v.id===id)value=v;}catch{}
  }else value=JSON.parse(body);
  assert.equal(value?.id,id,'Missing matching MCP response: '+method);
  if(expectDenied){
    assert.ok(value.error||value.result?.isError,'Unauthorized operation accepted');
    return;
  }
  assert.ok(response.ok&&!value.error&&!value.result?.isError,'MCP operation failed: '+(params?.name||method));
  return value.result;
}
const patchText=lines=>['*** Begin Patch',...lines,'*** End Patch',''].join('\n');
async function waitCommand(client,wid,cmd,{yieldTime=1000,requirePoll=false}={}){
  const initial=(await rpc(client,'tools/call',{name:'exec_command',arguments:{workspace_id:wid,cmd,yield_time_ms:yieldTime,max_output_tokens:512}})).structuredContent;
  const result=await collectCommandResult(initial,async sessionId=>
    (await rpc(client,'tools/call',{name:'write_stdin',arguments:{workspace_id:wid,session_id:sessionId,chars:'',yield_time_ms:1000,max_output_tokens:512}})).structuredContent,
    {requirePoll});
  return result.result;
}
async function stopAndVerify(){
  await backend.close();backend=null;
  let closed=false;
  for(let n=0;n<20;n++){
    try{await fetch(BACKEND_URL+'/healthz',{signal:AbortSignal.timeout(500),redirect:'error'});}
    catch{closed=true;break;}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.ok(closed,'Backend listener did not close');
}
try{
  backend=await startManagedBackend({stateDir,root:workspace});
  await backend.check();
  console.log('CHECK backend-ready');
  const client=authClient(backend);
  const unauth=await fetch(BACKEND_URL+'/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'}),signal:AbortSignal.timeout(3000)});
  assert.equal(unauth.status,401,'Unauthenticated request was not refused');
  const opened=await rpc(client,'tools/call',{name:'open_workspace',arguments:{path:workspace}});
  const wid=opened?.structuredContent?.workspace_id;
  assert.equal(typeof wid,'string');
  await rpc(client,'tools/call',{name:'open_workspace',arguments:{path:outside}},{expectDenied:true});
  await rpc(client,'tools/call',{name:'read',arguments:{workspace_id:wid,path:'../outside/outside.txt'}},{expectDenied:true});
  console.log('CHECK authenticated-workspace-and-denied-scope');
  const original=await rpc(client,'tools/call',{name:'read',arguments:{workspace_id:wid,path:'existing.txt'}});
  assert.match(original.structuredContent?.result||'',/original fixture/);
  const created=await rpc(client,'tools/call',{name:'apply_patch',arguments:{workspace_id:wid,patch:patchText(['*** Add File: smoke-script.cmd','+@echo off','+echo codas-script-ok'])}});
  assert.equal(created.structuredContent?.files?.length,1);
  const edited=await rpc(client,'tools/call',{name:'apply_patch',arguments:{workspace_id:wid,patch:patchText(['*** Update File: existing.txt','@@','-original fixture','+edited fixture'])}});
  assert.equal(edited.structuredContent?.files?.length,1);
  const read=await rpc(client,'tools/call',{name:'read',arguments:{workspace_id:wid,path:'existing.txt'}});
  assert.match(read.structuredContent?.result||'',/edited fixture/);
  assert.match(await readFile(path.join(workspace,'existing.txt'),'utf8'),/edited fixture/);
  console.log('CHECK read-create-edit-patch');
  const hostnameOutput=await waitCommand(client,wid,'hostname');
  assert.equal(hostnameOutput.split(/\r?\n/).find(s=>s.trim())?.trim().toLowerCase(),os.hostname().toLowerCase());
  assert.match(await waitCommand(client,wid,'smoke-script.cmd'),/codas-script-ok/);
  const powershell=path.join(process.env.SystemRoot||process.env.SYSTEMROOT,'System32','WindowsPowerShell','v1.0','powershell.exe');
  const output=await waitCommand(client,wid,`"${powershell}" -NoProfile -NonInteractive -Command "Write-Output 'codas-poll-start'; Start-Sleep -Milliseconds 1200; Write-Output 'codas-poll-ok'"`,{yieldTime:0,requirePoll:true});
  assert.match(output,/codas-poll-start[\s\S]*codas-poll-ok/);
  console.log('CHECK command-script-poll');
  await rpc(client,'tools/call',{name:'apply_patch',arguments:{workspace_id:wid,patch:patchText(['*** Delete File: smoke-script.cmd'])}});
  await assert.rejects(readFile(path.join(workspace,'smoke-script.cmd')),{code:'ENOENT'});
  await stopAndVerify();
  backend=await startManagedBackend({stateDir,root:workspace});
  const reopened=await rpc(authClient(backend),'tools/call',{name:'open_workspace',arguments:{path:workspace}});
  assert.equal(typeof reopened.structuredContent?.workspace_id,'string');
  await stopAndVerify();
  console.log(JSON.stringify({passed:true,localBackend:true,authenticatedMcp:true,unauthenticatedDenied:true,scopeDenied:true,existingFileRead:true,fileCreateEditDelete:true,scriptExecution:true,processPolling:true,stopRestart:true,remoteAcceptance:false}));
}finally{
  await backend?.close();
  await rm(root,{recursive:true,force:true});
}
