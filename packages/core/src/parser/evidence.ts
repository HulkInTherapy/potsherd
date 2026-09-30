import fs from 'node:fs';
import type { EvidenceRecord, Continuation } from '../memory/contracts.js';
import { hash } from '../memory/spans.js';
import { readJsonlLines, parseJsonLine } from './jsonl.js';
import { isRecord, extractTypedText, extractTextFromContent, stringifyToolInput, stringifyToolOutput } from './content.js';
export const LEGACY_EXCHANGE_MAPPING_VERSION='exchange-record-map-v1';
export const CLAUDE_EVIDENCE_VERSION='claude-records-v4';
export const CODEX_EVIDENCE_VERSION='codex-records-v6';
/** Record-level evidence, including outcomes with no matching live exchange. */
export async function collectEvidence(file: string, harness: 'claude' | 'codex', start = 0, options: { snapshot?: Buffer; legacyByOffset?: ReadonlyMap<number, { seq: number; exchangeId: string }> } = {}): Promise<{
    records: EvidenceRecord[];
    continuation: Continuation;
    artifactHash: string;
    unknownTypes: Record<string, number>;
}> {
    const before = options.snapshot ?? fs.readFileSync(file);
    const records: EvidenceRecord[] = [];
    const nativeWrapperPayloads = new Map<string,Record<string,unknown>>();
    const unknownTypes: Record<string, number> = {};
    const gap = (kind: string) => { unknownTypes[kind] = (unknownTypes[kind] ?? 0) + 1; };
    let consumed = start;
    let reopen = start;
    let last: string | null = null;
    let project: string | undefined;
    let branch: string | undefined;
    for await (const line of readJsonlLines(file, { start, snapshot: before })) {
        if (!line.terminated)
            break;
        consumed = line.end;
        const r = parseJsonLine(line.text);
        if (!isRecord(r))
            continue;
        const p = isRecord(r.payload) ? r.payload : r;
        const type = String(r.type ?? '');
        if (typeof r.cwd === 'string')
            project = r.cwd;
        if (typeof p.cwd === 'string')
            project = p.cwd;
        if (typeof r.gitBranch === 'string')
            branch = r.gitBranch;
        if (isRecord(p.git) && typeof p.git.branch === 'string')
            branch = p.git.branch;
        const timestamp = typeof r.timestamp === 'string' && Number.isFinite(Date.parse(r.timestamp)) ? new Date(r.timestamp).toISOString() : null;
        const uuid = typeof r.uuid === 'string' ? r.uuid : typeof p.id === 'string' ? p.id : null;
        const key = uuid ?? `record:${line.lineNumber}`;
        last = key;
        const locator={recordKey:key,rawStart:line.start,rawEnd:line.end,mapping:'record_container' as const,...(typeof r.session_id==='string'?{parentNativeSessionId:r.session_id}:{})};
        const add = (role: EvidenceRecord['role'], text: string, suffix: string, extra: Partial<EvidenceRecord> = {}) => { if (!text)
            return; records.push({ unitKey: `${role}:${key}:${suffix}`, role, text, eventAt: timestamp, timeBasis: timestamp ? 'record' : 'unknown', locator: { recordKey: key, rawStart: line.start, rawEnd: line.end, mapping: 'record_container', ...(typeof r.session_id === 'string' ? { parentNativeSessionId: r.session_id } : {}) }, locatorFidelity: uuid ? 'record_id' : 'record_ordinal', ...(project ? { project } : {}), ...(branch ? { branch } : {}), recordType: `${type}/${String(p.type ?? '')}`, ...options.legacyByOffset?.get(line.start), ...extra }); };
        if (harness === 'claude') {
            if (!isRecord(r.message)){
                if(type==='user'||type==='assistant')gap('message_shape:unsupported');
                continue;
            }
            const m = r.message;
            const content = m.content;
            if(m.role !== 'user' && m.role !== 'assistant') gap(`message_role:${String(m.role ?? '(missing)')}`);
            inspectContent(content, new Set(['text','tool_use','tool_result']), new Set(['thinking','redacted_thinking']), gap);

            if (m.role === 'user') {
                const text = extractTypedText(content);
                if (text) {
                    add('user', text, 'text');
                    reopen = line.start;
                }
            }
            else if (m.role === 'assistant')
                add('assistant', extractTypedText(content), 'text');
            if (Array.isArray(content))
                content.forEach((b, i) => {
                    if (!isRecord(b))
                        return;
                    const call = typeof b.id === 'string' ? b.id : typeof b.tool_use_id === 'string' ? b.tool_use_id : undefined;
                    if (b.type === 'tool_use')
                        add('tool_input', stringifyToolInput(b.input), `block:${i}`, { ...(typeof b.name==='string'&&b.name?{toolName:b.name}:{}), ...(call ? { toolCallId: call } : {}), locator:{...locator,...(type==='assistant'&&m.role==='assistant'?{nativeKind:'claude:tool_use'}:{})} });
                    if (b.type === 'tool_result')
                        add('tool_result', stringifyToolOutput(b.content) ?? '', `block:${i}`, { ...(call ? { toolCallId: call } : {}), locator:{...locator,...(type==='user'&&m.role==='user'?{nativeKind:'claude:tool_result'}:{})}, outcome: b.is_error === true ? 'error' : b.is_error === false ? 'success' : 'unknown' });
                });
        }
        else if (type === 'response_item') {
            const subtype = String(p.type ?? '');
            const supported = ['message','function_call','custom_tool_call','tool_search_call','local_shell_call','function_call_output','custom_tool_call_output','tool_search_output','local_shell_call_output'];
            // Reasoning is an intentional metadata-only exclusion, never quoted evidence.
            if(!supported.includes(subtype) && subtype !== 'reasoning') gap(`response_item:${subtype || '(missing)'}`);
            if(subtype === 'message'){
                if(p.role !== 'user' && p.role !== 'assistant' && p.role !== 'system' && p.role !== 'developer') gap(`message_role:${String(p.role ?? '(missing)')}`);
                if(p.role !== 'system' && p.role !== 'developer') inspectContent(p.content,new Set(['text','input_text','output_text']),new Set(),gap);
            }
            const call = typeof p.call_id === 'string' ? p.call_id : undefined;
            if (subtype === 'message' && (p.role === 'user' || p.role === 'assistant')) {
                add(p.role, extractTextFromContent(p.content), 'text');
                if (p.role === 'user')
                    reopen = line.start;
            }
            if (['function_call', 'custom_tool_call', 'tool_search_call', 'local_shell_call'].includes(subtype))
                add('tool_input', stringifyToolInput(p.arguments ?? p.input ?? p.action), 'call', { ...(typeof p.name==='string'&&p.name?{toolName:p.name}:{}), ...(call ? { toolCallId: call } : {}),locator:{...locator,nativeKind:`codex:${subtype}`} });
            if (['function_call_output', 'custom_tool_call_output', 'tool_search_output', 'local_shell_call_output'].includes(subtype)) {
                const output = stringifyToolOutput(p.output) ?? '';
                const outcome = structuredToolOutcome(p);
                if(subtype==='function_call_output'&&typeof p.output==='string')nativeWrapperPayloads.set(`tool_result:${key}:output`,p);
                add('tool_result', output, 'output', { ...(call ? { toolCallId: call } : {}), outcome,locator:{...locator,nativeKind:`codex:${subtype}`} });
            }
        }
    }
    const after = fs.readFileSync(file);
    const prefix = before.subarray(0, consumed);
    if (!prefix.equals(after.subarray(0, consumed)))
        throw new Error('source changed during parse');
    return { records:resolveToolNames(harness==='codex'?resolveNativeOutcomes(records,nativeWrapperPayloads):records), unknownTypes, artifactHash: hash(prefix), continuation: { consumedOffset: consumed, lastCompleteRecordKey: last, reopenOffset: reopen, ...(options.legacyByOffset?{legacyMappingVersion:LEGACY_EXCHANGE_MAPPING_VERSION}:{}), parserStateVersion: harness==='claude'?CLAUDE_EVIDENCE_VERSION:CODEX_EVIDENCE_VERSION, prefixHash: hash(prefix) } };
}

