import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateOrigin, pinnedConfigStore, probeCoordinator, classifyJob, canApprove, authorizeSessionTool } from '../desktop-policy.mjs';
function fixture(body, path='/mcp') {
  return {payload:{type:'devspace-http',request:{path,method:'POST',
    bodyBase64:Buffer.from(JSON.stringify(body)).toString('base64')}}};
}
const ORIGIN='https://core.example.test';
test('user-selected HTTPS DNS origin is canonical and rejects unsafe syntax',()=>{
  for(const v of [ORIGIN, ORIGIN+'/', ORIGIN+':443/', 'HTTPS://CORE.EXAMPLE.TEST'])
    assert.equal(validateOrigin(v),ORIGIN);
  assert.equal(validateOrigin('https://another.example.test'),'https://another.example.test');
  for(const v of ['',null,'http://core.example.test',ORIGIN+'/path',
    'https://user@core.example.test','https://user:pass@core.example.test',
    ORIGIN+':8443',ORIGIN+'?token=secret',ORIGIN+'#fragment',
    'https://127.0.0.1','https://[::1]','https://localhost',
    'https://core..example.test','https://-core.example.test',
    'https://core.example.test.','https://core.example.test\\evil',
    'https://core%2eexample.test','https://core.example.test\n/injected',
    "https://core.example.test'"]) assert.throws(()=>validateOrigin(v),/HTTPS_ORIGIN_REQUIRED/);
});
test('saved pairing can never cross a locally selected origin',async()=>{
  let writes=0, current={routerUrl:'https://other.example.test',agentToken:'fixture-only'};
  const raw={load:async()=>current,save:async(v)=>{writes++;return v;}};
  const store=pinnedConfigStore(raw,ORIGIN);
  await assert.rejects(()=>store.load(),/PAIRING_PROFILE_MISMATCH/);
  await assert.rejects(()=>store.save(current),/PAIRING_PROFILE_MISMATCH/);
  assert.equal(writes,0);
  current={...current,routerUrl:'http://other.example.test'};
  await assert.rejects(()=>store.load(),/LEGACY_INGRESS_RETIRED/);
  current={...current,routerUrl:ORIGIN+'/'};
  const canonical={...current,routerUrl:ORIGIN};
  assert.deepEqual(await store.load(),canonical);
  assert.deepEqual(await store.save(current),canonical);
  assert.equal(writes,1);
  current={...current,routerUrl:'https://other.example.test'};
  await assert.rejects(()=>store.load(),/PAIRING_PROFILE_MISMATCH/);
});
test('health probes use only selected origin, without credentials or redirects',async()=>{
  const fixture=async(url,options)=>{
    assert.equal(url,ORIGIN+'/_codassol/health');
    assert.equal(options.redirect,'error');assert.equal(options.headers,undefined);
    return new Response('{"ok":true}');
  };
  assert.equal(await probeCoordinator(ORIGIN,fixture),'reachable');
  assert.equal(await probeCoordinator(ORIGIN,async()=>new Response('{}',{status:403})),'rejected');
  assert.equal(await probeCoordinator(ORIGIN,async()=>new Response('{}',{status:502})),'http_error');
  assert.equal(await probeCoordinator(ORIGIN,async()=>new Response('{}')),'invalid_response');
  assert.equal(await probeCoordinator(ORIGIN,async()=>{throw Error('offline');}),'unreachable');
  await assert.rejects(()=>probeCoordinator('http://core.example.test',()=>assert.fail('unexpected network')),/HTTPS_ORIGIN_REQUIRED/);
});
test('protocol metadata is not a tool invocation',()=>{
  assert.deepEqual(classifyJob(fixture({jsonrpc:'2.0',method:'tools/list'})),{type:'protocol'});
});
test('tool calls require local confirmation',()=>{
  const result=classifyJob(fixture({jsonrpc:'2.0',method:'tools/call',params:{name:'open_workspace',arguments:{path:'example'}}}));
  assert.equal(result.type,'confirm');
  assert.equal(result.name,'open_workspace');
});
test('blocks arbitrary URLs, unknown methods and batches',()=>{
  const b={jsonrpc:'2.0',method:'tools/call',params:{name:'example'}};
  assert.equal(classifyJob(fixture(b,'https://example.com/mcp')).type,'deny');
  assert.equal(classifyJob(fixture({jsonrpc:'2.0',method:'resources/read'})).type,'deny');
  assert.equal(classifyJob(fixture([b,b])).type,'deny');
});
test('no approval while disconnected, stopped or expired',()=>{
  assert.equal(canApprove({enabled:true,connected:true,expiresAt:100,now:99}),true);
  assert.equal(canApprove({enabled:false,connected:true}),false);
  assert.equal(canApprove({enabled:true,connected:false}),false);
  assert.equal(canApprove({enabled:true,connected:true,expiresAt:100,now:100}),false);
});

test('explicit local session grant authorizes only existing tools',async()=>{
  const job={expiresAt:Date.now()+30_000};
  const state={enabled:true,connected:true};
  let checks=0;
  const invoke=(kind,mode='session-v1',candidate=job,verify=async()=>{checks++;})=>
    authorizeSessionTool({mode,kind,job:candidate,getState:()=>({...state}),verifyBackend:verify});
  for(const name of ['open_workspace','read','apply_patch','exec_command','write_stdin','show_changes'])
    assert.equal(await invoke({type:'confirm',name}),true);
  assert.equal(checks,6);
  assert.equal(await invoke({type:'confirm',name:'other_tool'}),false);
  assert.equal(await invoke({type:'deny',name:'exec_command'}),false);
  assert.equal(await invoke({type:'confirm',name:'exec_command'},'per-task'),false);
  assert.equal(await invoke({type:'confirm',name:'exec_command'},'session-v1',{}),false);
  assert.equal(await invoke({type:'confirm',name:'exec_command'},'session-v1',{expiresAt:Date.now()-1}),false);
  state.connected=false;
  assert.equal(await invoke({type:'confirm',name:'exec_command'}),false);
  state.connected=true;state.enabled=false;
  assert.equal(await invoke({type:'confirm',name:'exec_command'}),false);
  state.enabled=true;
  assert.equal(await invoke({type:'confirm',name:'exec_command'},'session-v1',job,async()=>{state.enabled=false;}),false);
  state.enabled=true;
  assert.equal(await invoke({type:'confirm',name:'exec_command'},'session-v1',job,async()=>{throw Error('scope mismatch');}),false);
});
