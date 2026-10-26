// KC5: no global workflow gate. Automatic collection can only create unpublished candidates.
import {routeToolResult} from './archive-router.js';
import {noteFailure,noteSuccess,noteRegistration} from './runtime-health.js';
export const NO_OPINION=Object.freeze({});
export async function registerHooks(sdk){
 const receipts=[],failures=[];
 async function register(word,fn){try{const receipt=await sdk.hooks.onDecision(word,fn);receipts.push({word,receipt});noteRegistration(word,true);}catch(e){failures.push({word,error:String(e?.message||e)});noteRegistration(word,false,e);}}
 await register('tools/pre-execute',async()=>{noteSuccess('hook:tools/pre-execute');return NO_OPINION;});
 await register('agent/before-start',async()=>{noteSuccess('hook:agent/before-start');return NO_OPINION;});
 await register('tools/post-execute',async(payload={})=>{
  try{
   if(payload.isError)return NO_OPINION;
   let capture=true;try{if(typeof sdk.config?.get==='function'){const v=await sdk.config.get('autoCapture');if(v!==undefined&&typeof v!=='boolean')throw new Error('autoCapture config must be boolean');capture=v!==false;noteSuccess('auto-capture-config');}}catch(e){noteFailure('auto-capture-config',e);capture=false;}
   if(!capture)return NO_OPINION;
   const out=await routeToolResult(payload);
   if(out.handled&&out.report?.ok===false)noteFailure('candidate-capture',out.report.error||out.report.diagnostics||'candidate capture incomplete');
   else noteSuccess('hook:tools/post-execute');
   if(out.handled&&typeof sdk.publicData?.publish==='function'){
    const {publishReviewSummary}=await import('./public-projection.js');await publishReviewSummary(sdk);
   }
  }catch(e){noteFailure('candidate-capture',e);}
  return NO_OPINION;
 });
 return{receipts,failures};
}
// Legacy diagnostic export remains explicit; it is not consulted by any gate.
export function reviewPendingExists(){return false;}
