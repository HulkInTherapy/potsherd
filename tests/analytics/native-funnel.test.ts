import {afterEach,describe,it,expect} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {nativeFacts} from '../../packages/core/src/analytics/source.js';
const roots:string[]=[];afterEach(()=>roots.splice(0).forEach(root=>fs.rmSync(root,{recursive:true,force:true})));
async function parse(records:unknown[],harness:'claude'|'codex'='claude'){const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-origin-funnel-'));roots.push(root);const file=path.join(root,'fixture.jsonl'),bytes=Buffer.from(records.map(record=>JSON.stringify(record)).join('\n')+'\n');fs.writeFileSync(file,bytes);return nativeFacts(file,harness,bytes,100);}
describe('native eligibility first-loss boundaries',()=>{
 it('keeps a textual CLI user container without a supported native prompt marker unknown',async()=>{
  const facts=await parse([{type:'user',uuid:'synthetic-record',sessionId:'synthetic-session',entrypoint:'cli',isMeta:false,message:{role:'user',content:'Synthetic fixture input.'}}]);expect(facts.events).toHaveLength(1);expect(facts.events[0]!.eligible).toBe(false);expect(facts.events[0]!.origin).toBe('unknown');expect(facts.events[0]!.excluded).toBe('injected_or_origin_unknown');
 });
 it('does not elevate tool-result payload prompt IDs or SDK input to eligible human authority',async()=>{
  const facts=await parse([{type:'user',uuid:'t',promptId:'synthetic-prompt',sessionId:'s',message:{role:'user',content:[{type:'tool_result',content:'Synthetic tool output.'}]}},{type:'user',uuid:'u',promptId:'other',sessionId:'s',entrypoint:'sdk-ts',message:{role:'user',content:'Synthetic programmatic input.'}}]);expect(facts.events).toHaveLength(1);expect(facts.events[0]!.eligible).toBe(false);expect(facts.events[0]!.excluded).toBe('programmatic_origin_unattested');
 });
 it('keeps native input marker multiplicity and reported user-role projections separate',async()=>{
  const facts=await parse([{type:'session_meta',payload:{id:'synthetic',source:'cli'}},{type:'event_msg',payload:{type:'user_message',message:'continue'}},{type:'event_msg',payload:{type:'user_message',message:'continue'}},{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'Synthetic injected record.'}]}}],'codex');expect(facts.events.filter(event=>event.eligible)).toHaveLength(2);expect(facts.events.filter(event=>event.origin==='unknown')).toHaveLength(1);
 });
 it('withholds explicit metadata/synthetic flags even with a native marker and does not consume a later human marker identity',async()=>{
  const base={type:'user',sessionId:'synthetic-session',entrypoint:'cli',promptId:'shared-synthetic-id'};const facts=await parse([{...base,uuid:'meta',isMeta:true,message:{role:'user',content:'Synthetic metadata input.'}},{...base,uuid:'human',message:{role:'user',content:'Synthetic ordinary marked input.'}},{...base,uuid:'synthetic',promptId:'other',isSynthetic:true,message:{role:'user',content:'Synthetic declared input.'}}]);expect(facts.events).toHaveLength(3);expect(facts.events.filter(event=>event.eligible)).toHaveLength(1);expect(facts.events[0]!.excluded).toBe('declared_meta_or_synthetic_input');expect(facts.events[0]!.origin).toBe('unknown');expect(facts.events[1]!.eligible).toBe(true);expect(facts.events[2]!.eligible).toBe(false);expect(facts.gaps).toContain('explicit_meta_or_synthetic_origin_unattested');
 });
});
