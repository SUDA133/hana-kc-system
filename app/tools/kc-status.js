import fs from 'node:fs';
import {APP_VERSION} from '../lib/version.js';
import {INDEX_FILE,APP_DATA_DIR} from '../lib/jsonl-io.js';
import {readRepository} from '../lib/repository.js';
import {readLifecycle} from '../lib/lifecycle.js';
import {readMode} from '../lib/config-mode.js';
import {healthSnapshot} from '../lib/runtime-health.js';
import {refreshInstallQueueFrom} from '../lib/public-projection.js';
export const name='kc-status';
export const description='只读查看KC5知识库、生命周期、候选、锁、能力与HC快照诊断；不清理、不恢复或重建。';
export const parameters={type:'object',properties:{}};
export async function execute(_input={},ctx={}){
 const repo=readRepository({includeInactive:true}),lifecycle=readLifecycle();let candidates={ok:false,total:null,error:'not loaded'},lock={state:'unknown'},capabilities={status:'unknown'};
 try{const C=await import('../lib/candidate-store.js');candidates=await C.listCandidates({limit:1});}catch(e){candidates.error=String(e?.code||e?.message||e).slice(0,200);}
 try{const L=await import('../lib/data-lock.js');lock=L.inspectDataLock();}catch(e){lock.error=String(e?.message||e).slice(0,200);}
 try{if(ctx.getCapabilities){capabilities={status:'ledger-only',rows:await ctx.getCapabilities(),note:'successful permission-ledger read is not agent activation or execution verification'};}}catch(e){capabilities={status:'unavailable',error:String(e?.code||e?.message||e).slice(0,200)};}
 let index={status:'missing'};try{const x=JSON.parse(fs.readFileSync(INDEX_FILE,'utf8'));index={status:x&&typeof x==='object'&&!Array.isArray(x)&&x.allCards?'available':'invalid',note:'rebuildable acceleration metadata; query uses formal shards'};}catch(e){index={status:e.code==='ENOENT'?'missing':'corrupt',note:'query can scan formal shards'};}
 const hc=await refreshInstallQueueFrom(),runtime=healthSnapshot();
 const details={version:APP_VERSION,legacyMode:await readMode(),modeAffectsOrdinaryTools:false,policyVersion:5,ordinaryToolGate:false,autoPublication:false,agentActivation:'unknown',repository:{ok:repo.ok,complete:repo.complete,total:repo.total,snapshotId:repo.snapshotId,diagnostics:repo.diagnostics},lifecycle:{ok:lifecycle.ok,revision:lifecycle.revision,error:lifecycle.error||null},candidates:{ok:candidates.ok,total:candidates.total,diagnostics:candidates.diagnostics||[],error:candidates.error||null},lock,index,hc,runtime,capabilities,dataDir:APP_DATA_DIR};
 return{content:[{type:'text',text:['# KC System · 知识与健康状态','策略：辅助检索与候选审核，不设普通工具全局门；自动捕获不发布正式卡。','正式库：'+(repo.complete?'complete':'incomplete')+'，记录数：'+String(repo.total??'unknown'),'生命周期：'+(lifecycle.ok?'available':'unavailable'),'候选：'+(candidates.ok?String(candidates.total):'unavailable'),'运行观察：'+runtime.status+'；注册不等授权或全部路径生效','HC快照：'+(hc.ok?'available':'unavailable')+'（不影响KC库与审核）','索引：'+index.status+'；当前Agent激活：unknown','锁：'+String(lock.state||lock.status||'unknown'),'知识内容不认证；legacy-unverified不表示已核有效。'].join('\n')}],details,isError:false};
}
