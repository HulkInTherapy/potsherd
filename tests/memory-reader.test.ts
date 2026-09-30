import {describe,it,expect} from 'vitest';
import {compactFixture} from './memory-compact-fixture.js';
import {buildReaderTask,readerPrompt,validateReaderAnswer} from '../packages/core/src/memory/reader.js';
const packet=()=>{const p=compactFixture();p.evidence=p.evidence.slice(0,1);return p;};
describe('task-scoped reader contract',()=>{
 it('defines polar refutation separately from a supported affirmative or open answer',()=>{
  const p=packet(),text=readerPrompt(buildReaderTask('one','Is the claim true?',p.coverage.scope,[p]));
  expect(text).toContain('AFFIRMATIVE proposition');expect(text).toContain('A grounded No answer must use refuted, never supported');expect(text).toContain('For an open question');
 });
 it('binds exact quotes and full refs to one task without promoting previews',()=>{
  const p=packet();p.candidates[0]!.evidence=p.evidence[0];const task=buildReaderTask('one','What happened?',p.coverage.scope,[p]);
  expect(task.citations).toHaveLength(1);expect(task.citations[0]!.ref).toEqual(p.evidence[0]!.ref);expect(task.citations[0]!.startUtf16).toBe(10);expect(readerPrompt(task)).toContain('cannot prove entailment');
 });
 it('rejects packet scope mismatch before constructing reader input',()=>{
  const p=packet();expect(()=>buildReaderTask('one','What?',{project:'/other'},[p])).toThrow('reader_scope_mismatch');
 });
 it('rejects a real source citation from another task even with identical evidence',()=>{
  const p=packet(),a=buildReaderTask('one','What?',p.coverage.scope,[p]),b=buildReaderTask('two','What?',p.coverage.scope,[p]);
  const raw=JSON.stringify({taskId:a.taskId,status:'supported',claims:[{text:'The tool recorded a string.',kind:'tool_observation',citationIds:[b.citations[0]!.id]}]});
  expect(validateReaderAnswer(raw,a).errors).toContain('claim_0:citation_not_allowed');
 });
 it('does not repair trailing JSON, markdown, shortened IDs or undeclared answer fields',()=>{
  const p=packet(),task=buildReaderTask('one','What?',p.coverage.scope,[p]);const value={taskId:task.taskId,status:'insufficient',claims:[{text:'No answer is established.',kind:'uncertainty',citationIds:[]}]};
  expect(validateReaderAnswer(JSON.stringify(value)+']}',task).errors).toEqual(['invalid_json']);
  expect(validateReaderAnswer('```json\n'+JSON.stringify(value)+'\n```',task).valid).toBe(false);
  expect(validateReaderAnswer(JSON.stringify({...value,answer:'uncited extra claim'}),task).valid).toBe(false);
 });
 it('checks role and delivered quotation but leaves semantic support unassessed',()=>{
  const p=packet(),task=buildReaderTask('one','What?',p.coverage.scope,[p]),id=task.citations[0]!.id;
  const value={taskId:task.taskId,status:'supported',claims:[{text:'A tool recorded this.',kind:'tool_observation',citationIds:[id],quote:p.evidence[0]!.text}]};
  const result=validateReaderAnswer(JSON.stringify(value),task);expect(result.valid).toBe(true);expect(result.semanticSupport).toBe('unassessed');expect(result.resolvedClaims![0]!.citations[0]!.ref).toEqual(p.evidence[0]!.ref);
  value.claims[0]!.kind='user_instruction';expect(validateReaderAnswer(JSON.stringify(value),task).errors).toContain('claim_0:authority_mismatch');
  value.claims[0]!.kind='tool_observation';value.claims[0]!.quote='not delivered';expect(validateReaderAnswer(JSON.stringify(value),task).errors).toContain('claim_0:quote_not_delivered');
 });
 it('does not turn unavailable capture into semantic refusal or support',()=>{
  const p=packet();p.coverage.state='partial';const task=buildReaderTask('one','What?',p.coverage.scope,[p]);
  expect(validateReaderAnswer(JSON.stringify({taskId:'one',status:'insufficient',claims:[{text:'Not enough.',kind:'uncertainty',citationIds:[]}]}),task).errors).toContain('availability_mismatch');
 });
 it('cannot certify an inferred false claim merely because a citation is valid',()=>{
  const p=packet(),task=buildReaderTask('one','What?',p.coverage.scope,[p]);
  const result=validateReaderAnswer(JSON.stringify({taskId:'one',status:'supported',claims:[{text:'An unrelated proposition is true.',kind:'inference',citationIds:[task.citations[0]!.id]}]}),task);
  expect(result.valid).toBe(true);expect(result.semanticSupport).toBe('unassessed');
 });
});
