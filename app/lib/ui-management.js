// Narrow single-card management adapter. Mutation authority and CAS remain in
// lifecycle/delete's locked transactions; page inputs never select file paths.
import { getCard } from './ui-api.js';
import { annotateLifecycle, readLifecycle } from './lifecycle.js';
import { isStrictIsoDateOrDateTime } from './lifecycle-schema.js';
import { execute as deleteCards } from '../tools/knowledge-delete.js';
const ACTIONS = new Set(['archive','restore','deprecate','expire','set-expiry','clear-expiry','delete']);
const fail = (code,error,extra={}) => ({ok:false,code,error,committed:false,...extra});
export function validateManagement(input) {
  if(!input||typeof input!=='object'||Array.isArray(input))return fail('INPUT_INVALID','管理参数必须是对象');
  const keys=['action','identity','expectedDigest','expectedLifecycleRevision','reason','validUntil','confirm'];
  if(Object.keys(input).some(k=>!keys.includes(k)))return fail('INPUT_INVALID','存在不支持的管理字段');
  if(!ACTIONS.has(input.action))return fail('ACTION_INVALID','不支持的卡片管理动作');
  if(input.confirm!==true)return fail('CONFIRM_REQUIRED','请在页面确认此操作');
  // agent 段允许受限 kebab-case（含连字符），与 lib 层 isValidAgent 同一形状规则；
  // 这里只做形状预筛，权威判定仍在 getCard/isValidAgent。
  if(typeof input.identity!=='string'||!/^([a-z0-9]+(?:-[a-z0-9]+)*)::([a-z0-9][a-z0-9-]*)$/.test(input.identity))return fail('IDENTITY_INVALID','需要明确的Agent与卡片身份');
  if(!/^[a-f0-9]{64}$/.test(input.expectedDigest||'')||!Number.isSafeInteger(input.expectedLifecycleRevision)||input.expectedLifecycleRevision<0)return fail('EXPECTATION_REQUIRED','缺少已读取的卡片版本，请重新读取');
  if(typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>500)return fail('REASON_REQUIRED','请填写1..500字的操作说明');
  if(input.action==='set-expiry') {
    if(!isStrictIsoDateOrDateTime(input.validUntil)||!input.validUntil.includes('T')||Date.parse(input.validUntil)<=Date.now())return fail('DATE_INVALID','有效期需为未来的明确日期时间');
  } else if(input.validUntil!==undefined)return fail('INPUT_INVALID','仅设置有效期时接受日期');
  return {ok:true};
}
export async function deletePreview({identity}={}) {
  const view=await getCard({identity});if(!view.ok)return view;
  if(!view.canManage)return fail('MANAGEMENT_UNAVAILABLE','正式库、生命周期或目标记录存在异常，暂停管理');
  const life=readLifecycle();
  if(!life.ok||!life.complete)return fail('LIFECYCLE_UNAVAILABLE','生命周期记录不可读，暂停删除预览');
  const referencedBy=Object.entries(life.entries).filter(([key,entry])=>key!==identity&&entry.supersededBy===view.card.identity).map(([key])=>key);
  if(referencedBy.length)return fail('TARGET_REFERENCED',`此卡被 ${referencedBy.length} 张旧卡作为替代目标引用，请先调整替代关系，或使用归档。`,{referencedBy});
  const r=await deleteCards({ids:[view.card.id],agent:view.card.agent,reason:'页面删除预览',dryRun:true});
  if(!r.details.ok)return r.details;
  return {ok:true,identity:view.card.identity,summary:view.card.summary,contentDigest:view.card.contentDigest,lifecycleRevision:view.lifecycleRevision,backupBeforeDelete:true};
}
export async function manageCard(input, context = {}) {
  const valid=validateManagement(input);if(!valid.ok)return valid;
  const view=await getCard({identity:input.identity});if(!view.ok)return view;
  if(view.lifecycleRevision!==input.expectedLifecycleRevision)return fail('REVISION_CONFLICT','生命周期记录已被其它卡片操作更新，请重新读取后再决定');
  if(view.card.contentDigest!==input.expectedDigest)return fail('DIGEST_MISMATCH','卡片正文已变化，请重新读取后再决定');
  if(!view.canManage)return fail('MANAGEMENT_UNAVAILABLE','正式库、生命周期或目标记录存在异常，暂停管理');
  const card=view.card;
  if(input.action==='delete') {
    // The caller context comes only from the host route, never from JSON input.
    const principalId=typeof context.principal?.principalId==='string'?context.principal.principalId.replace(/[\u0000-\u001f\u007f]/g,'').slice(0,200):null;
    const r=await deleteCards({ids:[card.id],agent:card.agent,reason:input.reason.trim(),confirm:true,expectedDigest:input.expectedDigest,expectedLifecycleRevision:input.expectedLifecycleRevision},{agentId:principalId?'ui:'+principalId:'unknown'});
    const d=r.details,committed=(d.removedCount||0)>0;
    return {...d,committed,partial:committed&&(!d.ok||!!d.indexError||!!d.lockReleaseWarnings?.length),
      backupBeforeDelete:true,...(d.ok?{message:'卡片已删除，删除前备份已保存。'}:{error:d.failures?.map(f=>f.error).join('；')||'删除未完成，请核对结果'})};
  }
  const old=card.lifecycle||{};
  const metadata={status:old.status==='legacy-unverified'?'active':old.status,sourceRefs:old.sourceRefs||[],scope:old.scope||{},verifiedAt:old.verifiedAt||null,validUntil:old.validUntil||null,supersededBy:old.supersededBy||null};
  if(input.action==='archive'){metadata.status='archived';metadata.supersededBy=null;}
  if(input.action==='deprecate'){metadata.status='deprecated';metadata.supersededBy=null;}
  if(input.action==='restore'){metadata.status='active';metadata.validUntil=null;metadata.supersededBy=null;}
  if(input.action==='expire')metadata.validUntil=new Date(Date.now()-1).toISOString();
  if(input.action==='set-expiry')metadata.validUntil=new Date(input.validUntil).toISOString();
  if(input.action==='clear-expiry')metadata.validUntil=null;
  const r=await annotateLifecycle({agent:card.agent,id:card.id,metadata,expectedRevision:input.expectedLifecycleRevision,expectedDigest:input.expectedDigest,reason:input.reason.trim()});
  return {...r,partial:r.committed===true&&(r.ok!==true||r.writeUnverified===true||!!r.lockReleaseWarning),identity:card.identity};
}
