// Disposable Windows CI only. No production endpoint, credentials or devices.
// Exercise the packaged Agent SSE client, approval boundary, OAuth and actual Lite MCP backend.
import assert from 'node:assert/strict';
import {collectCommandResult} from './command-poll.mjs';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startManagedBackend, BACKEND_URL } from './managed-backend.mjs';
import { runAgent } from './core/src/agent.js';
import { classifyJob, authorizeSessionTool } from './desktop-policy.mjs';

assert.equal(process.platform,'win32');
assert.equal(process.env.GITHUB_ACTIONS,'true','CI_ONLY');
const root = await mkdtemp(path.join(await realpath(os.tmpdir()),'codas-agent-contract-'));
const workspace = path.join(root,'workspace');
await mkdir(workspace);
await writeFile(path.join(workspace,'existing.txt'),'remote fixture\n');
const token = randomUUID(), deviceId = 'fixture-windows', streamId = randomUUID();
const pending = new Map(), decisions = new Map(), classified = new Map();
const oldAuth = process.env.CODASSOL_DEVSPACE_AUTH_FILE;
let backend, stream, agent, stopped = false, next = 0, agentFailure;
let readyResolve;
const ready = new Promise(resolve=>{readyResolve=resolve;});
function bounded(promise,ms,label){
  let timer;
  return Promise.race([promise,new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(Error('TIMEOUT '+label)),ms);
  })]).finally(()=>clearTimeout(timer));
}
const json=(res,status,body)=>res.writeHead(status,{'content-type':'application/json'}).end(JSON.stringify(body));
const server = http.createServer(async(req,res)=>{
  try {
    if(req.headers.authorization!=='Bearer '+token) return json(res,401,{error:'UNAUTHORIZED'});
    if(req.method==='GET' && req.url==='/_codassol/agent/events'){
      stream=res;
      res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
      res.write('event: ready\ndata: '+JSON.stringify({deviceId,streamId,protocol:1})+'\n\n');
      readyResolve();
      return;
    }
    if(req.method==='POST' && req.url==='/_codassol/agent/heartbeat') return json(res,200,{ok:true});
    if(req.method==='POST' && req.url==='/_codassol/agent/result'){
      let body='';
      for await(const chunk of req){
        body+=chunk.toString('utf8');
        if(body.length>1_000_000) throw Error('FIXTURE_RESULT_TOO_LARGE');
      }
      const result=JSON.parse(body);
      const entry=pending.get(result.jobId);
      if(!entry) return json(res,409,{error:'UNKNOWN_FIXTURE_JOB'});
      json(res,200,{ok:true});
      entry.resolve(result);
      return;
    }
    return json(res,404,{error:'UNKNOWN_FIXTURE_ENDPOINT'});
  }catch{if(!res.headersSent)json(res,500,{error:'FIXTURE_ERROR'});else res.destroy();}
});
async function submit(method,params,{approve=true}={}){
  assert.ok(stream&&!stream.destroyed,'Fixture SSE is not ready');
  const id=++next, jobId=randomUUID();
  const body={jsonrpc:'2.0',id,method,params};
  const request={path:'/mcp',method:'POST',headers:{
    'content-type':'application/json',accept:'application/json, text/event-stream',
    'mcp-method':method,...(params?.name?{'mcp-name':params.name}:{})
  },bodyBase64:Buffer.from(JSON.stringify(body)).toString('base64')};
  const result=new Promise(resolve=>pending.set(jobId,{resolve}));
  decisions.set(jobId,approve);
  stream.write('event: job\ndata: '+JSON.stringify({job:{id:jobId,expiresAt:Date.now()+45_000,payload:{type:'devspace-http',request}}})+'\n\n');
  try{
    const response=await bounded(result,40_000,params?.name||method);
    assert.equal(classified.get(jobId),method==='tools/call'?'confirm':'protocol');
    if(!approve){
      assert.equal(response.ok,false);
      assert.equal(response.error?.code,'LOCAL_APPROVAL_REQUIRED');
      return null;
    }
    assert.equal(response.ok,true,response.error?.code||'Agent forwarding failed');
    const {statusCode,headers,bodyBase64}=response.result;
    assert.ok(statusCode>=200&&statusCode<300,'Backend HTTP '+statusCode);
    const raw=Buffer.from(bodyBase64,'base64').toString('utf8');
    let message;
    if((headers['content-type']||'').includes('text/event-stream')){
      for(const line of raw.split(/\r?\n/)){
        if(!line.startsWith('data:'))continue;
        try{const value=JSON.parse(line.slice(5));if(value.id===id)message=value;}catch{}
      }
    }else message=JSON.parse(raw);
    assert.equal(message?.id,id,'MCP response correlation failed');
    assert.ok(!message.error&&!message.result?.isError,'MCP tool failed: '+(params?.name||method));
    return message.result;
  }finally{pending.delete(jobId);decisions.delete(jobId);classified.delete(jobId);}
}
const tool=(name,args,options)=>submit('tools/call',{name,arguments:args},options);
const patch=lines=>['*** Begin Patch',...lines,'*** End Patch',''].join('\n');
try{
  backend=await startManagedBackend({stateDir:path.join(root,'state'),root:workspace});
  process.env.CODASSOL_DEVSPACE_AUTH_FILE=backend.authFile;
  server.listen(0,'127.0.0.1');await once(server,'listening');
  let config={routerUrl:'http://127.0.0.1:'+server.address().port,agentToken:token,
    device:{id:deviceId,roots:[workspace],capabilities:['devspace-http']},
    devspace:{baseUrl:BACKEND_URL,oauth:{}}};
  const configStore={load:async()=>structuredClone(config),save:async value=>{config=structuredClone(value);return value;}};
  agent=runAgent({configStore,transport:'sse',stopSignal:()=>stopped,
    // This substitutes a local operator ONLY in the disposable fixture.
    // Real application approval policy and public-origin pinning are not changed.
    authorizeJob:async job=>{
      const kind=classifyJob(job);
      classified.set(job.id,kind.type);
      if(kind.type==='protocol')return true;
      return authorizeSessionTool({mode:'session-v1',kind,job,
        getState:()=>({enabled:!stopped&&decisions.get(job.id)===true,connected:!stopped}),
        verifyBackend:()=>backend.check()});
    }
  }).catch(error=>{agentFailure=error;});
  await bounded(ready,10_000,'authenticated SSE ready');
  const list=await submit('tools/list',{});
  const names=new Set(list.tools?.map(x=>x.name));
  for(const name of ['open_workspace','read','apply_patch','exec_command','write_stdin','show_changes']){
    assert.ok(names.has(name),'Packaged MCP missing '+name);
  }
  const opened=await tool('open_workspace',{path:workspace,mode:'checkout'});
  const wid=opened.structuredContent?.workspace_id;
  assert.equal(typeof wid,'string');
  assert.equal(path.normalize(opened.structuredContent.root).toLowerCase(),path.normalize(workspace).toLowerCase());
  assert.match((await tool('read',{workspace_id:wid,path:'existing.txt'})).structuredContent.result,/remote fixture/);
  // Rejection must propagate without executing the requested mutation.
  await tool('apply_patch',{workspace_id:wid,patch:patch(['*** Add File: rejected.txt','+must not exist'])},{approve:false});
  await assert.rejects(readFile(path.join(workspace,'rejected.txt')),{code:'ENOENT'});
  await tool('apply_patch',{workspace_id:wid,patch:patch(['*** Add File: remote-script.cmd','+@echo off','+echo remote-script-ok'])});
  const result=async(cmd,yield_time_ms=1000)=>(await tool('exec_command',{workspace_id:wid,cmd,yield_time_ms,max_output_tokens:512})).structuredContent;
  const poll=async (initial,options={})=>collectCommandResult(initial,async sessionId=>
    (await tool('write_stdin',{workspace_id:wid,session_id:sessionId,chars:'',yield_time_ms:1000,max_output_tokens:512})).structuredContent,
    options);
  const finish=async r=>poll(r);
  const hostname=await finish(await result('hostname'));
  assert.equal(hostname.exit_code,0);
  assert.equal(hostname.result.split(/\r?\n/).find(s=>s.trim())?.trim().toLowerCase(),os.hostname().toLowerCase());
  const script=await finish(await result('remote-script.cmd'));
  assert.equal(script.exit_code,0);assert.match(script.result,/remote-script-ok/);
  const ps=path.join(process.env.SystemRoot||process.env.SYSTEMROOT,'System32','WindowsPowerShell','v1.0','powershell.exe');
  const long=await result('"'+ps+'" -NoProfile -NonInteractive -Command "Write-Output remote-poll-start; Start-Sleep -Milliseconds 1500; Write-Output remote-poll-ok"',0);
  assert.equal(long.running,true,'Process polling must be exercised');
  assert.match((await poll(long,{requirePoll:true})).result,/remote-poll-start[\s\S]*remote-poll-ok/);
  await tool('apply_patch',{workspace_id:wid,patch:patch(['*** Delete File: remote-script.cmd'])});
  await assert.rejects(readFile(path.join(workspace,'remote-script.cmd')),{code:'ENOENT'});
  assert.ok(!agentFailure,'Agent stopped unexpectedly');
  console.log(JSON.stringify({passed:true,fixtureSse:true,realAgent:true,realLiteBackend:true,approvalDenial:true,sessionAuthorizationPolicy:true,workspaceReuse:true,command:true,script:true,processPolling:true,reviewToolListed:true,realRouter:false,publicPairing:false,realOperator:false}));
}finally{
  stopped=true;
  stream?.end();
  server.closeAllConnections();
  await backend?.close();
  if(agent)await bounded(agent,5000,'fixture Agent shutdown');
  if(server.listening)await new Promise(resolve=>server.close(resolve));
  if(oldAuth===undefined)delete process.env.CODASSOL_DEVSPACE_AUTH_FILE;
  else process.env.CODASSOL_DEVSPACE_AUTH_FILE=oldAuth;
  await rm(root,{recursive:true,force:true});
}
