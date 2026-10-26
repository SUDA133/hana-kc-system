// Theme state is separate from knowledge state. Consume only the CSS URLs the
// host publishes; explicit appearance never inherits the other face's tokens.
const KEY = 'kc.theme.preference';
const choices = new Set(['system', 'light', 'dark']);
export function createThemeController({ sdk, document, select, fetchCss = async url => {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) throw new Error('Theme stylesheet unavailable');
  return response.text();
}, systemDark = () => globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches === true, status = null }) {
  const root = document.documentElement;
  let preference = 'system', snapshot = {}, selectionRevision = 0, renderRevision = 0;
  let style = null, unsubscribe, stopped = false, writeChain = Promise.resolve();
  let paletteWarning = '', saveWarning = '';
  function hint() {
    const warning = [paletteWarning, saveWarning].filter(Boolean).join('。');
    select.title = ['主题：跟随 Hana、浅色或深色', warning].filter(Boolean).join('。');
    if (status) { status.textContent = warning; status.hidden = !warning; }
  }
  async function apply() {
    const revision = ++renderRevision;
    const appearance = preference === 'system' ? (snapshot.appearance || (systemDark() ? 'dark' : 'light')) : preference;
    root.dataset.kcAppearance = appearance;
    root.dataset.kcTheme = preference;
    root.style.colorScheme = appearance;
    select.value = preference;
    const palette = preference === 'system' ? snapshot : snapshot.palettes?.[preference];
    // Older hosts can supply only the current stylesheet. Reuse it only if its
    // declared appearance agrees with the requested mode, otherwise use fallback.
    const cssUrl = palette?.cssUrl || (snapshot.appearance === appearance ? snapshot.cssUrl : null);
    if (style) { style.remove(); style = null; }
    paletteWarning = ''; hint();
    if (!cssUrl) { root.dataset.kcThemeStatus = 'fallback'; return; }
    root.dataset.kcThemeStatus = 'loading';
    try {
      const css = await fetchCss(cssUrl);
      if (stopped || revision !== renderRevision) return;
      style = document.createElement('style'); style.setAttribute('data-kc-theme-style', '');
      style.textContent = css; document.head.appendChild(style);
      root.dataset.kcThemeStatus = 'host';
    } catch {
      if (stopped || revision !== renderRevision) return;
      root.dataset.kcThemeStatus = 'fallback'; paletteWarning = '宿主配色暂不可读取，已使用对应明暗的备用配色'; hint();
    }
  }
  async function setPreference(value) {
    if (!choices.has(value) || stopped) return;
    ++selectionRevision; preference = value; saveWarning = '';
    const rendering = apply();
    // Serialize saves so a late old write cannot replace the newest selection.
    const writing = writeChain.then(async () => {
      try { await sdk.storage.global.set(KEY, value, { timeoutMs: 2000 }); }
      catch { if (preference === value) { saveWarning = '偏好未能保存，本次打开仍可使用'; hint(); } }
    });
    writeChain = writing.catch(() => {});
    await Promise.all([rendering, writing]);
  }
  const onChange = () => { void setPreference(select.value); };
  async function start() {
    select.addEventListener('change', onChange);
    unsubscribe = sdk.theme.subscribe(value => { snapshot = value || {}; void apply(); });
    const revision = selectionRevision;
    try {
      const stored = await sdk.storage.global.get(KEY, { timeoutMs: 2000 });
      if (!stopped && revision === selectionRevision && choices.has(stored?.value)) { preference = stored.value; await apply(); }
    } catch { /* Appearance remains usable when older hosts lack App storage. */ }
  }
  function dispose() { stopped = true; ++renderRevision; unsubscribe?.(); select.removeEventListener('change', onChange); style?.remove(); }
  return { start, setPreference, dispose };
}
