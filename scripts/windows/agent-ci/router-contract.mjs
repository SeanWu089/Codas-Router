// Disposable integration test: unmodified Router source + packaged Windows Agent + Lite DevSpace.
// All network endpoints and credentials are ephemeral loopback fixtures, never production.
import assert from 'node:assert/strict';
import {collectCommandResult} from './command-poll.mjs';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startManagedBackend, BACKEND_URL } from './managed-backend.mjs';
import { enrollAgent, runAgent } from './core/src/agent.js';
import { classifyJob, authorizeSessionTool } from './desktop-policy.mjs';
assert.equal(process.platform,'win32');
assert.equal(process.env.GITHUB_ACTIONS,'true','CI_ONLY');
const source=process.env.CODAS_ROUTER_TEST_SOURCE;
assert.ok(source&&path.isAbsolute(source),'Pinned Router checkout required');
const {createRouterRuntime}=await import(pathToFileURL(path.join(source,'src/runtime.js')).href);
const {createRouterServer}=await import(pathToFileURL(path.join(source,'src/server.js')).href);
const root=await mkdtemp(path.join(await realpath(os.tmpdir()),'codas-router-contract-'));
const workspace=path.join(root,'remote workspace'), localRoot=path.join(root,'local workspace');
await mkdir(workspace);await mkdir(localRoot);
await writeFile(path.join(workspace,'existing.txt'),'routed fixture\n');
const token=randomUUID(), deviceId='fixture-agent', oldDeviceId='fixture-old-router';
const oldAuth=process.env.CODASSOL_DEVSPACE_AUTH_FILE;
let backend,runtime,router,agent,stopped=false,agentFailure,readyResolve,next=0,localToolCalls=0;
let allowNext=true, confirmationCount=0;
const ready=new Promise(resolve=>{readyResolve=resolve;});
function bounded(promise,ms,label){
  let timer;
  return Promise.race([promise,new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(Error('TIMEOUT '+label)),ms);
  })]).finally(()=>clearTimeout(timer));
}
async function listen(server){server.listen(0,'127.0.0.1');await once(server,'listening');return server.address().port;}
function json(res,status,body){res.writeHead(status,{'content-type':'application/json'}).end(JSON.stringify(body));}
const localBackend=http.createServer(async(req,res)=>{
  if(req.headers.authorization!=='Bearer '+token)return json(res,401,{error:'UNAUTHORIZED'});
  let data='';
  for await(const chunk of req){data+=chunk;if(data.length>100_000)return json(res,413,{error:'TOO_LARGE'});}
  const msg=JSON.parse(data);
  if(msg.method==='ping')return json(res,200,{jsonrpc:'2.0',id:msg.id,result:{}});
  // The local backend must never receive remote workspace operations.
  localToolCalls++;
  return json(res,500,{error:'REMOTE_TOOL_ROUTED_TO_LOCAL_BACKEND'});
});
function decode(response,raw,id){
  if((response.headers.get('content-type')||'').includes('text/event-stream')){
    for(const line of raw.split(/\r?\n/)){
      if(!line.startsWith('data:'))continue;
      try{const x=JSON.parse(line.slice(5));if(x.id===id)return x;}catch{}
    }
    throw Error('No matching SSE response');
  }
  return JSON.parse(raw);
}
let base;
async function call(name,args,{approve=true,authenticated=true,expectedError=null}={}){
  const id=++next;
  allowNext=approve;
  const response=await fetch(base+'/mcp',{method:'POST',headers:{
    authorization:'Bearer '+(authenticated?token:'invalid-fixture-token'),
    'content-type':'application/json',accept:'application/json, text/event-stream',
    'mcp-protocol-version':'2025-03-26','mcp-method':'tools/call','mcp-name':name
  },body:JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args}}),
    signal:AbortSignal.timeout(35_000)});
  const msg=decode(response,await response.text(),id);
  if(expectedError){
    // Baseline documents the exact current Router error envelope.
    // An error-format fix must keep the code and denial behavior.
    if(expectedError==='unauthorized'){
      assert.equal(response.status,401);assert.equal(msg.error,expectedError);
    }else{
      assert.equal(response.status,502);assert.equal(msg.error,expectedError);
      assert.equal(msg.jsonrpc,undefined,'Baseline Router returns a non-MCP error envelope');
    }
    return msg;
  }
  assert.equal(response.status,200,'Router HTTP '+response.status+' '+String(msg.error||''));
  assert.equal(msg.id,id);assert.ok(!msg.error&&!msg.result?.isError,'MCP tool failed: '+name);
  return msg.result.structuredContent;
}
try{
  const localPort=await listen(localBackend);
  const cfg={listenHost:'127.0.0.1',listenPort:0,backendHost:'127.0.0.1',backendPort:localPort,
    backendTimeoutMs:2000,stateDir:path.join(root,'router state'),localDeviceId:'local',
    localDeviceLabel:'Fixture Router',localRoots:[localRoot]};
  runtime=await createRouterRuntime(cfg);
  router=createRouterServer(cfg,runtime);
  base='http://127.0.0.1:'+await listen(router);
  backend=await startManagedBackend({stateDir:path.join(root,'agent state'),root:workspace});
  process.env.CODASSOL_DEVSPACE_AUTH_FILE=backend.authFile;
  let config;
  const configStore={load:async()=>structuredClone(config),save:async value=>{config=structuredClone(value);return value;}};
  await enrollAgent({routerUrl:base,pairingToken:runtime.privateState.pairingToken,
    deviceId,label:'Fixture Windows',roots:[workspace],devspaceBaseUrl:BACKEND_URL,configStore});
  // Reproduce two identities claiming the same root; the older one is offline.
  runtime.devices.register({id:oldDeviceId,label:'Offline fixture',platform:'win32',
    presence:'static',enabled:false,roots:[workspace]});
  agent=runAgent({configStore,transport:'sse',stopSignal:()=>stopped,
    onSessionState:(value,coreDevice)=>{if(value==='connected')readyResolve(coreDevice);},
    authorizeJob:async job=>{
      const kind=classifyJob(job);
      if(kind.type==='protocol')return true;
      if(kind.type!=='confirm')return false;
      confirmationCount++;
      // Test operator only. Production approval logic and scope are untouched.
      return authorizeSessionTool({mode:'session-v1',kind,job,
        getState:()=>({enabled:!stopped&&allowNext,connected:!stopped}),
        verifyBackend:()=>backend.check()});
    }
  }).catch(error=>{agentFailure=error;});
  const coreDevice=await bounded(ready,10_000,'Agent authenticated SSE ready');
  assert.equal(coreDevice?.version,1);
  assert.equal(coreDevice?.name,'Fixture Router');
  assert.equal(coreDevice?.platform,process.platform);
  assert.ok(['desktop','laptop','phone','tablet','unknown'].includes(coreDevice?.formFactor));
  console.log('CHECK authenticated Core display metadata');
  const listing=await call('codassol_list_devices',{});
  assert.ok(listing.devices.some(x=>x.id===deviceId&&x.status==='online'));
  await call('open_workspace',{path:workspace},{expectedError:'AMBIGUOUS_DEVICE'});
  await call('open_workspace',{path:workspace,device_id:oldDeviceId},{expectedError:'DEVICE_OFFLINE'});
  const opened=await call('open_workspace',{path:workspace.replaceAll('\\','/'),mode:'checkout',device_id:deviceId});
  const wid=opened.workspace_id;assert.equal(typeof wid,'string');
  assert.equal(runtime.bindings.get(wid).deviceId,deviceId);
  assert.match((await call('read',{workspace_id:wid,path:'existing.txt'})).result,/routed fixture/);
  await call('read',{workspace_id:'fixture-unknown-workspace',path:'existing.txt'},{expectedError:'WORKSPACE_NOT_BOUND'});
  const before=confirmationCount;
  await call('exec_command',{workspace_id:wid,cmd:'hostname'},{authenticated:false,expectedError:'unauthorized'});
  assert.equal(confirmationCount,before,'Unauthorized request must not reach Agent');
  const rejected=['*** Begin Patch','*** Add File: rejected.txt','+do not create','*** End Patch',''].join('\n');
  await call('apply_patch',{workspace_id:wid,patch:rejected},{approve:false,expectedError:'LOCAL_APPROVAL_REQUIRED'});
  await assert.rejects(readFile(path.join(workspace,'rejected.txt')),{code:'ENOENT'});
  const initial=await call('exec_command',{workspace_id:wid,cmd:'hostname',yield_time_ms:1000,max_output_tokens:512});
  const command=await collectCommandResult(initial,sessionId=>call('write_stdin',{
    workspace_id:wid,session_id:sessionId,chars:'',yield_time_ms:1000,max_output_tokens:512}));
  assert.equal(command.result.split(/\r?\n/).find(s=>s.trim())?.trim().toLowerCase(),os.hostname().toLowerCase());
  assert.equal(localToolCalls,0,'Remote tool unexpectedly reached the local backend');
  assert.ok(!agentFailure,'Agent stopped unexpectedly');
  console.log(JSON.stringify({passed:true,realRouterSource:true,realAgent:true,realLiteBackend:true,explicitDevice:true,duplicateRootRejected:true,workspaceBinding:true,command:true,outerAuthorization:true,approvalDenial:true,sessionAuthorizationPolicy:true,nonMcpErrorEnvelopeConfirmed:true,productionCloudflare:false,realOperator:false}));
}finally{
  stopped=true;
  runtime?.agentHub.closeStreams();
  router?.closeAllConnections();
  localBackend.closeAllConnections();
  await backend?.close();
  if(agent)await bounded(agent,5000,'Agent shutdown');
  if(router?.listening)await new Promise(resolve=>router.close(resolve));
  if(localBackend.listening)await new Promise(resolve=>localBackend.close(resolve));
  if(oldAuth===undefined)delete process.env.CODASSOL_DEVSPACE_AUTH_FILE;
  else process.env.CODASSOL_DEVSPACE_AUTH_FILE=oldAuth;
  await rm(root,{recursive:true,force:true});
}
