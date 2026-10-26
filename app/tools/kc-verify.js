// Candidate review and explicit legacy-pending dispositions. No global gate release.
import fs from 'node:fs';import path from 'node:path';
import {APP_DATA_DIR} from '../lib/jsonl-io.js';
import {readReviewQueue,clearReview,normalizeKcName,isValidKcName} from '../lib/pending-store.js';
import {readRepository} from '../lib/repository.js';
import {isLifecycleVisible} from '../lib/lifecycle.js';
export const name='kc-verify';
export const description='查看知识候选并显式审核发布/驳回/恢复/终态清理；候选revision与目标digest防覆盖。旧待核验项以kcName单独处理，不阻断普通工作。';
export const parameters={type:'object',properties:{action:{type:'string',enum:['list','get','publish','reject','confirm','reconcile','recover-lock','discard-candidate']},candidateId:{type:'string'},expectedRevision:{type:'integer',minimum:1},expectedTargetDigest:{type:'string'},reviewSummary:{type:'string'},reason:{type:'string'},kcName:{type:'string'},limit:{type:'integer',minimum:1,maximum:100},offset:{type:'integer',minimum:0},status:{type:'string'},abandon:{type:'boolean'},confirm:{type:'boolean'},expectedDigest:{type:'string'}},required:['action']};
const result=(text,details={},isError=false)=>({content:[{type:'text',text}],details:{...details,policyVersion:5},isError});
function legacyDisposition(input){
 if(typeof input.kcName!=='string'||!isValidKcName(input.kcName))return result('旧待核验卡片名无效。',{code:'IDENTITY_INVALID'},true);
 const name=normalizeKcName(input.kcName),q=readReviewQueue();
 if(!q.ok)return result('旧待核验队列不可读：'+q.error,{code:'LEGACY_UNAVAILABLE'},true);
 if(!q.items.some(x=>x.name===name))return result('该项不在旧待核验队列，未修改。',{code:'LEGACY_NOT_FOUND'},true);
 const reason=typeof input.reason==='string'?input.reason.trim():'';
 if(input.action==='reject'&&(reason.length<2||reason.length>1000))return result('驳回理由需2..1000字符。',{code:'REASON_INVALID'},true);
 if(input.action==='confirm'){
  const m=name.match(/^kc--([a-z0-9]+)-+note-+(.+)$/i),repo=readRepository({includeInactive:true});
  if(!repo.complete)return result('正式库不完整，不能确认卡片存在。',{code:'KC_DATA_INCOMPLETE'},true);
  if(!m||!repo.cards.some(c=>c.identity===m[1].toLowerCase()+'::'+m[2]))return result('目标卡片尚未在正式库中，未确认。',{code:'CARD_NOT_FOUND'},true);
  const target=repo.cards.find(c=>c.identity===m[1].toLowerCase()+'::'+m[2]);
  if(target&&!isLifecycleVisible(target.lifecycle))return result('目标卡片已失效或归档，不能按当前有效知识确认。',{code:'CARD_INACTIVE',identity:target.identity,lifecycle:target.lifecycle},true);
 }
 const log=path.join(APP_DATA_DIR,'review-log.jsonl');
 try{fs.mkdirSync(APP_DATA_DIR,{recursive:true});fs.appendFileSync(log,JSON.stringify({at:new Date().toISOString(),action:input.action,kcName:name,reason,status:'requested'})+'\n','utf8');}catch(e){return result('审计记录失败，旧队列未清除。',{code:'AUDIT_WRITE_FAILED',error:String(e.code||e.message)},true);}
 const r=clearReview(name);if(!r.ok)return result('旧队列处理失败：'+r.error,{code:'LEGACY_WRITE_FAILED'},true);
 return result('旧待核验项已显式处理：'+input.action+'。未修改正式卡内容。',{kind:'legacy',kcName:name,removed:true,audit:log});
}
export async function execute(input={}){
 try{
  if(!input||typeof input!=='object'||Array.isArray(input))return result('参数必须为对象。',{code:'INPUT_INVALID'},true);
  if(input.action==='confirm'||(input.action==='reject'&&input.kcName&&!input.candidateId)){
   const {withDataLock}=await import('../lib/data-lock.js');return withDataLock(()=>legacyDisposition(input));
  }
  if(input.action==='recover-lock'){
   const {recoverDataLock}=await import('../lib/data-lock.js');const r=recoverDataLock(input);return result(r.ok?'数据锁恢复完成；未重置知识库。':'数据锁未恢复：'+r.error,r,!r.ok);
  }
  const C=await import('../lib/candidate-store.js');let r;
  if(input.action==='list'){
   r=await C.listCandidates(input);const legacy=readReviewQueue();
   const items=Array.isArray(r.items)?r.items.map(x=>({...x,candidateKind:x.kind,kind:'candidate'})):[];
   return result(`知识候选：${r.total??'未知'}；旧待核验：${legacy.ok?legacy.items.length:'不可读'}。未审项不锁普通工具。`,{...r,items,legacy:{ok:legacy.ok,items:legacy.items.slice(0,100).map(x=>({...x,kind:'legacy'})),total:legacy.ok?legacy.items.length:null,error:legacy.error||null}},!r.ok||!legacy.ok);
  }
  if(input.action==='get')r=await C.readCandidate(input.candidateId);
  else if(input.action==='publish')r=await C.publishCandidate(input);
  else if(input.action==='reject')r=await C.rejectCandidate(input);
  else if(input.action==='reconcile')r=await C.reconcileCandidate(input);
  else if(input.action==='discard-candidate')r=await C.discardCandidate(input);
  else return result('未知候选动作。',{code:'ACTION_INVALID'},true);
  const incomplete=r.statusPending===true||r.receiptError||r.indexError;
  return result(r.ok?(input.action==='get'?'候选详情已读取。':incomplete?'正式卡提交状态：'+(r.committed?'已提交':'未确认')+'；候选/收据/索引尚需恢复，请查看details。':'候选操作完成：'+input.action+'。审查说明由调用者声明，不是知识认证。'):(r.committed?'卡片已提交，但候选/索引收尾未完成：':'候选操作未完成：')+String(r.error||r.code||'unknown'),r,!r.ok);
 }catch(e){return result('候选操作失败：'+String(e?.code||e?.message||e).slice(0,240),{code:'VERIFY_ERROR'},true);}
}