/** Call names are relationship metadata; they never determine tool success. */
const CALL_KINDS:Record<string,string>={'claude:tool_result':'claude:tool_use','codex:function_call_output':'codex:function_call','codex:custom_tool_call_output':'codex:custom_tool_call','codex:tool_search_output':'codex:tool_search_call','codex:local_shell_call_output':'codex:local_shell_call'};
export function resolveToolNames(records:EvidenceRecord[]):EvidenceRecord[]{
 const calls=new Map<string,EvidenceRecord[]>();
 return records.map(record=>{
  if(record.role==='tool_input'&&record.toolCallId){const prior=calls.get(record.toolCallId)??[];prior.push(record);calls.set(record.toolCallId,prior);return record;}
  if(record.role!=='tool_result')return record;
  const prior=record.toolCallId?calls.get(record.toolCallId):undefined;
  const input=prior?.length===1?prior[0]:undefined;
  const expected=CALL_KINDS[String(record.locator.nativeKind??'')];
  const name=input&&expected&&input.locator.nativeKind===expected?input.toolName:undefined;
  const {toolName:_old,...rest}=record;
  return {...rest,...(name?{toolName:name}:{}),locator:{...record.locator,toolNameBasis:name?'unique_preceding_call_id':'unavailable_call_identity'}};
 });
}

