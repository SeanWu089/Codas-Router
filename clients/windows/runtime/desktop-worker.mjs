import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, realpath, stat, rename } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startManagedBackend, BACKEND_URL } from './managed-backend.mjs';
import { AgentConfigStore } from './core/src/agent-config.js';
import { enrollAgent, runAgent } from './core/src/agent.js';
import { validateOrigin, pinnedConfigStore, probeCoordinator, classifyJob, canApprove, authorizeSessionTool } from './desktop-policy.mjs';

const send = (value) => { if (!process.stdout.destroyed) process.stdout.write(JSON.stringify(value)+'\n'); };
const stateDir = path.join(process.env.LOCALAPPDATA || os.homedir(), 'CodasWindowsAgent', 'state-v3');
let store = null, sessionOrigin = null;
const profilePath = path.join(stateDir, 'profile.json');
let active = false, stopping = false, connected = false, pending = null, backend = null;
let publicProbe = null, lastProbeAt = 0, publicEpoch = 0;
const equalPath = (a,b) => a.toLowerCase() === b.toLowerCase();
const fail = (code) => { throw Error(code); };
const diagnostic = (layer,value) => send({type:'diagnostic',layer,value});
async function probePublic(force=false) {
  if(!sessionOrigin || stopping || connected || publicProbe || (!force && Date.now()-lastProbeAt<15000)) return;
  const epoch=++publicEpoch;
  lastProbeAt=Date.now();diagnostic('public','checking');
  publicProbe=probeCoordinator(sessionOrigin);
  try { const result=await publicProbe;
    if(!stopping && !connected && epoch===publicEpoch) diagnostic('public',result);
  } finally {publicProbe=null;}
}
const state = (value, coreDevice = null) => {
  const wasConnected=connected;
  connected = value === 'connected';
  if (!connected) settle(false);
  if(connected) {++publicEpoch;diagnostic('public','reachable');}
  else if(value==='reconnecting') void probePublic(wasConnected);
  send({type:'state',value,coreDevice:value==='connected'&&!stopping?coreDevice:null});
};
function settle(approved) {
  if (!pending) return;
  const p = pending;
  pending = null;
  clearTimeout(p.timer);
  p.resolve(approved === true);
  send({type:'confirmationClosed',id:p.id});
}
async function stop() {
  if (stopping) return;
  stopping = true;
  connected = false;
  settle(false);
  send({type:'state',value:'stopped'});
  // Close only the foreground worker's own backend; IPC also closes it if the worker dies.
  await backend?.close();
  process.stdout.write('',()=>process.exit(0));
  setTimeout(()=>process.exit(0),250).unref();
}
async function validateWorkspace(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) fail('WORKSPACE_REQUIRED');
  const root = await realpath(value).catch(()=>fail('WORKSPACE_REQUIRED'));
  if (!(await stat(root)).isDirectory()) fail('WORKSPACE_REQUIRED');
  const home = await realpath(os.homedir());
  const relative = path.relative(home,root);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) ||
      relative.split(path.sep).some(part=>part.startsWith('.')) ||
      /^(AppData|Windows)([\\/]|$)/i.test(relative)) fail('WORKSPACE_SCOPE_REQUIRED');
  return root;
}
async function checkApprovedBackend(root) {
  if (!backend) fail('BUNDLED_BACKEND_UNAVAILABLE');
  await backend.check();
}
async function verifyApprovedBackend(root) {
  diagnostic('backend','checking');
  try { await checkApprovedBackend(root);diagnostic('backend','reachable'); }
  catch(e) {
    diagnostic('backend',e?.message==='BACKEND_SCOPE_MISMATCH'?'scope_mismatch':e?.message==='APPROVED_BACKEND_CONFIG_REQUIRED'?'config_required':'unavailable');
    throw e;
  }
}
async function readPaired() {
  try { return await store.load(); }
  catch(e) { if(e?.code==='ENOENT') return null; throw e; }
}
async function writeProfile(config) {
  await mkdir(stateDir,{recursive:true});
  const temp=profilePath+'.tmp';
  await writeFile(temp,JSON.stringify({endpoint:config.routerUrl,workspace:config.device.roots[0],paired:true},null,2),'utf8');
  await rename(temp,profilePath);
}
async function requestApproval(job, root, mode) {
  if (!canApprove({enabled:!stopping,connected,expiresAt:job.expiresAt})) return false;
  const kind=classifyJob(job);
  if (kind.type==='deny') return false;
  if (kind.type==='protocol') return true;
  if (mode==='session-v1') return authorizeSessionTool({mode,kind,job,
    getState:()=>({enabled:active&&!stopping,connected}),
    verifyBackend:()=>verifyApprovedBackend(root)});
  if (pending) return false;
  const remaining=Number.isSafeInteger(job.expiresAt)? job.expiresAt-Date.now():20000;
  if (remaining <= 0) return false;
  const id=randomUUID();
  const allowed=await new Promise(resolve=>{
    pending={id,resolve,timer:setTimeout(()=>settle(false),Math.min(20000,remaining))};
    send({type:'confirmation',id,name:kind.name,description:kind.description,timeoutSeconds:Math.ceil(Math.min(20000,remaining)/1000)});
  });
  if (!allowed || !canApprove({enabled:!stopping,connected,expiresAt:job.expiresAt})) return false;
  try { await verifyApprovedBackend(root); }
  catch { return false; }
  return canApprove({enabled:!stopping,connected,expiresAt:job.expiresAt});
}
async function start(message) {
  if(active || stopping) return;
  active=true;
  state('connecting');
  let stage='preflight';
  try {
    if(process.platform!=='win32') fail('WINDOWS_REQUIRED');
    if(message.localConsent!==true) fail('LOCAL_CONSENT_REQUIRED');
    // Only a fresh local start action can select this session grant.
    const authorizationMode=message.authorizationMode==='session-v1'?'session-v1':'per-task';
    const origin=validateOrigin(message.endpoint);
    sessionOrigin=origin;
    store=pinnedConfigStore(new AgentConfigStore(path.join(stateDir,'agent.json')),origin);
    const root=await validateWorkspace(message.workspace);
    let config=await readPaired();
    if(config) {
      if(config.routerUrl!==origin || config.devspace?.baseUrl!==BACKEND_URL ||
          config.device?.platform!=='win32' || config.device.roots?.length!==1 ||
          !equalPath(config.device.roots[0],root)) fail('PAIRING_PROFILE_MISMATCH');
    }
    diagnostic('backend','checking');
    backend=await startManagedBackend({stateDir,root,isStopping:()=>stopping,onExit:()=>{if(!stopping){send({type:'error',code:'BUNDLED_BACKEND_UNAVAILABLE'});void stop();}}});
    process.env.CODASSOL_DEVSPACE_AUTH_FILE=backend.authFile;
    const [backendCheck]=await Promise.allSettled([verifyApprovedBackend(root),probePublic(true)]);
    if(backendCheck.status==='rejected') throw backendCheck.reason;
    if(stopping) return;
    if(!config) {
      const code=typeof message.pairing==='string'?message.pairing.trim():'';
      if(code.length<16) fail('PAIRING_REQUIRED');
      stage='pairing';
      config=await enrollAgent({
        routerUrl:origin,pairingToken:code,deviceId:'windows-'+randomUUID(),
        label:os.hostname(),roots:[root],devspaceBaseUrl:BACKEND_URL,configStore:store
      });
    }
    // Never print the token or copy another installation's credentials.
    if(stopping) return;
    await writeProfile(config);
    send({type:'paired',endpoint:origin,workspace:root});
    stage='sse';
    await runAgent({configStore:store,transport:'sse',stopSignal:()=>stopping,
      onSessionState:state,authorizeJob:job=>requestApproval(job,root,authorizationMode)});
    if(!stopping) state('stopped');
  } catch(e) {
    if(!stopping) {
      const known=['WINDOWS_REQUIRED','LOCAL_CONSENT_REQUIRED','HTTPS_ORIGIN_REQUIRED','LEGACY_INGRESS_RETIRED','WORKSPACE_REQUIRED','WORKSPACE_SCOPE_REQUIRED','APPROVED_BACKEND_CONFIG_REQUIRED','BACKEND_SCOPE_MISMATCH','APPROVED_BACKEND_UNAVAILABLE','BUNDLED_BACKEND_MISSING','BUNDLED_BACKEND_UNAVAILABLE','PAIRING_PROFILE_MISMATCH','PAIRING_REQUIRED'];
      const code=known.includes(e?.message)?e.message:
        stage==='sse'&&e?.code==='SSE_UNAVAILABLE'?'SSE_UNAVAILABLE':
        stage==='sse'&&[401,403].includes(e?.status)?'SSE_AUTH_REJECTED':
        stage==='sse'&&e?.status===409?'SSE_LEASE_CONFLICT':
        stage==='pairing'&&[401,403].includes(e?.status)?'PAIRING_REJECTED':
        stage==='pairing'?'PAIRING_FAILED':'CONNECTION_OR_PAIRING_FAILED';
      send({type:'error',code});
    }
  } finally {
    active=false;
    stop();
  }
}
process.stdout.on('error',()=>process.exit(0));
const input=createInterface({input:process.stdin,terminal:false});
input.on('line',line=>{
  if(line.length>65536 || stopping) return;
  let msg;try{msg=JSON.parse(line);}catch{return;}
  if(msg?.type==='start') void start(msg);
  else if(msg?.type==='stop') stop();
  else if(msg?.type==='approve' && pending && msg.id===pending.id) settle(msg.allow===true);
});
input.on('close',stop);
process.stdin.on('error',stop);
process.on('SIGINT',stop);
process.on('SIGTERM',stop);
