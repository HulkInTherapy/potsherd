/** Native pi 0.74 extension, using its locally documented registerTool API.
 * The generated file needs only Node builtins and pi's bundled typebox.
 */
export function piExtension(entry: Record<string, unknown>): string {
 return `// potsherd-pi-entry: ${JSON.stringify(entry)}
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Type } from 'typebox';
const server = ${JSON.stringify(entry)};
export default async function(pi) {
 let child, lines, next=0, starting;
 const pending=new Map();
 function stop() {
  for(const item of pending.values()){clearTimeout(item.timer);item.reject(new Error('Potsherd transport closed'));}
  pending.clear();lines?.close();child?.stdin.end();child?.kill();child=undefined;starting=undefined;
 }
 function request(method,params) {
  return new Promise((resolve,reject)=>{
   if(!child)return reject(new Error('Potsherd transport unavailable'));
   const id=++next;
   const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Potsherd request timed out'));},30000);
   pending.set(id,{resolve,reject,timer});
   child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\\n');
  });
 }
 async function start() {
  if(starting)return starting;
  starting=(async()=>{
   child=spawn(server.command,server.args??[],{stdio:['pipe','pipe','inherit']});
   const owned=child;const onClose=()=>{if(child===owned)stop();};
   child.on('error',onClose);child.on('exit',onClose);
   lines=createInterface({input:child.stdout});
   lines.on('line',line=>{let msg;try{msg=JSON.parse(line);}catch{return;}const item=pending.get(msg.id);if(!item)return;pending.delete(msg.id);clearTimeout(item.timer);msg.error?item.reject(new Error(msg.error.message)):item.resolve(msg.result);});
   await request('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'potsherd-pi',version:'1'}});
   child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\\n');
  })();
  try{await starting;}catch(error){stop();throw error;}
 }
 await start();
 const listing=await request('tools/list',{});
 for(const tool of listing.tools)pi.registerTool({
  name:tool.name,label:tool.name,description:tool.description,
  parameters:Type.Unsafe(tool.inputSchema),
  async execute(_id,args,signal){
   signal?.throwIfAborted();await start();
   const result=await request('tools/call',{name:tool.name,arguments:args});
   if(result.isError)throw new Error(result.content?.filter(x=>x.type==='text').map(x=>x.text).join('\\n')||'Potsherd tool failed');
   return {content:result.content,details:result.structuredContent??{}};
  }
 });
 pi.on('session_start',async()=>{await start();});
 pi.on('session_shutdown',async()=>{stop();});
}
`;
}