/** Structured wrapper facts take precedence; arbitrary output prose has no outcome authority. */
function toolError(payload:Record<string,unknown>):boolean{
 const output=isRecord(payload.output)?payload.output:undefined;
 return payload.is_error===true||['error','failed'].includes(String(payload.status))||output?.is_error===true||['error','failed'].includes(String(output?.status));
}
function exitFacts(payload:Record<string,unknown>):number[]{
 const output=isRecord(payload.output)?payload.output:undefined;
 return [...new Set([payload.exit_code,payload.exitCode,output?.exit_code,output?.exitCode].filter((value):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=-2147483648&&value<=2147483647))];
}
export function structuredToolOutcome(payload: Record<string, unknown>): EvidenceRecord['outcome'] {
 if(toolError(payload))return 'error';
 const facts=exitFacts(payload);if(facts.length>1)return 'unknown';if(facts.length===1)return facts[0]===0?'success':'error';
 const output=isRecord(payload.output)?payload.output:undefined;
 return payload.is_error===false||output?.is_error===false||payload.status==='success'||output?.status==='success'?'success':'unknown';
}

function inspectContent(content: unknown, supported: Set<string>, excluded: Set<string>, gap: (kind:string)=>void): void {
    if(content === undefined || content === null || typeof content === 'string') return;
    if(!Array.isArray(content)){ gap('content_shape:unsupported'); return; }
    for(const block of content){
        if(!isRecord(block)){ if(block !== null) gap('content_block:unsupported'); continue; }
        const type=String(block.type ?? '(missing)');
        if(!supported.has(type) && !excluded.has(type)) gap(`content_block:${type}`);
        else if(type === 'tool_result' && Array.isArray(block.content)) inspectContent(block.content,new Set(['text']),new Set(),gap);
    }
}

/** Verified Codex rust-v0.156.1 producer framing; stdout after Output is never scanned. */
function nativeExecHeader(output:string):{state:'exit'|'running'|'missing'|'unknown'|'conflict';code?:number}{
 const header=output.slice(0,2048).match(/^(?:Chunk ID: [^\r\n]+\n)?Wall time: \d+\.\d{4} seconds\n(?:Process exited with code (-?\d+)\n)?(?:Process running with session ID (-?\d+)\n)?(?:Original token count: \d+\n)?Output:\n/);
 if(!header)return {state:'unknown'};
 if(header[1]!==undefined&&header[2]!==undefined)return {state:'conflict'};
 if(header[2]!==undefined)return {state:'running'};
 if(header[1]===undefined)return {state:'missing'};
 const code=Number(header[1]);return Number.isSafeInteger(code)&&code>=-2147483648&&code<=2147483647?{state:'exit',code}:{state:'unknown'};
}
function resolveNativeOutcomes(records:EvidenceRecord[],payloads:Map<string,Record<string,unknown>>):EvidenceRecord[]{
 const calls=new Map<string,EvidenceRecord[]>();
 return records.map(record=>{
  if(record.role==='tool_input'&&record.toolCallId){const prior=calls.get(record.toolCallId)??[];prior.push(record);calls.set(record.toolCallId,prior);return record;}
  if(record.role!=='tool_result'||!payloads.has(record.unitKey))return record;
  const payload=payloads.get(record.unitKey)!;
  if(toolError(payload))return {...record,outcome:'error'};
  const facts=exitFacts(payload);if(facts.length>1)return {...record,outcome:'unknown'};
  const prior=record.toolCallId?calls.get(record.toolCallId):undefined;
  const call=prior?.length===1?prior[0]:undefined;
  const appropriate=call?.locator.nativeKind==='codex:function_call'&&record.locator.nativeKind==='codex:function_call_output';
  const native=appropriate&&['exec_command','write_stdin'].includes(call?.toolName??'');
  if(!native){const trustworthyGeneric=call&&CALL_KINDS[String(record.locator.nativeKind)]===call.locator.nativeKind;return {...record,outcome:facts.length?facts[0]===0?'success':'error':trustworthyGeneric?record.outcome:'unknown'};}
  const header=nativeExecHeader(record.text);
  if(header.state!=='exit')return {...record,outcome:'unknown'};
  if(header.state==='exit')facts.push(header.code!);
  const unique=[...new Set(facts)];
  return {...record,outcome:unique.length===1?unique[0]===0?'success':'error':'unknown'};
 });
}
