import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';

test('Node environment proxy carries HTTPS; local backend stays direct', async()=>{
  let connects=0, localRequests=0, proxiedHttp=0;
  const proxy=http.createServer((req,res)=>{proxiedHttp++;res.writeHead(502);res.end('proxy');});
  proxy.on('connect',(_req,socket)=>{connects++;socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');});
  const local=http.createServer((_req,res)=>{localRequests++;res.end('local');});
  await Promise.all([new Promise(r=>proxy.listen(0,'127.0.0.1',r)),new Promise(r=>local.listen(0,'127.0.0.1',r))]);
  try {
    const address=`http://127.0.0.1:${proxy.address().port}`;
    const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!['http_proxy','https_proxy','no_proxy','node_options','node_use_env_proxy'].includes(k.toLowerCase())));
    Object.assign(env,{HTTP_PROXY:address,HTTPS_PROXY:address,NO_PROXY:'localhost,127.0.0.1,::1'});
    const source=`try {await fetch('https://fixture.invalid',{signal:AbortSignal.timeout(3000)});process.exitCode=2;} catch {} const r=await fetch('http://127.0.0.1:${local.address().port}',{signal:AbortSignal.timeout(3000)});if(await r.text()!=='local')process.exitCode=3;`;
    const child=spawn(process.execPath,['--use-env-proxy','--input-type=module','-e',source],{env,stdio:'ignore'});
    const code=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{child.kill();reject(Error('proxy test timed out'));},10000);
      child.once('error',e=>{clearTimeout(timer);reject(e);});
      child.once('exit',c=>{clearTimeout(timer);resolve(c);});
    });
    assert.equal(code,0);assert.equal(connects,1);assert.equal(localRequests,1);assert.equal(proxiedHttp,0);
  } finally {proxy.closeAllConnections();local.closeAllConnections();proxy.close();local.close();}
});
