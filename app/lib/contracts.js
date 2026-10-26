// Public v2 hook shape adapter. It never replaces host session identity.
import path from 'node:path';
export const object = v => !!v && typeof v === 'object' && !Array.isArray(v);
export const normName = v => String(v || '').trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
export const isWrapper = n => /^(?:(?:core|functions)[.-])?(?:tool-call|mcp-call)$/.test(normName(n));
export function effectiveCall(ev = {}) {
  const outer = ev.toolName;
  let name = outer, input = object(ev.input) ? ev.input : {}, malformed = false;
  if (isWrapper(outer)) {
    const args = ev.input?.arguments ?? ev.input?.args;
    if (typeof ev.input?.tool === 'string' && ev.input.tool.trim() && object(args)) {
      name = ev.input.tool.trim(); input = args;
    } else malformed = true;
  }
  return { name, input, malformed, outer, sessionPath: ev.session?.sessionPath || null, sessionId: ev.session?.sessionId || null, signal: ev.signal };
}
export function effectiveResultName(ev = {}) {
  if (isWrapper(ev.toolName) && typeof ev.details?.bridgedTool?.name === 'string') return ev.details.bridgedTool.name;
  return ev.toolName;
}
export function isGateManagement(name, input = {}) {
  const n = normName(name), id = String(input.id || input.pluginId || input.plugin_id || '').replace(/^app:/,'').toLowerCase();
  if (!['kc-system','hana-superpowers'].includes(id)) return false;
  if (n === 'extension-manager') return input.kind === 'app' && ['disable','remove'].includes(input.action);
  return ['plugin-dev-disable','plugin-dev-uninstall','plugin-dev-reset'].includes(n);
}
const READ = new Set(['read','ls','grep','find','web-search','web-fetch','current-status','ui-inspect','tool-help','tool-search',
  'kc-query','kc-check','kc-stats','sp-status','sp-kc-inject','sp-review-aggregate','kc-system-knowledge-query','kc-system-check-kc','kc-system-knowledge-stats']);
export function isReadonly(name, input = {}) {
  const n = normName(name);
  if (READ.has(n)) return true;
  if (n === 'file') return ['stat','extract'].includes(input.action);
  if (n === 'kc-verify' || n === 'kc-system-kc-verify') return input.action === 'list';
  if (n === 'extension-manager') return ['list','inspect','search','export','status'].includes(input.action);
  return false;
}
export function commandTexts(input = {}) {
  return ['cmd','command','code','script','chars'].map(k=>input[k]).filter(v=>typeof v==='string' && v.trim());
}
export function writeDestinations(name, input = {}) {
  const out = []; const add = v => { if (typeof v === 'string' && v) out.push(v); };
  const t = object(input.target) ? input.target : {};
  const paths = [input.targetPath,t.path,t.targetPath].filter(v=>typeof v==='string' && v);
  const dirs = [input.targetDir,t.dir,t.targetDir].filter(v=>typeof v==='string' && v);
  const names = [input.filename,t.filename].filter(v=>typeof v==='string' && v);
  const copy = normName(name) === 'file' && input.action === 'copy';
  if (!copy) { [input.path,input.filePath,input.destination,input.dest,input.resource?.path,input.ref?.path].forEach(add); if(typeof input.target==='string')add(input.target); }
  paths.forEach(add);
  for(const dir of dirs) { if(names.length) for(const file of names)add(path.join(dir,file).replace(/\\/g,'/')); else add(dir); }
  return [...new Set(out)];
}
export function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(x=>x?.type==='text').map(x=>x.text || '').join('\n');
  if (typeof content?.text === 'string') return content.text;
  if (content?.content) return resultText(content.content);
  return '';
}
export function textResult(text, details) { return { content:[{type:'text',text:String(text)}], ...(details ? {details} : {}) }; }
