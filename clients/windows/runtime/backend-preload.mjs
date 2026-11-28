// A child created by the foreground worker only; never connect a foreign service.
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { reserveSessionRange, installSessionRange } from './session-generations.mjs';
let stopping=false;
function stop(){
  if(stopping)return;
  stopping=true;
  setTimeout(()=>process.exit(1),1800).unref();
  setImmediate(()=>process.listenerCount('SIGTERM')?process.emit('SIGTERM'):process.exit(0));
}
process.on('message',msg=>{if(msg?.type==='stop')stop();});
process.once('disconnect',stop);
const listen=net.Server.prototype.listen;
net.Server.prototype.listen=function(...args){
  this.once('listening',()=>{
    const address=this.address();
    if(address && typeof address==='object' && address.address==='127.0.0.1' &&
      address.port===Number(process.env.CODAS_WINDOWS_BACKEND_PORT) && process.connected)
      process.send({type:'listening',port:address.port},()=>{});
  });
  return listen.apply(this,args);
};
try{
  if(!process.env.CODAS_WINDOWS_STATE_DIR || !process.env.DEVSPACE_CONFIG_DIR)throw Error('Missing explicit state');
  const {ProcessSessionManager}=await import(pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)),'devspace','node_modules','@waishnav','devspace','dist','process-sessions.js')).href);
  installSessionRange(ProcessSessionManager,reserveSessionRange(process.env.CODAS_WINDOWS_STATE_DIR));
}catch(error){
  if(process.env.GITHUB_ACTIONS==='true' && process.env.CODAS_BACKEND_CI_DIAGNOSTICS==='1') {
    const code=typeof error?.code==='string' && /^[A-Z_0-9]+$/.test(error.code)?error.code:'SESSION_GENERATION_INITIALIZATION_FAILED';
    console.error(JSON.stringify({backendPreloadError:code}));
  }
  process.exit(78);
}
