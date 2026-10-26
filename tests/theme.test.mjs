import test from 'node:test';
import assert from 'node:assert/strict';
import { createThemeController } from '../app/ui/theme.js';
function fixture({ saved = null, getDelay, fetchTheme, failSave = false } = {}) {
  let listener; const attrs = {}, styles = [], writes = []; const select = { value: '', title: '', addEventListener(_n, fn) { this.change = fn; }, removeEventListener() {} };
  const root = { dataset: {}, style: {} };
  const document = { documentElement: root, head: { appendChild(n) { styles.push(n); } }, createElement() { return { textContent: '', setAttribute() {}, remove() { const i=styles.indexOf(this); if(i>=0)styles.splice(i,1); } }; } };
  const sdk = { theme: { subscribe(fn) { listener=fn; fn({ theme:'custom',appearance:'dark',cssUrl:'host-dark',palettes:{light:{theme:'paper',cssUrl:'host-light'},dark:{theme:'custom',cssUrl:'host-dark'}} }); return ()=>{}; } }, storage: { global: { async get() { if(getDelay)await getDelay; return { value:saved }; }, async set(k,v) { if(failSave)throw new Error('storage unavailable');writes.push(v);return {ok:true}; } } } };
  const controller = createThemeController({ sdk, document, select, fetchCss: fetchTheme || (async url => '/* '+url+' */'), systemDark: () => false });
  return { controller, select, root, styles, writes, host: v=>listener(v), attrs };
}
const settle=()=>new Promise(r=>setImmediate(r));
test('default follows host appearance and exact issued palette', async()=>{
 const f=fixture();await f.controller.start();await settle();assert.equal(f.select.value,'system');assert.equal(f.root.dataset.kcAppearance,'dark');assert.ok(f.styles[0].textContent.includes('host-dark'));
});
test('light and dark use host-issued palettes, system resumes live theme', async()=>{
 const f=fixture();await f.controller.start();await f.controller.setPreference('light');assert.equal(f.root.dataset.kcAppearance,'light');assert.ok(f.styles[0].textContent.includes('host-light'));assert.equal(f.writes.at(-1),'light');
 f.host({appearance:'dark',cssUrl:'custom-new',palettes:{light:{theme:'paper',cssUrl:'new-light'},dark:{theme:'dark',cssUrl:'new-dark'}}});await settle();assert.equal(f.root.dataset.kcAppearance,'light');assert.ok(f.styles[0].textContent.includes('new-light'));
 await f.controller.setPreference('dark');assert.equal(f.root.dataset.kcAppearance,'dark');await f.controller.setPreference('system');assert.ok(f.styles[0].textContent.includes('custom-new'));
});
test('saved choice restores and stale storage read cannot undo a user choice', async()=>{
 const restored=fixture({saved:'light'});await restored.controller.start();await settle();assert.equal(restored.select.value,'light');
 let release;const gate=new Promise(r=>release=r);const f=fixture({saved:'dark',getDelay:gate});const ready=f.controller.start();await f.controller.setPreference('light');release();await ready;assert.equal(f.select.value,'light');
});
test('late stylesheet does not overwrite a newer preference',async()=>{
 let release;const gate=new Promise(r=>release=r);const f=fixture({fetchTheme:async url=>{if(url==='host-light')await gate;return url;}});await f.controller.start();const slow=f.controller.setPreference('light');await f.controller.setPreference('dark');release();await slow;assert.equal(f.root.dataset.kcAppearance,'dark');assert.equal(f.styles[0].textContent,'host-dark');
});
test('old hosts and failed palette fetch fall back without dark tokens leaking into light',async()=>{
 const f=fixture({fetchTheme:async()=>{throw new Error('offline');}});await f.controller.start();await f.controller.setPreference('light');assert.equal(f.root.dataset.kcAppearance,'light');assert.equal(f.styles.length,0);
 f.host({cssUrl:'old-host'});await settle();assert.equal(f.root.dataset.kcAppearance,'light');assert.equal(f.styles.length,0);
});
test('save failure keeps working selection and announces session-only choice',async()=>{
 const f=fixture({failSave:true});await f.controller.start();await f.controller.setPreference('light');assert.equal(f.select.value,'light');assert.ok(f.select.title.includes('本次'));assert.equal(f.root.dataset.kcAppearance,'light');
});
