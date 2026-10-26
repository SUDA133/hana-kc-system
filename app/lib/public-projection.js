// KC5 public snapshots: HC availability is independent of KC review health.
import {readReviewQueue} from './pending-store.js';
import {noteFailure,noteSuccess} from './runtime-health.js';
export const SP_APP_ID='hana-superpowers',SP_PENDING_KEY='pending-kc',KC_REVIEW_KEY='review-pending';
const unavailable = (error) => ({ok:false,available:false,total:null,returned:0,truncated:false,items:[],error});
const plain = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const controls = /[\u0000-\u001f\u007f]/;
const field = (value, max) => value == null || (typeof value === 'string' && value.length <= max && !controls.test(value));
let sdk=null,generation=0,readSequence=0,chain=Promise.resolve(),hc=unavailable('not-refreshed');
export function setProjectionSdk(value){sdk=value||null;generation++;readSequence++;hc=unavailable('not-refreshed');}
export function getHcSnapshot(){return structuredClone(hc);}
export async function refreshInstallQueueFrom(source=sdk){
 const gen=generation,request=++readSequence;
 const current=()=>gen===generation&&request===readSequence;
 const superseded=()=>({...getHcSnapshot(),skipped:true,reason:'snapshot request superseded'});
 try{
  if(typeof source?.publicData?.get!=='function')throw new Error('publicData unavailable');
  const env=await source.publicData.get({appId:SP_APP_ID,key:SP_PENDING_KEY}),d=env?.data;
  if(!current())return superseded();
  if(env?.schemaVersion!==1||!plain(d)||!Array.isArray(d.items)||d.items.length>200||d.ok!==true)throw new Error('HC snapshot unreadable or unsupported');
  if(d.items.some(x=>!plain(x)||typeof x.name!=='string'||!x.name||x.name.length>200||controls.test(x.name)||!field(x.time,64)||!field(x.by,200)))throw new Error('HC snapshot invalid items');
  const total=d.total===undefined?d.items.length:d.total;
  if(!Number.isSafeInteger(total)||total<d.items.length)throw new Error('HC snapshot invalid total');
  if(d.returned!==undefined&&d.returned!==d.items.length)throw new Error('HC snapshot invalid returned');
  if(d.truncated!==undefined&&typeof d.truncated!=='boolean')throw new Error('HC snapshot invalid truncated');
  hc={ok:true,available:true,total,returned:d.items.length,truncated:d.truncated===true||total>d.items.length,items:d.items.map(x=>({name:x.name,time:x.time??null,by:x.by??null})),updatedAt:env.updatedAt||null,error:null};
  noteSuccess('hc-snapshot');return getHcSnapshot();
 }catch(e){
  if(!current())return superseded();
  hc=unavailable(String(e?.code||e?.message||e).slice(0,240));noteFailure('hc-snapshot',e);return getHcSnapshot();
 }
}
export function publishReviewSummary(source=sdk){const gen=generation;const run=chain.then(async()=>{
 try{
  if(typeof source?.publicData?.publish!=='function')throw new Error('publicData publish unavailable');
  const q=readReviewQueue();let candidates=null;try{const C=await import('./candidate-store.js');candidates=await C.listCandidates({limit:50,status:'pending'});}catch(e){candidates={ok:false,error:String(e?.message||e),items:[],total:null};}
  const items=q.ok?q.items.slice(0,50).map(x=>({name:x.name,reason:x.reason||null,addedAt:x.addedAt||null})):[];
  const data={ok:q.ok,total:q.ok?q.items.length:null,returned:items.length,count:items.length,truncated:q.ok?q.items.length>items.length:false,items,candidates:{ok:candidates.ok,total:candidates.total,returned:candidates.items?.length||0,truncated:!!candidates.truncated,...(!candidates.ok?{error:candidates.error||'candidate snapshot incomplete',diagnostics:(candidates.diagnostics||[]).slice(0,10)}:{})},error:q.error||null};
  if(gen!==generation)return{ok:false,skipped:true,error:'projection generation changed'};
  await source.publicData.publish({key:KC_REVIEW_KEY,schemaVersion:1,title:'KC 待审知识摘要',description:'知识候选和旧待核验独立统计；未审项不阻断普通工作',data});
  if(gen===generation){if(data.ok&&candidates.ok)noteSuccess('review-projection');else noteFailure('review-projection',data.error||candidates.error||'candidate snapshot incomplete');}
  return{ok:true,businessOk:data.ok&&candidates.ok,total:data.total,count:items.length,truncated:data.truncated};
 }catch(e){if(gen===generation)noteFailure('review-projection',e);return{ok:false,error:String(e?.code||e?.message||e).slice(0,240)};}
 },async()=>({ok:false,error:'previous publication failed'}));chain=run.catch(()=>{});return run;}
