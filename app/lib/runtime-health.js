// Process-local, bounded observations; registration is not permission or content certification.
const LIMIT=32;let entries=new Map(),registrations=new Map(),dropped=0,startedAt=new Date().toISOString();
const text=(v,max=240)=>{let s;try{s=String(v?.code||v?.message||v||'unknown');}catch{s='unreadable';}return s.length>max?s.slice(0,max-1)+'…':s;};
function put(map,key,value){key=text(key,96);if(map.has(key))map.delete(key);else if(map.size>=LIMIT){map.delete(map.keys().next().value);dropped++;}map.set(key,{...value,name:key});}
export function resetHealth(){entries=new Map();registrations=new Map();dropped=0;startedAt=new Date().toISOString();}
export function noteRegistration(name,ok,error){put(registrations,name,{ok:ok===true,at:new Date().toISOString(),error:ok===true?null:text(error)});}
export function noteFailure(name,error){put(entries,name,{ok:false,at:new Date().toISOString(),error:text(error)});}
export function noteSuccess(name){put(entries,name,{ok:true,at:new Date().toISOString(),error:null});}
export function healthSnapshot(){return{policyVersion:5,status:[...entries.values(),...registrations.values()].some(x=>!x.ok)||dropped?'degraded':entries.size?'ok':'unknown',startedAt,components:[...entries.values()].map(x=>({...x})),registrations:[...registrations.values()].map(x=>({...x})),dropped,history:'process-local last observation only'};}
export const snapshot=healthSnapshot;
