// KC5 result routing: parsing produces candidates, never formal cards or global review debt.
import {effectiveResultName,resultText,normName} from './contracts.js';
import {noteFailure,noteSuccess} from './runtime-health.js';
export const SEDIMENT_TOOLS=new Set(['subagent','subagent-reply','workflow']);
export const BLOCK_OPEN='[KNOWLEDGE_STORE]',BLOCK_CLOSE='[/KNOWLEDGE_STORE]',MAX_BLOCK_CHARS=8000;
export function extractClosedBlocks(text,max=MAX_BLOCK_CHARS){const out=[];if(typeof text!=='string'||text.length>65536)return out;let pos=0;while(out.length<20){const a=text.indexOf(BLOCK_OPEN,pos);if(a<0)break;const b=text.indexOf(BLOCK_CLOSE,a+BLOCK_OPEN.length);if(b<0)break;const body=text.slice(a+BLOCK_OPEN.length,b);if(body.length<=max)out.push({body:BLOCK_OPEN+'\n'+body+'\n'+BLOCK_CLOSE,size:body.length});pos=b+BLOCK_CLOSE.length;}return out;}
export async function archiveClosedBlocks(text,ctx={}){
 try{
  const {parseProposals,isActionableDiagnostic}=await import('./proposal-parser.js');const {proposeCandidate}=await import('./candidate-store.js');
  const parsed=parseProposals(text),items=[],diagnostics=parsed.diagnostics||[],origin={source:ctx.sourceTag||'manual',sessionPath:ctx.sessionPath||null,taskId:ctx.taskId||null};
  for(const proposed of parsed.proposals||[]){items.push(await proposeCandidate({proposed,origin}));}
  const actionable=diagnostics.filter(x=>isActionableDiagnostic(x.kind));
  for(const diagnostic of actionable)items.push(await proposeCandidate({diagnostic,origin}));
  const ok=items.every(x=>x.ok)&&!parsed.truncated&&!actionable.length;
  if(!ok)noteFailure('candidate-capture','proposal failed, malformed or truncated');else noteSuccess('candidate-capture');
  return{ok,parsed:(parsed.proposals||[]).length,archived:0,candidates:items.filter(x=>x.ok).length,diagnosticsRegistered:items.filter(x=>x.code==='DIAGNOSTIC_REGISTERED'||x.registered===true).length,items,diagnostics,truncated:!!parsed.truncated,skipped:!items.length,error:ok?null:'Candidate capture incomplete; formal library was not changed'};
 }catch(e){noteFailure('candidate-capture',e);return{ok:false,parsed:0,archived:0,candidates:0,items:[],diagnostics:[],error:String(e?.code||e?.message||e).slice(0,240)};}
}
export async function routeToolResult(payload={}){
 const raw=effectiveResultName({toolName:payload.toolName,details:payload.details}),name=normName(raw);
 if(!SEDIMENT_TOOLS.has(name))return{handled:false,reason:'not-sediment-tool'};
 if(payload.isError)return{handled:false,reason:'isError'};
 const text=resultText(payload.content);if(!text||!text.includes(BLOCK_OPEN))return{handled:false,reason:'no-blocks'};
 const report=await archiveClosedBlocks(text,{sourceTag:'post-execute',sessionPath:payload.session?.sessionPath||null});return{handled:true,report};
}
