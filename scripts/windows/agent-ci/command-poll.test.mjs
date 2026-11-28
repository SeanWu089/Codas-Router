import assert from 'node:assert/strict';
import test from 'node:test';
import {collectCommandResult} from './command-poll.mjs';

function running(output='', id=7) {
  const status=`Process running with session ID ${id}.`;
  return {running:true,session_id:id,output_truncated:false,result:output ? output+'\n'+status : status};
}
function exited(output='', code=0) {
  const status=`Process exited with code ${code}.`;
  return {running:false,exit_code:code,output_truncated:false,result:output ? output+'\n'+status : status};
}
function replay(results) {
  let i=0;
  return async id=>{assert.equal(id,7);assert.ok(i<results.length,'Unexpected poll');return results[i++];};
}
test('RC6 regression: earlier stdout followed by status-only successful exit', async()=>{
  const r=await collectCommandResult(running(),replay([running('codas-poll-ok'),exited()]),{requirePoll:true});
  assert.equal(r.result,'codas-poll-ok');
  assert.equal(r.exit_code,0);
});
test('initial stdout and a marker split across polls are retained in order',async()=>{
  const r=await collectCommandResult(running('codas-'),replay([running('poll-'),exited('ok')]),{requirePoll:true});
  assert.equal(r.result,'codas-poll-ok');
});
test('immediate success retains output without polling',async()=>{
  assert.equal((await collectCommandResult(exited('hostname'),replay([]))).result,'hostname');
});
test('successful status alone cannot satisfy an output marker assertion',async()=>{
  const r=await collectCommandResult(running(),replay([exited()]),{requirePoll:true});
  assert.equal(r.result,'');
  assert.throws(()=>assert.match(r.result,/codas-poll-ok/));
});
test('earlier matching stdout does not excuse nonzero exit',async()=>{
  await assert.rejects(collectCommandResult(running('codas-poll-ok'),replay([exited('',2)])),/Command exited unsuccessfully/);
});
test('polling required for long commands',async()=>{
  await assert.rejects(collectCommandResult(exited('codas-poll-ok'),replay([]),{requirePoll:true}),/Process polling was not exercised/);
});
test('missing output, truncation and inconsistent sessions are rejected',async()=>{
  await assert.rejects(collectCommandResult({...running(),output_truncated:true},replay([])),/truncated/);
  await assert.rejects(collectCommandResult({...running(),result:undefined},replay([])),/Missing process output/);
  await assert.rejects(collectCommandResult(running(),replay([running('',8)])),/session changed/);
});
test('unfinished and signal-terminated commands fail closed',async()=>{
  let polls=0;
  await assert.rejects(collectCommandResult(running(),async()=>{polls++;return running();}),/Command still running/);
  assert.equal(polls,12);
  await assert.rejects(collectCommandResult(running(),replay([{running:false,signal:'SIGTERM',output_truncated:false,result:'Process exited after signal SIGTERM.'}])),/terminated by signal/);
});
