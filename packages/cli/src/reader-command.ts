import fs from 'node:fs';
import {buildReaderTask,readerPrompt,validateReaderAnswer,complementaryReadRefs,type MemoryResponse,type Scope,type ResponseBudget,type SpanRef} from '@potsherd/core';
/** Explicit file input only. Never opens the archive, starts a model or reads a
 * native session. Validation rebuilds the allowlist from the caller's retained
 * public packets, not from a model-supplied task or citation dictionary. */
export function runReaderCommand(operation:string,inputFile:string):number {
 try{
  if(!['prepare','validate','next-read'].includes(operation))throw new Error('reader_operation_must_be_prepare_validate_or_next_read');
  const input=JSON.parse(fs.readFileSync(inputFile,'utf8')) as Record<string,unknown>;
  if(!input||Array.isArray(input)||typeof input!=='object'||Object.keys(input).some(k=>!['taskId','query','scope','packets',...(operation==='validate'?['raw']:[]),...(operation==='next-read'?['budget','attemptedRefs']:[])].includes(k))||typeof input.taskId!=='string'||typeof input.query!=='string'||!input.scope||typeof input.scope!=='object'||Array.isArray(input.scope)||!Array.isArray(input.packets)||(operation==='validate'&&typeof input.raw!=='string'))throw new Error('invalid_reader_input');
  const task=buildReaderTask(input.taskId,input.query,input.scope as Scope,input.packets as MemoryResponse[]);
  if(operation==='next-read'){
   const budget=input.budget as ResponseBudget;
   if(!budget||!Number.isSafeInteger(budget.maxTokens)||budget.maxTokens<1||typeof budget.tokenizerId!=='string'||(budget.remainingJourneyTokens!==undefined&&(!Number.isSafeInteger(budget.remainingJourneyTokens)||budget.remainingJourneyTokens<1)))throw new Error('invalid_reader_budget');
   const packets=input.packets as MemoryResponse[];
   const attempted=input.attemptedRefs??[];
   if(!Array.isArray(attempted)||attempted.some(ref=>!ref||typeof ref!=='object'||Array.isArray(ref)||Object.keys(ref).some(k=>!['sourceId','revisionId','spanId'].includes(k))||['sourceId','revisionId','spanId'].some(k=>typeof ref[k]!=='string')))throw new Error('invalid_attempted_refs');
   const packet=packets.length?{...packets[0]!,evidence:packets.flatMap(p=>p.evidence),assertions:packets.flatMap(p=>p.assertions),candidates:packets.flatMap(p=>p.candidates)}:undefined;
   const refs=packet&&task.availability==='ready'?complementaryReadRefs(packet,packets.flatMap(p=>p.evidence),new Set((attempted as SpanRef[]).map(ref=>JSON.stringify([ref.sourceId,ref.revisionId,ref.spanId])))):[];
   const state=task.availability==='unavailable'?'unavailable':refs.length?'ready':'complete';
   process.stdout.write(JSON.stringify({state,semanticSupport:'unassessed',...(refs.length?{request:{refs,scope:input.scope,budget,responseFormat:'compact-v1'}}:{})})+'\n');return 0;
  }
  const result=operation==='prepare'?{task,prompt:readerPrompt(task)}:validateReaderAnswer(input.raw as string,task);
  process.stdout.write(JSON.stringify(result)+'\n');return 'valid' in result&&!result.valid?1:0;
 }catch(error){process.stdout.write(JSON.stringify({valid:false,errors:[error instanceof Error?error.message:'invalid_reader_input'],semanticSupport:'unassessed'})+'\n');return 1;}
}
