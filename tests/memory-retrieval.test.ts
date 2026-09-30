import { describe, expect, it } from 'vitest';
import { assessSupport } from '../packages/core/src/memory/support.js';
import { fuseCandidates, selectEvidence, ftsQuery, retrievalIntent } from '../packages/core/src/memory/retrieval.js';
import type { Candidate, EvidenceItem } from '../packages/core/src/memory/contracts.js';
function evidence(id: string, text: string, role = 'assistant'): EvidenceItem {
  return { ref: { sourceId: 's', revisionId: 'r', spanId: id }, role, text, startUtf16: 0, endUtf16: text.length,
    sourceEventAt: null, observedAt: '2026-01-01', project: 'p', branch: null, authority: 'source', citation: id, historical: false, quoteBasis: 'redacted_unit' };
}
function c(id: string, text: string, role?: string): Candidate { return { ref: evidence(id, text).ref, score: 1, lanes: [], evidence: evidence(id, text, role) }; }
describe('evidence selection and support boundaries', () => {
  it('unions independent lanes and keeps an exact lexical hit omitted by dense', () => {
    const result = fuseCandidates([{ lane: 'lexical', candidates: [c('literal', 'build.job_9')] }, { lane: 'dense', candidates: [c('semantic', 'automated compile task')] }]);
    expect(result.map((r) => r.ref.spanId).sort()).toEqual(['literal', 'semantic']);
    expect(result[0]!.score).toBeCloseTo(1 / 61);
  });
  it('prefers a missing facet and recorded outcome over duplicate descriptions', () => {
    const candidates = fuseCandidates([{ lane: 'lexical', candidates: [c('1', 'cache invalidation retry failed'), c('2', 'cache invalidation retry failed'), c('3', 'cache invalidation retry failed'), c('4', 'cache invalidation retry failed'), c('5', 'cache invalidation retry failed'), c('6', 'rollback recovered deployment', 'tool_result')] }]);
    const delivered = selectEvidence(candidates, 'cache invalidation retry rollback recovered deployment');
    expect(delivered.map((e) => e.ref.spanId).sort()).toEqual(['1', '6']);
  });
  it('retains repeated observed outcomes when event times differ', () => {
    const early=c('early','retry returned ok','tool_result'),late=c('late','retry returned ok','tool_result');
    early.evidence!.sourceEventAt='2026-01-01';late.evidence!.sourceEventAt='2026-01-02';
    expect(selectEvidence(fuseCandidates([{lane:'lexical',candidates:[early,late]}]),'current retry status')).toHaveLength(2);
  });
  it('does not erase caller qualifiers from the lexical query', () => {
    expect(ftsQuery('What did raven choose for nonexistent_policy?')).toBe('"raven" OR "choose" OR "nonexistent_policy"');
  });
  it('does not treat semantic relevance or a ghost prompt as support', () => {
    expect(assessSupport([], [evidence('a', 'The work was planned')], [], true).state).toBe('unassessed');
    expect(assessSupport([{ id: 'r', text: 'literal exists', literal: 'done' }], [evidence('g', 'done', 'ghost_prompt')], [], true).state).toBe('insufficient');
  });
  it('delivers a retained prompt for inspection while leaving answer/outcome sufficiency conservative',()=>{
    const ghost=c('g','the retry was requested','ghost_prompt');
    const selected=selectEvidence(fuseCandidates([{lane:'literal',candidates:[ghost]}]),'retry');
    expect(selected.map(item=>item.role)).toEqual(['ghost_prompt']);
    expect(assessSupport([{id:'r',text:'retry completed',literal:'retry'}],selected,[],true).state).toBe('insufficient');
  });
  it('literal support covers only rendered exact case-sensitive text', () => {
    const requirement = [{ id: 'r', text: 'literal exists', literal: 'cache.X_9' }];
    expect(assessSupport(requirement, [evidence('a', 'cache.x_9')], [], true).state).toBe('insufficient');
    expect(assessSupport(requirement, [evidence('a', 'cache.X_9')], [], true).state).toBe('sufficient');
    expect(assessSupport(requirement, [evidence('a', 'cache.X_9')], [], false).state).toBe('insufficient');
  });
});


describe('ranked source roles and bounded query novelty',()=>{
 it('keeps a strongly ranked parent outcome ahead of a broad prompt that merely adds query words',()=>{
  const child=c('child','child completed zero retries','tool_result'),parent=c('parent','parent completed nine retries','tool_result'),prompt=c('prompt','compare parent child completed retries policy adoption');
  child.score=1;parent.score=0.99;prompt.score=0.90;
  expect(selectEvidence([child,parent,prompt],'parent child completed retries policy adoption',[],2).map(x=>x.ref.spanId)).toEqual(['child','parent']);
 });
 it('prefers both independent measurements over an instruction merely asking for them',()=>{
  const prompt=c('request','compare independent measurements for project X','user'),north=c('north','Independent measurement returned nine missing records','tool_result'),south=c('south','Independent measurement returned zero missing records','tool_result');
  prompt.score=1;north.score=.52;south.score=.51;north.evidence!.ref.sourceId='north-source';south.evidence!.ref.sourceId='south-source';north.ref=north.evidence!.ref;south.ref=south.evidence!.ref;
  const delivered=selectEvidence([prompt,north,south],'Compare the independent measurements for project X',[],2);
  expect(delivered.map(x=>x.ref.spanId)).toEqual(['north','south']);
  expect(assessSupport([],delivered,[],true).state).toBe('unassessed');
 });
 it('does not equate similar wording across independent sources with duplicate evidence',()=>{
  const north=c('north','revision measurement returned nine failures','tool_result'),south=c('south','revision measurement returned zero failures','tool_result'),other=c('other','revision measurement pending');
  north.score=1;south.score=.99;other.score=.5;north.evidence!.ref.sourceId='north-source';south.evidence!.ref.sourceId='south-source';
  expect(selectEvidence([north,south,other],'revision inspection',[],2).map(x=>x.ref.spanId)).toEqual(['north','south']);
 });
 it('keeps literal requirements authoritative over an observed-outcome preference',()=>{
  const exact=c('exact','outcomes.marker_42','user'),measured=c('measured','recorded measurement returned zero','tool_result');exact.score=.6;measured.score=1;
  expect(selectEvidence([exact,measured],'outcomes.marker_42',[{id:'literal',text:'literal',literal:'outcomes.marker_42'}],1).map(x=>x.ref.spanId)).toEqual(['exact']);
 });
 it('separates decision-context navigation from a historical diagnosis question',()=>{
  expect(retrievalIntent('What choice currently governs and what did it replace?').requestForDecisionContext).toBe(true);
  expect(retrievalIntent('Explain the historical diagnosis of the retry fault').requestForDecisionContext).toBe(false);
  expect(retrievalIntent('What outcomes did the independent verifier report?').requestForObservedOutcome).toBe(true);
  expect(retrievalIntent('What prompt did the user type?').requestForObservedOutcome).toBe(false);
 });
});


it('does not boost a long raw tool log merely because it has the tool_result role',()=>{
 const log=c('log',('project X independent verifier heartbeat idle counter\n').repeat(60),'tool_result');
 const left=c('left','Independent measurement: nine missing records.','tool_result');
 const right=c('right','Independent measurement: zero missing records.','tool_result');
 log.score=1;left.score=.52;right.score=.51;left.evidence!.ref.sourceId='left';right.evidence!.ref.sourceId='right';
 expect(selectEvidence([log,left,right],'independent verifier measurements project X',[],2).map(x=>x.ref.spanId)).toEqual(['left','right']);
});
