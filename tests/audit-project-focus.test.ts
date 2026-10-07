import {describe,it,expect} from 'vitest';
import {requestedProjectFocus} from '../packages/core/src/analytics/project-focus.js';
import type {AuditPrompt} from '../packages/core/src/analytics/contracts.js';
const p=(id:string,text:string,eligible=true):AuditPrompt=>({id,conversationId:'public',project:'/public',role:'user',originBasis:'unknown',identityBasis:id,eligibleHuman:false,eligibleNativeInput:eligible,excludedReason:eligible?null:'declared_meta_or_synthetic_input',eventAt:null,text,route:{basis:'transient_snapshot',sourceId:'public',artifactHash:'public',sourcePath:'public',recordKey:id,rawStart:0,rawEnd:0,startUtf16:0,endUtf16:text.length,snapshotId:'public'}});
describe('source-backed requested project focus',()=>{
 it('counts observed request inputs separately from human attestation, deduplicates source IDs and retains source routes',()=>{const prompts=[p('a','Please fix the crash bug.'),p('b','Update the README documentation.'),p('a','Please fix the crash bug.')],rows=requestedProjectFocus(prompts);expect(rows.map(r=>[r.label,r.inputs])).toEqual([['Debugging',1],['Documentation',1]]);expect(rows[0]!.evidenceRoutes[0]).toEqual(prompts[0]!.route);expect(rows.every(r=>r.basis==='lexical_requested_work_v1')).toBe(true);});
 it('does not turn quoted/code instructions, excluded metadata, or vague success claims into project work',()=>{expect(requestedProjectFocus([p('q','> Please fix the crash bug.'),p('code','```\nPlease build the API feature.\n```'),p('meta','Please create the CLI tool.',false),p('success','It was successful and great.')])).toEqual([]);});
});
