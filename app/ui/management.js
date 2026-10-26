// Single-card human controls. Uses the already-read identity/digest/revision;
// confirmation never substitutes a newer server version behind the reader.
const LABELS = {archive:'归档',restore:'恢复可用',deprecate:'停用',expire:'标为已过期','set-expiry':'设置有效期','clear-expiry':'清除有效期',delete:'删除'};
const HELP = {
 archive:'收起此卡，退出默认检索，保留正文，之后可恢复。',
 restore:'恢复为可用，并清除过期日期与旧替代关系；不代表内容已核验。',
 deprecate:'停止默认取用此卡，保留内容与停用原因。',
 expire:'将有效期设为现在之前，立即退出默认检索。',
 'set-expiry':'设置截止时刻，到期后自动退出默认检索；时间以本机时区填写。',
 'clear-expiry':'移除截止时间；归档或停用状态会继续保留。',
 delete:'从正式库移除此卡。删除前保存备份，页面暂不提供一键还原。'
};
function node(tag,text,cls){const n=document.createElement(tag);if(text!=null)n.textContent=String(text);if(cls)n.className=cls;return n;}
function btn(text,fn,cls='quiet'){const b=node('button',text,cls);b.type='button';b.addEventListener('click',fn);return b;}
export function mountManagement({target,view,api,request,isCurrent,setBusy,onChanged}) {
 const card=view.card;
 const box=node('details',null,'manage-box');box.id='manage-box';box.append(node('summary','管理这张 KC'));
 if(!view.canManage){box.append(node('p','目标记录、生命周期或正式库有诊断，暂不能管理。请重新读取或查看运行状态。','hint'));target.append(box);return;}
 const form=node('fieldset');form.className='manage-fields';
 const actionLabel=node('label','操作');actionLabel.htmlFor='manage-action';
 const action=node('select');action.id='manage-action';
 const order=card.lifecycle?.status==='archived'?['restore','archive','deprecate','set-expiry','expire','clear-expiry','delete']:['archive','deprecate','restore','set-expiry','expire','clear-expiry','delete'];
 for(const value of order){if((value==='archive'&&card.lifecycle?.status==='archived')||(value==='deprecate'&&card.lifecycle?.status==='deprecated'))continue;const o=node('option',LABELS[value]);o.value=value;action.append(o);}
 const help=node('p',HELP[action.value],'hint');help.id='manage-help';
 const dateLabel=node('label','有效期至（本机时间）');dateLabel.htmlFor='manage-date';
 const date=node('input');date.type='datetime-local';date.id='manage-date';date.step='60';
 const dateWrap=node('div');dateWrap.append(dateLabel,date);dateWrap.hidden=true;
 const reasonLabel=node('label','操作说明');reasonLabel.htmlFor='manage-reason';const reason=node('textarea');reason.id='manage-reason';reason.maxLength=500;reason.rows=2;reason.placeholder='记录归档、停用、修改日期或删除的原因…';
 const confirm=node('div');confirm.id='manage-confirm';const result=node('div');result.id='manage-result';result.setAttribute('role','status');
 let busy=false,locked=false;
 action.addEventListener('change',()=>{help.textContent=HELP[action.value];dateWrap.hidden=action.value!=='set-expiry';confirm.replaceChildren();result.replaceChildren();prepare.textContent=action.value==='delete'?'预览删除':'继续';prepare.className=action.value==='delete'?'quiet danger':'quiet';});
 const prepare=btn('继续',async()=>{
  if(busy||locked||!isCurrent())return;
  const why=reason.value.trim();if(!why){result.replaceChildren(node('p','请先填写操作说明。','result error'));return;}
  const payload={action:action.value,identity:card.identity,expectedDigest:card.contentDigest,expectedLifecycleRevision:view.lifecycleRevision,reason:why,confirm:true};
  if(payload.action==='set-expiry'){
   const time=new Date(date.value);if(!date.value||!Number.isFinite(time.getTime())||time.getTime()<=Date.now()){result.replaceChildren(node('p','请选择未来的有效期截止时刻。','result error'));return;}
   payload.validUntil=time.toISOString();
  }
  if(payload.action==='delete'){
   busy=true;setBusy(true);form.disabled=true;
   try{
    const preview=await api('/ui/delete-preview?'+new URLSearchParams({identity:card.identity}));
    if(!isCurrent())return;
    if(preview.contentDigest!==payload.expectedDigest||preview.lifecycleRevision!==payload.expectedLifecycleRevision)throw new Error('目标或生命周期已变化，请重新读取卡片后再决定。');
   }catch(e){result.replaceChildren(node('p',e.message||String(e),'result error'));return;}
   finally{busy=false;setBusy(false);form.disabled=false;}
  }
  if(!isCurrent())return;
  const panel=node('div',null,'confirm');panel.append(node('strong',`确认${LABELS[payload.action]}？`),node('p',`${card.summary || card.id}\n${card.identity}`,'identity'),node('p',HELP[payload.action]));
  if(payload.validUntil)panel.append(node('p','截止时刻：'+new Date(payload.validUntil).toLocaleString()));
  if(payload.action==='delete')panel.append(node('p','已完成只读预览。删除前会备份并校验原文，仅删除上述 Agent 的这一张卡。'));
  const actions=node('div',null,'actions');actions.append(btn('确认'+LABELS[payload.action],()=>submit(payload),payload.action==='delete'?'quiet danger':'primary'),btn('返回修改',()=>confirm.replaceChildren()));panel.append(actions);confirm.replaceChildren(panel);result.replaceChildren();
 });prepare.id='manage-prepare';
 async function submit(payload){
  if(busy||locked||!isCurrent())return;busy=true;setBusy(true);form.disabled=true;confirm.replaceChildren();result.replaceChildren(node('p','正在提交，请稍候…','result'));
  let success=false,message='';
  try{
   const response=await request('/ui/manage',{method:'POST',headers:{'Content-Type':'application/json','X-KC-UI':'1'},body:JSON.stringify(payload)});
   const r=await response.json();if(!isCurrent())return;
   locked=true;
   if(r.committed&&r.partial){message='操作已提交，索引、读回或数据锁收尾有异常。请重新读取并核对诊断，勿重复执行。';}
   else if(response.ok&&r.ok){success=true;message=payload.action==='delete'?'KC 已删除，删除前备份已保存。':`已${LABELS[payload.action]}。`;}
   else {message=(r.error||r.code||'操作未完成')+'\n生命周期版本由全库共享，其它卡片操作也可能使当前页面过期。请重新读取后再决定。';}
   result.replaceChildren(node('p',message,'result'+(success?'':' error')));
  }catch(e){locked=true;message='暂时无法确认操作结果。请重新读取卡片核对，勿直接重试。\n'+(e.message||String(e));result.replaceChildren(node('p',message,'result error'));}
  finally{busy=false;setBusy(false);}
  if(success&&isCurrent())await onChanged({deleted:payload.action==='delete',message});
  else if(isCurrent())result.append(btn('读取最新卡片',()=>onChanged({deleted:false,message})));
 }
 form.append(actionLabel,action,help,dateWrap,reasonLabel,reason,prepare,confirm);box.append(form,result);target.append(box);
}
