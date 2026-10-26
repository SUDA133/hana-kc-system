// Manual proposal ingress; never publishes a formal card.
import {archiveClosedBlocks} from '../lib/archive-router.js';
import {proposeCandidate} from '../lib/candidate-store.js';
export const name='kc-archive';
export const description='从显式文本或结构化提议创建知识候选；候选审核发布前不会进入正式卡库。';
export const parameters={type:'object',properties:{text:{type:'string',maxLength:65536},proposals:{type:'array',items:{type:'object'},minItems:1,maxItems:20},sourceTag:{type:'string',minLength:1,maxLength:64}},oneOf:[{required:['text']},{required:['proposals']}]};
export async function execute(input={},ctx={}){
 try{
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('input must be object');
  if((input.text!==undefined)===(input.proposals!==undefined))throw new Error('Choose exactly one ingress: text or proposals');
  if(input.sourceTag!==undefined&&(typeof input.sourceTag!=='string'||!input.sourceTag.trim()||input.sourceTag.length>64))throw new Error('sourceTag must contain 1..64 characters');
  const source=typeof input.sourceTag==='string'?input.sourceTag.trim():'manual';let report;
  if(input.proposals!==undefined){
   if(!Array.isArray(input.proposals)||!input.proposals.length||input.proposals.length>20)throw new Error('proposals must contain 1..20 items');
   const items=[];for(const proposed of input.proposals)items.push(await proposeCandidate({proposed,origin:{source,sessionPath:ctx.sessionPath||null}}));
   report={ok:items.every(x=>x.ok),candidates:items.filter(x=>x.ok).length,diagnosticsRegistered:0,items,diagnostics:[],archived:0};
  }else{
   if(typeof input.text!=='string'||!input.text.trim()||input.text.length>65536)throw new Error('text must contain 1..65536 characters');
   report=await archiveClosedBlocks(input.text,{sourceTag:source,sessionPath:ctx.sessionPath||null});
  }
  return{content:[{type:'text',text:`已提取可审内容候选：${report.candidates||0} 项；诊断登记：${report.diagnosticsRegistered||0} 项；正式入库：0。${report.ok?'':'存在错误或截断，请查看details。'}\n候选不属于正式知识，发布需kc_verify publish核对候选revision及目标digest。`}],details:{...report,policyVersion:5,formalWrites:0},isError:!report.ok};
 }catch(e){return{content:[{type:'text',text:'候选提取失败：'+String(e?.code||e?.message||e).slice(0,240)}],details:{code:'PROPOSAL_ERROR',formalWrites:0},isError:true};}
}
