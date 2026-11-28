import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, realpath, lstat, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const BACKEND_PORT = 29676;
export const BACKEND_URL = 'http://127.0.0.1:' + BACKEND_PORT;
const runtimeDir = path.dirname(fileURLToPath(import.meta.url));
const fail = code => { throw Error(code); };
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
const readJson = async file => JSON.parse(await readFile(file,'utf8'));
const equal = (a,b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
async function plainDir(dir) {
  const st = await lstat(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || !equal(await realpath(dir),dir)) fail('BACKEND_SCOPE_MISMATCH');
}
export async function prepareBackendState(stateDir,root) {
  await mkdir(stateDir,{recursive:true});
  await plainDir(stateDir);
  const dir = path.join(stateDir,'backend');
  const config = {
    configVersion:1,
    server:{host:'127.0.0.1',port:BACKEND_PORT,publicBaseUrl:BACKEND_URL},
    workspaces:{allowedRoots:[root],worktreeRoot:path.join(stateDir,'worktrees')},
    storage:{stateDir:path.join(stateDir,'backend-storage')},
    tools:{mode:'codex'},
    skills:{enabled:false,paths:[],agentDir:path.join(stateDir,'agents')},
    subagents:{enabled:false,instructions:'on-demand',providers:[]},
    logging:{level:'warn',format:'json',requests:false,assets:false,toolCalls:true,shellCommands:false}
  };
  let exists = false;
  try { await plainDir(dir); exists = true; } catch(e) { if(e.code!=='ENOENT') throw e; }
  if (!exists) {
    const staged = path.join(stateDir,'backend-initializing-'+randomUUID());
    await mkdir(staged,{mode:0o700});
    try {
      await writeFile(path.join(staged,'config.jsonc'),JSON.stringify(config,null,2),{flag:'wx',mode:0o600});
      await writeFile(path.join(staged,'auth.json'),JSON.stringify({ownerToken:randomBytes(32).toString('base64url')}),{flag:'wx',mode:0o600});
      await rename(staged,dir);
    } finally { await rm(staged,{recursive:true,force:true}); }
  }
  async function verify() {
    await plainDir(dir);
    for(const name of ['config.jsonc','auth.json']){
      const p=path.join(dir,name); const s=await lstat(p);
      if(!s.isFile() || s.isSymbolicLink() || !equal(await realpath(p),p)) fail('BACKEND_SCOPE_MISMATCH');
    }
    const actual = await readJson(path.join(dir,'config.jsonc'));
    const auth = await readJson(path.join(dir,'auth.json'));
    // No inherited global configuration or broader roots.
    if(JSON.stringify(actual)!==JSON.stringify(config) ||
       typeof auth.ownerToken!=='string' || auth.ownerToken.length<32) fail('BACKEND_SCOPE_MISMATCH');
    if(!equal(await realpath(root),root)) fail('BACKEND_SCOPE_MISMATCH');
  }
  await verify();
  return {dir,authFile:path.join(dir,'auth.json'),verify};
}
export async function startManagedBackend({stateDir,root,isStopping=()=>false,onExit=()=>{},runtime=runtimeDir}) {
  const state = await prepareBackendState(stateDir,root);
  if(isStopping()) fail('BACKEND_STOPPED');
  const cli=path.join(runtime,'devspace','node_modules','@waishnav','devspace','dist','cli.js');
  const preload=path.join(runtime,'backend-preload.mjs');
  // Only our packaged backend; never adopt a preexisting listener or repair files.
  for(const file of [cli,preload]) if(!(await lstat(file)).isFile()) fail('BUNDLED_BACKEND_MISSING');
  const env={...process.env,DEVSPACE_CONFIG_DIR:state.dir,CODAS_WINDOWS_STATE_DIR:stateDir,CODAS_WINDOWS_BACKEND_PORT:String(BACKEND_PORT)};
  delete env.NODE_OPTIONS; delete env.NODE_PATH; delete env.DEVSPACE_OAUTH_OWNER_TOKEN;
  const child=spawn(process.execPath,['--import',pathToFileURL(preload).href,cli,'serve'],{
    cwd:stateDir,env,windowsHide:true,shell:false,stdio:['ignore','ignore','pipe','ipc']
  });
  // Drain stderr; report only bounded error categories in disposable CI, never
  // raw child logs, local config, or credentials.
  const ciDiagnostic = process.env.GITHUB_ACTIONS==='true' && process.env.CODAS_BACKEND_CI_DIAGNOSTICS==='1';
  let stderrTail='';
  const diagnostic=(event,fields={})=>{if(ciDiagnostic) console.error(JSON.stringify({backendDiagnostic:event,...fields}));};
  child.stderr.on('data',chunk=>{if(ciDiagnostic) stderrTail=(stderrTail+chunk.toString('utf8')).slice(-8192);});
  child.once('close',(code,signal)=>{
    const categories=[...new Set(stderrTail.match(/ERR_[A-Z0-9_]+|MODULE_NOT_FOUND|EADDRINUSE|EACCES|EPERM|ENOENT|SQLITE_[A-Z_]+/g)||[])].slice(0,12);
    if(/better-sqlite3 could not load|not a valid Win32 application/i.test(stderrTail)) categories.push('NATIVE_MODULE_LOAD');
    if(/DevSpace is not configured/i.test(stderrTail)) categories.push('CONFIG_NOT_FOUND');
    if(/invalid configuration|ZodError/i.test(stderrTail)) categories.push('INVALID_CONFIG');
    diagnostic('child-close',{code,signal,categories,listening});
  });
  let listening=false,exited=false,closing=false;
  const done = new Promise(resolve=>{
    child.once('exit',()=>{exited=true;resolve();if(!closing)onExit();});
    child.once('error',error=>{diagnostic('spawn-error',{code:error.code});exited=true;resolve();if(!closing)onExit();});
  });
  child.on('message',msg=>{if(msg?.type==='listening' && msg.port===BACKEND_PORT) listening=true;});
  async function check() {
    if(exited || !listening || closing) fail('BUNDLED_BACKEND_UNAVAILABLE');
    await state.verify();
    const response=await fetch(BACKEND_URL+'/healthz',{redirect:'error',signal:AbortSignal.timeout(2000)});
    const health=await response.json();
    if(!response.ok || health?.ok!==true || health?.name!=='devspace') fail('BUNDLED_BACKEND_UNAVAILABLE');
  }
  async function close() {
    closing=true;
    if(exited)return;
    if(child.connected)child.send({type:'stop'},()=>{});
    await Promise.race([done,sleep(1500)]);
    if(!exited){child.kill();await Promise.race([done,sleep(500)]);}
  }
  try{
    const deadline=Date.now()+120000;
    while(Date.now()<deadline && !exited && !isStopping()){
      try{await check();return {check,close,authFile:state.authFile};}catch(e){
        if(e.message==='BACKEND_SCOPE_MISMATCH')throw e;
      }
      await sleep(300);
    }
    diagnostic('readiness-failed',{exited,listening,stopping:isStopping()});
    fail('BUNDLED_BACKEND_UNAVAILABLE');
  }catch(e){await close();throw e;}
}
