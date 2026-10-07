import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DerivedCache,type DerivedCacheBinding} from '../../packages/core/src/analytics/derived-cache.js';
import {indexHistoryBytes,historyMayOverlap,validateHistoryDateIndex} from '../../packages/core/src/analytics/history-index.js';
const binding:DerivedCacheBinding={sourceId:'s',sourceIdentity:'inode-1',contentHash:'hash-one',currentness:'fresh-one',privacyPolicy:'policy1',forgetEpoch:'0',normalizationVersion:'native-v1'};
const validate=(v:unknown):v is {count:number}=>!!v&&typeof v==='object'&&typeof (v as {count?:unknown}).count==='number';
describe('private persistent derived cache and date inventory',()=>{
 it('persists atomically at 0600 and invalidates changed source/privacy/forget/model/question bindings',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'launch-derived-'));try{const cache=new DerivedCache(path.join(dir,'derived'));cache.write('usage',binding,{count:2},validate);expect(cache.read('usage',binding,validate)).toEqual({count:2});const entries=fs.readdirSync(cache.directory);expect(entries).toHaveLength(1);expect(fs.statSync(path.join(cache.directory,entries[0]!)).mode&0o777).toBe(0o600);expect(fs.statSync(cache.directory).mode&0o777).toBe(0o700);
   for(const change of [{contentHash:'hash-two'},{sourceIdentity:'inode-2'},{currentness:'stale'},{privacyPolicy:'policy2'},{forgetEpoch:'1'},{model:'different'},{questionVersion:'q2'},{normalizationVersion:'v2'},{segmentationVersion:'new'}])expect(cache.read('usage',{...binding,...change},validate)).toBeNull();expect(fs.readdirSync(cache.directory).filter(f=>f.endsWith('.tmp'))).toHaveLength(0);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
 });
 it('rejects transcript-bearing payloads and malformed persisted schemas even under permissive validators',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'launch-derived-'));try{const cache=new DerivedCache(dir);const any=(v:unknown):v is unknown=>true;expect(()=>cache.write('semantic',binding,{answers:{text:'private transcript sentinel'}},any)).toThrow('derived_cache_value_invalid');cache.write('usage',binding,{count:2},validate);const file=path.join(dir,fs.readdirSync(dir)[0]!);fs.writeFileSync(file,'{"schema":"old","value":{"count":2}}');expect(cache.read('usage',binding,validate)).toBeNull();expect(fs.readFileSync(file,'utf8')).not.toContain('private transcript sentinel');}finally{fs.rmSync(dir,{recursive:true,force:true});}
 });
 it('skips warm intervals only from verified complete recorded dates, never file timestamps',()=>{
  const bytes=Buffer.from('{"type":"message","timestamp":"2026-01-01T00:00:00Z"}\n{"type":"message","timestamp":"2026-01-04T00:00:00Z"}\n');const index=indexHistoryBytes(bytes,'pi',binding);expect(validateHistoryDateIndex(index)).toBe(true);expect(index.eventFrom).toBe('2026-01-01T00:00:00.000Z');expect(historyMayOverlap(index,binding,'2026-09-01',null)).toBe(false);expect(historyMayOverlap(index,binding,'2026-01-03','2026-01-05')).toBe(true);expect(historyMayOverlap(index,{...binding,contentHash:'changed'},'2026-09-01',null)).toBe(true);expect(historyMayOverlap(index,{...binding,currentness:'changed'},'2026-09-01',null)).toBe(true);
 });
 it('keeps unknown dates, malformed records, bounds and incomplete tails conservative',()=>{
  for(const bytes of ['{"type":"message"}\n','not-json\n','{"timestamp":"2026-01-01T00:00:00Z"}','{"timestamp":"2026-01-01T00:00:00Z"}\n{"timestamp":"2026-01-02T00:00:00Z"}\n']){const index=indexHistoryBytes(bytes,'pi',binding,{maxRecords:1});expect(index.complete).toBe(false);expect(historyMayOverlap(index,binding,'2026-09-01',null)).toBe(true);}
 });
 it('supports native OpenCode timestamp metadata and rejects invented complete index records',()=>{const i=indexHistoryBytes('[{"id":"one","time":{"created":1767225600000}}]','opencode',binding);expect(i.complete).toBe(true);expect(historyMayOverlap(i,binding,'2026-09-01',null)).toBe(false);expect(validateHistoryDateIndex({...i,unknownDates:3})).toBe(false);});
});
