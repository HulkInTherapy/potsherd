import {afterEach,describe,it,expect} from 'vitest';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {auditProfanity,ENGLISH_EXPLICIT_LEXICON,PROFANITY_LEXICON_VERSION} from '../../packages/core/src/analytics/profanity.js';
import {createAuditSession,publicAuditSnapshot} from '../../packages/core/src/analytics/index.js';
import type {AuditPrompt,AuditSession} from '../../packages/core/src/analytics/contracts.js';
const roots:string[]=[],sessions:AuditSession[]=[];afterEach(()=>{sessions.splice(0).forEach(s=>s.dispose());roots.splice(0).forEach(root=>fs.rmSync(root,{recursive:true,force:true}));});
function prompt(text:string,id='p',extra:Partial<AuditPrompt>={}):AuditPrompt{return {id,conversationId:'c',role:'user',originBasis:'claude_prompt_id',identityBasis:'native',eligibleHuman:true,excludedReason:null,eventAt:'2026-10-01',text,route:{basis:'transient_snapshot',sourceId:'c',artifactHash:'synthetic',sourcePath:'/synthetic/input',recordKey:id,rawStart:0,rawEnd:1,startUtf16:0,endUtf16:text.length,snapshotId:'s'},...extra};}

describe('bounded literal English lexicon — no sentiment or universal-language claims',()=>{
 it('documents a fixed lexicon and counts occurrences separately from containing inputs',()=>{
  expect(ENGLISH_EXPLICIT_LEXICON).toEqual(['fuck','fucked','fucking','shit','shitty','bullshit','asshole','bastard']);const result=auditProfanity([prompt('shit, SHIT and fucking.', 'one'),prompt('neutral','two')]);expect(result.lexiconVersion).toBe(PROFANITY_LEXICON_VERSION);expect(result.occurrences.numerator).toBe(3);expect(result.containingPrompts.numerator).toBe(1);expect(result.containingPrompts.denominator).toBe(2);expect(result.buckets.find(b=>b.kind==='direct_prose')!.occurrences).toBe(3);expect(result.containingPrompts.definition).toContain('No emotion');
 });
 it('uses Unicode whole-word tokens and exact original UTF-16 ranges without substring false positives',()=>{
  const input=prompt('🙂FUCK！ classify pass assholeish motherfucker shitake shit_thing fuckहै fuck\u0301 fucking.');const result=auditProfanity([input]);expect(result.occurrences.value).toBe(2);expect(result.matches![0]!.startUtf16).toBe(2);expect(result.matches![0]!.endUtf16).toBe(6);for(const match of result.matches!)expect(input.text.slice(match.startUtf16,match.endUtf16)).toBe(match.term);expect(result.coverageGaps).toContain('hindi_hinglish_and_other_languages_unassessed');
 });
 it('splits direct prose, quotes, inline code, fenced code and block quotes without treating code as direct speech',()=>{
  const text='shit "fuck" `bullshit`\n```js\nconst text = "asshole";\n```\n> bastard\n',result=auditProfanity([prompt(text)]);expect(result.occurrences.value).toBe(5);expect(result.buckets.find(b=>b.kind==='direct_prose')!.occurrences).toBe(1);expect(result.buckets.find(b=>b.kind==='quoted')!.occurrences).toBe(2);expect(result.buckets.find(b=>b.kind==='code')!.occurrences).toBe(2);expect(result.containingPrompts.value).toBe(1);
 });
 it('keeps unclosed quotes/fences and ambiguous indentation in an unknown bucket',()=>{
  const result=auditProfanity([prompt('unclosed "fuck','quote'),prompt('```\nshit','fence'),prompt('    asshole','indent')]);expect(result.buckets.find(b=>b.kind==='unknown')!.occurrences).toBe(3);expect(result.buckets.find(b=>b.kind==='direct_prose')!.occurrences).toBe(0);expect(result.coverageGaps).toContain('ambiguous_quote_or_code_span');
 });
 it('preserves genuine repeats but excludes inherited, SDK, unknown and tool-derived inputs; support is capped',()=>{
  const inputs=Array.from({length:10},(_,i)=>prompt('shit',String(i)));inputs.push(prompt('fuck','inherited',{eligibleHuman:false,excludedReason:'inherited_native_event'}),prompt('fuck','sdk',{eligibleHuman:false,originBasis:'unknown',excludedReason:'programmatic_origin_unattested'}),prompt('fuck','unknown',{eligibleHuman:false,originBasis:'unknown'}),prompt('fuck','tool',{eligibleHuman:false,excludedReason:'tool_result'}));const before=JSON.stringify(inputs),result=auditProfanity(inputs);expect(result.eligiblePrompts).toBe(10);expect(result.occurrences.value).toBe(10);expect(result.containingPrompts.value).toBe(10);expect(result.matches).toHaveLength(8);expect(JSON.stringify(inputs)).toBe(before);
 });
 it('does not claim coverage for Hindi/Hinglish or unlisted words and handles apostrophes conservatively',()=>{
  const result=auditProfanity([prompt("that's neutral; fuck's not an exact lexicon token; 'shit' is quoted; हिंदी text unassessed")]);expect(result.occurrences.value).toBe(1);expect(result.matches![0]!.kind).toBe('quoted');expect(result.coverageGaps).toContain('outside_english_lexicon_unassessed');expect(result.language).toBe('en-explicit-lexicon');
 });
});
