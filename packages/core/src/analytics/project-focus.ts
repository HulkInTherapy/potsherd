import type {AuditPrompt,AuditProjectFocus} from './contracts.js';
import {proseLabels} from './profanity.js';
/** Explicit requested-task wording, never task completion or active time. */
const categories:readonly [string,RegExp][]=[
 ['Documentation',/\b(?:write|update|fix|add|edit|draft|revise)\b.{0,64}\b(?:docs?|documentation|readme|guide|changelog)\b/iu],
 ['Review',/\b(?:review|audit|inspect)\b.{0,64}\b(?:code|diff|pr|pull request|implementation|tests?|changes|repo|repository)\b/iu],
 ['Debugging',/\b(?:fix|debug|repair|resolve|reproduce)\b.{0,64}\b(?:bug|error|crash|failure|issue|test|broken|timeout|memory|hang|problem)\b/iu],
 ['Development',/\b(?:build|implement|add|create|develop|refactor|ship|integrate)\b.{0,64}\b(?:feature|app|api|cli|function|component|command|module|tool|parser|service|code|support)\b/iu],
 ['Research',/\b(?:research|look up|investigate|compare|verify)\b.{0,64}\b(?:docs?|source|pricing|model|library|approach|behavior|format|implementation)\b/iu],
];
/** Every category needs one of these verbs; a single cheap test skips most prompts. */
const VERBS=/\b(?:write|update|fix|add|edit|draft|revise|review|audit|inspect|debug|repair|resolve|reproduce|build|implement|create|develop|refactor|ship|integrate|research|look up|investigate|compare|verify)\b/iu;
export function requestedProjectFocus(prompts:readonly AuditPrompt[]):AuditProjectFocus[]{
 const groups=new Map<string,AuditPrompt[]>();
 for(const prompt of prompts){if(prompt.languageEligible===false||!(prompt.eligibleNativeInput??prompt.eligibleHuman))continue;if(!VERBS.test(prompt.text)||!categories.some(([,pattern])=>pattern.test(prompt.text)))continue;const labels=proseLabels(prompt.text),text=Array.from({length:prompt.text.length},(_,i)=>labels[i]===0?prompt.text[i]:' ').join('');
  for(const [label,pattern]of categories){if(!pattern.test(text))continue;const rows=groups.get(label)??[];if(!rows.some(p=>p.id===prompt.id))rows.push(prompt);groups.set(label,rows);}
 }
 // A label needs real support: at least 5 prompts and 10% of the project's prompts.
 const minimum=Math.max(5,Math.ceil(prompts.length*0.1));
 return [...groups].filter(([,rows])=>rows.length>=minimum).map(([label,rows])=>({label,inputs:rows.length,promptIds:rows.slice(0,3).map(p=>p.id),evidenceRoutes:rows.slice(0,3).map(p=>p.route),basis:'lexical_requested_work_v1' as const})).sort((a,b)=>b.inputs-a.inputs||a.label.localeCompare(b.label)).slice(0,2);
}
