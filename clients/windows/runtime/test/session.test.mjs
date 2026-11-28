import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runAgent} from '../core/src/agent.js';

test('denied job never reaches the backend; verified ready and stop are reported', async()=>{
  const original = globalThis.fetch;
  const states = [], requests = [];
  let stop = false, decisions=0;
  const config = {
    routerUrl:'https://example.com',agentToken:'test-fixture-only',
    device:{id:'fixture-device',roots:[],capabilities:[]},
    devspace:{baseUrl:'http://127.0.0.1:7676',oauth:{}}
  };
  globalThis.fetch = async (url,options={})=>{
    const address=String(url);
    requests.push(address);
    if(address.endsWith('/_codassol/agent/events')){
      const ready={deviceId:'fixture-device',protocol:1,streamId:'fixture-stream'};
      const job={id:'fixture-job',payload:{type:'devspace-http',request:{path:'/mcp'}}};
      return new Response('event: ready\ndata: '+JSON.stringify(ready)+'\n\nevent: job\ndata: '+JSON.stringify({job})+'\n\n',{headers:{'content-type':'text/event-stream'}});
    }
    if(address.endsWith('/_codassol/agent/result')){
      assert.equal(JSON.parse(options.body).ok,false);
      assert.equal(JSON.parse(options.body).error.code,'LOCAL_APPROVAL_REQUIRED');
      stop=true;
      return new Response('{}');
    }
    throw Error('Unexpected network request');
  };
  try {
    await runAgent({configStore:{load:async()=>config,save:async()=>{}},
      stopSignal:()=>stop,transport:'sse',sleepFn:async()=>{},
      onSessionState:s=>states.push(s),authorizeJob:async()=>{decisions++;return false;}});
    assert.deepEqual(states,['connecting','connected','stopped']);
    assert.equal(decisions,1);
    assert.equal(requests.length,2);
    assert.equal(requests.some(x=>x.includes('127.0.0.1')),false);
  } finally {globalThis.fetch=original;}
});

test('verified ready forwards only optional display metadata, preserving legacy ready', async()=>{
  const original=globalThis.fetch;
  const mac={version:1,name:'Fixture Mac',platform:'darwin',formFactor:'laptop'};
  const pc={version:1,name:'Fixture PC',platform:'win32',formFactor:'desktop'};
  const cases=[
    [{...mac,extra:'ignored'},mac],[undefined,null],
    [{...mac,version:9},null],[{...mac,name:'\ninvalid'},null],
    [{...mac,platform:'invalid'},null],[pc,pc]
  ];
  try {
    for(const [info,expected] of cases){
      const config={routerUrl:'https://example.com',agentToken:'fixture',
        device:{id:'fixture-device',roots:[],capabilities:[]},
        devspace:{baseUrl:'http://127.0.0.1:7676',oauth:{}}};
      let stop=false,requests=0;const seen=[];
      globalThis.fetch=async url=>{
        assert.ok(String(url).endsWith('/_codassol/agent/events'));
        requests++;
        const ready={deviceId:'fixture-device',protocol:1,streamId:'fixture-stream',coreDevice:info};
        return new Response('event: ready\ndata: '+JSON.stringify(ready)+'\n\n',{headers:{'content-type':'text/event-stream'}});
      };
      await runAgent({configStore:{load:async()=>config},stopSignal:()=>stop,transport:'sse',
        sleepFn:async()=>{},onSessionState:(state,metadata)=>{
          seen.push([state,metadata]);if(state==='connected')stop=true;
        }});
      assert.deepEqual(seen,[['connecting',null],['connected',expected],['stopped',null]]);
      assert.equal(requests,1);
    }
  }finally{globalThis.fetch=original;}
});

test('reconnect clears display metadata; mismatched ready cannot replace Core',async()=>{
  const original=globalThis.fetch;
  const mac={version:1,name:'Fixture Mac',platform:'darwin',formFactor:'laptop'};
  const pc={version:1,name:'Fixture PC',platform:'win32',formFactor:'desktop'};
  const config={routerUrl:'https://example.com',agentToken:'fixture',
    device:{id:'fixture-device',roots:[],capabilities:[]},
    devspace:{baseUrl:'http://127.0.0.1:7676',oauth:{}}};
  let stop=false,requests=0,connections=0;const seen=[];
  try{
    globalThis.fetch=async url=>{
      assert.ok(String(url).endsWith('/_codassol/agent/events'));requests++;
      const ready={deviceId:requests===2?'wrong-device':'fixture-device',protocol:1,
        streamId:'fixture-'+requests,coreDevice:requests===1?mac:pc};
      return new Response('event: ready\ndata: '+JSON.stringify(ready)+'\n\n',{headers:{'content-type':'text/event-stream'}});
    };
    await runAgent({configStore:{load:async()=>config},stopSignal:()=>stop,transport:'sse',
      sleepFn:async()=>{},onSessionState:(state,info)=>{
        seen.push([state,info]);if(state==='connected'&&++connections===2)stop=true;
      }});
    assert.equal(requests,3);
    assert.deepEqual(seen.filter(([s])=>s==='connected'),[['connected',mac],['connected',pc]]);
    assert.ok(seen.some(([s])=>s==='reconnecting'));
    assert.ok(seen.filter(([s])=>s!=='connected').every(([,v])=>v===null));
  }finally{globalThis.fetch=original;}
});
