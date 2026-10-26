// Explicit formal write entry. Automatic collection never calls this tool.
import {storeCard,validateKeywords} from '../lib/card-writer.js';
export {validateKeywords};
export const name='knowledge-store';
export const description='显式新增知识卡；实质覆盖需expectedDigest+reason。action=annotate只更新生命周期侧车，不改原卡正文。';
export const parameters={type:'object',properties:{action:{type:'string',enum:['store','annotate']},agent:{type:'string',pattern:'^[a-z0-9]+(-[a-z0-9]+)*$',maxLength:64,description:'卡片归属 Agent（小写 kebab-case；可用任何合法名，首次写入即建立对应分片）'},id:{type:'string'},keywords:{type:'array',items:{type:'string'},maxItems:20},summary:{type:'string',maxLength:100},content:{type:'string',maxLength:500},related:{type:'array',items:{type:'string'}},score:{type:'number'},source:{type:'string',maxLength:500},expectedDigest:{type:'string'},reason:{type:'string'},metadata:{type:['object','null']},expectedLifecycleRevision:{type:'integer',minimum:0}},required:['agent','id']};
export async function execute(input={}){
 try{
  if(input.action==='annotate'){
   const {annotateLifecycle}=await import('../lib/lifecycle.js');const r=await annotateLifecycle({...input,expectedRevision:input.expectedLifecycleRevision});return{content:[{type:'text',text:(r.ok?'生命周期信息已更新；原卡正文未改。':r.committed?'生命周期已提交，但写后核验失败：'+String(r.error||r.code):'生命周期更新未提交：'+String(r.error||r.code))+(r.lockReleaseWarning?' 数据锁释放异常，请查看details。':'')}],details:r,isError:!r.ok};
  }
  if(input.action!==undefined&&input.action!=='store')throw new Error('Invalid store action');
  if(input.metadata!==undefined||input.expectedLifecycleRevision!==undefined)throw new Error('metadata和expectedLifecycleRevision只能用于action=annotate');
  const card=Object.fromEntries(['agent','id','keywords','summary','content','related','score','source'].filter(k=>input[k]!==undefined).map(k=>[k,input[k]]));
  const r=await storeCard(card,{expectedDigest:input.expectedDigest,reason:input.reason});
  const msg=r.ok?(r.skipped?'相同内容已存在，未重复写入。':`已${r.isUpdate?'更新':'新增'}知识卡片 ${r.agent}::${r.id}。`)+(r.indexError?' 索引刷新失败，但卡片已提交：'+r.indexError:'')+(r.overlapWarning||''):'知识写入拒绝：'+String(r.error||r.code);
  return{content:[{type:'text',text:msg+(r.lockReleaseWarning?' 事务结果有效，但数据锁释放异常；请查看details并停止App后核查。':'')}],details:{...r,policyVersion:5},isError:!r.ok};
 }catch(e){return{content:[{type:'text',text:'知识写入失败：'+String(e?.code||e?.message||e).slice(0,240)}],details:{code:'STORE_ERROR'},isError:true};}
}
