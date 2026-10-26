import { createHanaAppUiSdk } from './assets/hana-ui.js';
import { createThemeController } from './theme.js';
import { mountManagement } from './management.js';
// This page selects host-issued palettes itself, so SDK auto-follow must not
// race with an explicit light/dark choice or reinsert the other face's tokens.
const hana = createHanaAppUiSdk({ followHostTheme: false });
const $ = id => document.getElementById(id);
const S = { view: 'cards', offset: 0, limit: 30, snapshot: '', next: null, items: [], selected: null, detail: null, listSeq: 0, detailSeq: 0, statusSeq: 0, busy: false, reviewLocked: false };
const lifeLabels = { active: '当前使用', 'legacy-unverified': '旧卡未核验', deprecated: '已停用（弃用）', superseded: '已停用（被替代）', archived: '已归档', expired: '已过期' };
const candidateLabels = { pending: '待审阅', publishing: '发布中', published: '已发布', rejected: '已驳回', conflict: '冲突', 'already-present': '内容已存在', 'published-superseded': '已被替代' };
function el(tag, text, cls) { const n = document.createElement(tag); if (text !== undefined && text !== null) n.textContent = String(text); if (cls) n.className = cls; return n; }
function button(text, fn, cls = 'quiet') { const b = el('button', text, cls); b.type = 'button'; b.addEventListener('click', fn); return b; }
function notice(text = '') { $('notice').textContent = text; $('notice').hidden = !text; }
function problem(error) { return error?.message || String(error); }
function empty(target, title, description, retry) { const box = el('div', null, 'empty'); box.append(el('span', '◇', 'empty-symbol'), el('h2', title), el('p', description)); if (retry) box.append(button('重新读取', retry)); target.replaceChildren(box); }
async function api(path, options = {}) {
  const r = await hana.api.fetch(path, { cache: 'no-store', ...options });
  let body; try { body = await r.json(); } catch { throw new Error('响应无法读取，请刷新后核对状态'); }
  if (!r.ok || body.ok === false) { const e = new Error(body.error || body.code || `请求失败 ${r.status}`); e.code = body.code; e.data = body; throw e; }
  return body;
}
function query(path, values) { const params = new URLSearchParams(); for (const [k, v] of Object.entries(values)) if (v !== '' && v !== null && v !== undefined) params.set(k, String(v)); return path + '?' + params; }
function cardHead(card, back = false) {
  const h = el('div', null, 'detail-head');
  if (back) h.append(button('返回', () => $('workspace').classList.remove('show-detail'), 'quiet back'));
  const t = el('div'); t.append(el('h2', card.summary || card.id || '无标题'), el('p', card.identity || `${card.agent}::${card.id}`, 'identity')); h.append(t); return h;
}
function warnings(parent, messages) { if (!messages?.length) return; const n = el('div', null, 'warning'); for (const m of messages) n.append(el('p', m)); parent.append(n); }
function metadata(parent, rows) { const dl = el('dl', null, 'metadata'); for (const [label, value] of rows) { if (value === null || value === undefined || value === '') continue; dl.append(el('dt', label), el('dd', typeof value === 'object' ? JSON.stringify(value, null, 2) : value)); } parent.append(dl); }
function lifecycleText(card) { const base = lifeLabels[card.lifecycle?.status] || card.lifecycle?.status || '状态未标注'; return card.expired ? (card.lifecycle?.status === 'archived' ? '已归档 · 已过期' : base + ' · 已过期') : base; }
function dateLabel(value) { const d = new Date(value); return Number.isFinite(d.getTime()) ? d.toLocaleString() : value; }
function renderCard(card, target, compact = false) {
  target.append(cardHead(card, !compact));
  const tags = el('div', null, 'tags'); tags.append(el('span', card.agent, 'badge agent'), el('span', lifecycleText(card), 'badge'));
  for (const keyword of card.keywords || []) tags.append(el('span', keyword, 'tag')); target.append(tags);
  warnings(target, card.warnings);
  target.append(el('div', card.content || '未提供正文', 'body-copy'));
  const lc = card.lifecycle || {};
  metadata(target, [['来源', card.source], ['来源参考', lc.sourceRefs?.join('\n')], ['适用范围', lc.scope && Object.keys(lc.scope).length ? lc.scope : null], ['核验声明日', lc.verifiedAt], ['有效期至', lc.validUntil ? dateLabel(lc.validUntil) : null], ['替代卡片', lc.supersededBy], ['状态说明', lc.reason], ['更新时间', card.lastUpdated]]);
  if (!compact && card.related?.length) {
    target.append(el('p', '关联卡片', 'section-label')); const links = el('div', null, 'links');
    for (const raw of card.related) { const identity = parseRelated(raw, card.agent); if (identity) links.append(button(raw, () => openCard(identity))); else links.append(el('span', raw, 'tag')); } target.append(links);
  }
  if (!compact && card.contentDigest) { const d = el('details'); d.append(el('summary', '内容版本摘要'), el('p', card.contentDigest, 'identity')); d.style.marginTop = '24px'; target.append(d); }
}
function parseRelated(raw, owner) {
  if (typeof raw !== 'string') return null;
  // 只接受可解析的 KC 身份，不打开任意 URL：agent 段必须是受限 kebab-case，id 段必须是 kebab-case。
  const AGENT = '[a-z0-9]+(?:-[a-z0-9]+)*';
  const ID = '[a-z0-9]+(?:-[a-z0-9]+)*';
  const full = raw.match(new RegExp(`^kc--(${AGENT})-+note-+(${ID})$`));
  if (full) return `${full[1]}::${full[2]}`;
  if (new RegExp(`^${AGENT}::${ID}$`).test(raw)) return raw;
  return new RegExp(`^${ID}$`).test(raw) ? `${owner}::${raw}` : null;
}
// Agent 筛选项来自当前库的 facets（目录发现结果），不维护任何固定名单。
// 首次加载时替换 index.html 里的占位选项；之后只在集合变化时重建，保留用户当前选择。
// 返回 true 表示当前选择因为分片消失被回落（调用方需按新选择重取列表，避免「筛选显示全部、列表却是旧 agent 的空结果」）。
function syncAgentOptions(agents) {
  const select = $('agent');
  if (!select || !agents) return false;
  const names = Object.keys(agents).sort();
  const wanted = ['all', ...names];
  const current = select.value || 'all';
  const existing = [...select.options].map(o => o.value);
  const same = existing.length === wanted.length && wanted.every((v, i) => existing[i] === v);
  if (!same) {
    select.replaceChildren();
    const all = el('option', '全部 Agent'); all.value = 'all'; select.append(all);
    for (const name of names) { const o = el('option', name); o.value = name; select.append(o); }
  }
  const next = wanted.includes(current) ? current : 'all';
  select.value = next;
  return next !== current;
}
function renderRows() {
  const list = $('list'); list.replaceChildren();
  if (!S.items.length) { empty(list, S.view === 'cards' ? '没有匹配的卡片' : '这里暂时没有候选', S.view === 'cards' ? '调整关键词或筛选范围后再试。' : '候选会在收集后出现在这里。'); return; }
  for (const row of S.items) {
    const key = S.view === 'cards' ? row.identity : row.candidateId;
    const b = button('', () => S.view === 'cards' ? openCard(key) : openCandidate(key), 'row' + (S.selected === key ? ' selected' : ''));
    b.setAttribute('aria-pressed', String(S.selected === key)); b.dataset.identity = key;
    b.append(el('p', row.summary || row.id || '诊断候选', 'row-title'), el('p', row.identity || row.candidateId, 'row-id'));
    const meta = el('div', null, 'row-meta'); meta.append(el('span', row.agent || row.kind || '诊断', 'badge agent'), el('span', S.view === 'cards' ? lifecycleText(row) : (candidateLabels[row.status] || row.status), 'badge')); b.append(meta); list.append(b);
  }
}
async function loadList(reset = false) {
  if (S.view === 'status') return loadStatus();
  if (reset) { S.offset = 0; S.snapshot = ''; }
  const seq = ++S.listSeq, view = S.view;
  $('prev').disabled = true; $('next').disabled = true; $('count').textContent = '正在读取…';
  try {
    const path = view === 'cards' ? query('/ui/cards', { q: $('search').value.trim(), agent: $('agent').value, status: $('lifecycle').value, offset: S.offset, limit: S.limit, snapshotId: S.snapshot }) : query('/ui/candidates', { status: $('candidate-status').value, offset: S.offset, limit: S.limit });
    const requestedAgent = view === 'cards' ? $('agent').value : 'all';
    const r = await api(path);
    if (seq !== S.listSeq || view !== S.view) return;
    S.items = r.items || []; S.next = r.nextOffset; S.snapshot = r.snapshotId || '';
    $('count').textContent = r.total === null ? `至少 ${r.lowerBound ?? S.items.length} 条（不完整）` : `${r.total} ${view === 'cards' ? '张卡片' : '个候选'}`;
    $('page').textContent = `第 ${Math.floor(S.offset / S.limit) + 1} 页`;
    $('prev').disabled = S.offset === 0; $('next').disabled = S.next === null || S.next === undefined;
    if (view === 'cards') { $('app').dataset.kcReady = 'true'; $('app').dataset.kcTotal = r.total === null ? 'unknown' : String(r.total); $('facets').textContent = r.facets ? `库内共 ${r.facets.statuses.all} 张\n默认可检索 ${r.facets.statuses.visible} 张` : ''; if (r.facets?.agents && syncAgentOptions(r.facets.agents) && requestedAgent !== 'all') { notice(`「${requestedAgent}」已不在当前卡片库中，已回到全部 Agent 重新读取。`); return loadList(true); } }
    renderRows();
    if (!r.complete) notice('当前结果不完整，不能作为全量记录。请查看运行状态中的诊断。');
    else if (r.diagnostics?.length && !$('notice').textContent) notice('存在非阻断诊断，可在运行状态查看；当前列表仍是完整结果。');
  } catch (e) {
    if (seq !== S.listSeq || view !== S.view) return;
    if (e.code === 'KC_SNAPSHOT_CHANGED') { notice('卡片库已发生变化，已返回第一页。'); return loadList(true); }
    $('count').textContent = '读取失败'; empty($('list'), '暂时无法读取', problem(e), () => loadList(true));
  }
}
function clearDetail() { S.selected = null; S.detail = null; S.detailSeq++; $('workspace').classList.remove('show-detail'); empty($('detail'), '从一张卡片开始', '选择一条记录，阅读内容、来源与适用范围。'); }
async function openCard(identity) {
  if (S.busy) return;
  const seq = ++S.detailSeq; S.selected = identity; S.detail = null; renderRows(); $('workspace').classList.add('show-detail'); empty($('detail'), '正在读取卡片', identity);
  try {
    const r = await api(query('/ui/card', { identity }));
    if (seq !== S.detailSeq || S.view !== 'cards' || S.selected !== identity) return;
    S.detail = r.card; $('detail').replaceChildren(); renderCard(r.card, $('detail'));
    mountManagement({ target: $('detail'), view: r, api, request: (path, init) => hana.api.fetch(path, init),
      isCurrent: () => seq === S.detailSeq && S.view === 'cards' && S.selected === identity,
      setBusy: value => { S.busy = value; },
      onChanged: async ({ deleted, message }) => { notice(message); if (deleted) clearDetail(); await loadList(true); if (!deleted) await openCard(identity); }
    });
  }
  catch (e) { if (seq === S.detailSeq) empty($('detail'), '卡片读取失败', problem(e), () => openCard(identity)); }
}
async function openCandidate(candidateId) {
  if (S.busy) return;
  const seq = ++S.detailSeq; S.selected = candidateId; S.detail = null; S.reviewLocked = false; renderRows(); $('workspace').classList.add('show-detail'); empty($('detail'), '正在读取候选', '读取候选及当前目标快照…');
  try {
    const r = await api(query('/ui/candidate', { candidateId }));
    if (seq !== S.detailSeq || S.view !== 'candidates' || S.selected !== candidateId) return;
    S.detail = r; renderCandidate(r);
  } catch (e) { if (seq === S.detailSeq) empty($('detail'), '候选读取失败', problem(e), () => openCandidate(candidateId)); }
}
function renderCandidate(r) {
  const target = $('detail'), c = r.candidate; target.replaceChildren();
  target.append(cardHead({ summary: c.proposed?.summary || '诊断候选', identity: c.identity }, true));
  target.append(el('p', `${candidateLabels[c.status] || c.status} · 候选版本 ${c.revision}`, 'hint'));
  warnings(target, ['发布与核验日期均为审阅者声明，请结合证据核对内容。', ...(!r.canReview ? ['当前正式库或目标卡片不完整，暂停发布。'] : [])]);
  const compare = el('div', null, 'compare'), left = el('section'), right = el('section'); left.append(el('p', '候选内容', 'section-label')); right.append(el('p', '当前正式卡片', 'section-label'));
  if (c.proposed) renderCard({ ...c.proposed, identity: c.identity, lifecycle: { status: 'pending' }, warnings: [] }, left, true); else left.append(el('pre', JSON.stringify(c.diagnostic || {}, null, 2)));
  if (r.target.exists && r.target.card) renderCard(r.target.card, right, true); else right.append(el('p', r.target.exists ? '目标不可安全读取' : '目标尚不存在，本次将新增卡片', 'hint'));
  compare.append(left, right); target.append(compare);
  metadata(target, [['候选ID', c.candidateId], ['创建时间', c.created], ['更新时间', c.updated], ['来源记录数', c.origins?.length ?? 0]]);
  if (c.origins?.length) { const origins = el('details'); origins.append(el('summary', '查看候选来源')); for (const origin of c.origins) origins.append(el('pre', JSON.stringify(origin, null, 2))); target.append(origins); }
  target.append(button('重新读取候选与目标', () => openCandidate(c.candidateId)));
  if (c.status !== 'pending' || !c.publishable) { target.append(el('p', '该候选当前不可发布；发布恢复与终态清理可通过既有 KC 工具处理。', 'hint')); return; }
  const form = el('div', null, 'review-form'); form.id = 'review-form';
  const label = el('label', '审阅说明（发布至少10字；驳回需填写理由）'); label.htmlFor = 'review-note';
  const note = el('textarea'); note.id = 'review-note'; note.maxLength = 500; note.placeholder = '写明核对了什么，以及发布或驳回的依据…';
  const actions = el('div', null, 'actions');
  const publish = button('发布为正式卡片', () => prepareReview('publish'), 'primary'); publish.id = 'publish'; publish.disabled = !r.canReview;
  const reject = button('驳回候选', () => prepareReview('reject'), 'quiet danger'); reject.id = 'reject';
  actions.append(publish, reject); form.append(label, note, actions); const confirm = el('div'); confirm.id = 'review-confirm'; form.append(confirm); const result = el('div'); result.id = 'review-result'; result.setAttribute('role', 'status'); form.append(result); target.append(form);
}
function prepareReview(action) {
  if (S.busy || S.reviewLocked || !S.detail?.candidate) return;
  const note = $('review-note').value.trim(), c = S.detail.candidate;
  if (note.length < (action === 'publish' ? 10 : 1)) { $('review-result').replaceChildren(el('p', action === 'publish' ? '请填写至少10字的审阅说明。' : '请填写驳回理由。', 'result error')); return; }
  const payload = { action, candidateId: c.candidateId, expectedRevision: c.revision, confirm: true, ...(action === 'publish' ? { expectedTargetDigest: S.detail.target.digest, reviewSummary: note } : { reason: note }) };
  const box = el('div', null, 'confirm'); box.append(el('p', action === 'publish' ? (S.detail.target.exists ? '确认用所审阅的候选内容更新目标卡片？目标版本变化时会拒绝提交。' : '确认将此候选发布为一张新的正式卡片？') : '确认驳回此候选？正式知识库内容不会修改。'));
  const actions = el('div', null, 'actions'); actions.append(button('确认' + (action === 'publish' ? '发布' : '驳回'), () => submitReview(payload), 'primary'), button('返回修改', () => $('review-confirm').replaceChildren())); box.append(actions); $('review-confirm').replaceChildren(box);
}
async function submitReview(payload) {
  if (S.busy || S.reviewLocked || S.selected !== payload.candidateId) return;
  S.busy = true; const candidateId = payload.candidateId;
  try {
    const form = $('review-form');
    if (!form) throw new Error('审阅面板已变化，请重新读取候选');
    for (const n of form.querySelectorAll('button,textarea')) n.disabled = true;
    $('review-result').replaceChildren(el('p', '正在提交，请稍候…', 'result')); $('review-confirm').replaceChildren();
    // Parse review responses even on non-2xx: committed can be true on a partial result.
    const response = await hana.api.fetch('/ui/review', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-KC-UI': '1' }, body: JSON.stringify(payload) });
    const r = await response.json();
    if (S.selected !== candidateId || S.view !== 'candidates') return;
    S.reviewLocked = true;
    const pending = r.partial || r.statusPending || r.indexError || r.receiptError;
    const message = r.committed && pending ? '正式卡片已提交，候选状态、收据或索引尚待收尾。请通过 KC 工具核对恢复，勿重复发布。' : r.ok === true && response.ok ? (payload.action === 'publish' ? '审阅处理完成。正式库与候选结果已返回。' : '候选已驳回。') : `${r.error || r.code || '审核未完成'}\n请重新读取候选与目标，核对变化后再决定。`;
    $('review-result').replaceChildren(el('p', message, 'result' + (r.ok ? '' : ' error')), button('读取最新结果', () => openCandidate(candidateId)));
    await loadList(true);
  } catch (e) {
    S.reviewLocked = true;
    if (S.selected === candidateId && $('review-result')) $('review-result').replaceChildren(el('p', '未能确认提交结果：' + problem(e) + '\n请读取最新结果后核对，勿直接重试发布。', 'result error'), button('读取最新结果', () => openCandidate(candidateId)));
  } finally { S.busy = false; }
}
async function loadStatus() {
  const seq = ++S.statusSeq; empty($('status-page'), '正在读取运行状态', '状态读取不会恢复锁或重建索引。');
  try {
    const r = await api('/ui/status'); if (seq !== S.statusSeq || S.view !== 'status') return;
    const target = $('status-page'); target.replaceChildren(); const heading = el('div', null, 'status-heading'); heading.append(el('h2', '运行状态'), el('span', `KC System ${r.version}`, 'badge')); target.append(heading);
    const grid = el('div', null, 'status-grid');
    const cells = [['正式知识库', r.repository.complete ? r.repository.total : '不完整', r.repository.complete ? '正式记录数量' : '存在诊断，请核对下方详情'], ['候选', r.candidates.ok ? r.candidates.total : '不可用', '包含各状态候选'], ['生命周期', r.lifecycle.ok ? '可读取' : '不可用', `修订 ${r.lifecycle.revision ?? '未知'}`], ['索引', r.index.status, '索引异常时检索可回退扫描'], ['数据锁', r.lock.state, r.lock.remedy || '只读诊断，不自动恢复'], ['运行观察', r.runtime.status, '注册与加载不等于所有路径验证通过'], ['HC 快照', r.hc.ok ? '可读取' : '不可用', '独立于正式库与候选审阅'], ['策略版本', String(r.policyVersion), '普通工具不受 KC 打卡门拦截']];
    for (const [label, value, hint] of cells) { const cell = el('div', null, 'status-cell'); cell.append(el('p', label), el('strong', value ?? '未知'), el('small', hint)); grid.append(cell); } target.append(grid);
    const diags = [...(r.repository.diagnostics || []), ...(r.candidates.diagnostics || [])];
    if (diags.length) { target.append(el('h3', '完整性诊断', 'section-label')); for (const d of diags) target.append(el('pre', JSON.stringify(d, null, 2))); }
    const health = r.runtime ? { components: r.runtime.components, registrations: r.runtime.registrations } : null; if (health) { const det = el('details'); det.append(el('summary', '查看运行观察明细'), el('pre', JSON.stringify(health, null, 2))); target.append(det); }
    target.append(el('p', '知识状态与热度均不构成内容认证。此页仅诊断，不执行重建、清锁或数据迁移。', 'hint'));
  } catch (e) { if (seq === S.statusSeq) empty($('status-page'), '运行状态读取失败', problem(e), loadStatus); }
}
function switchView(view) {
  if (S.busy) { notice('审核正在提交，请等候结果。'); return; }
  S.view = view; S.listSeq++; S.statusSeq++; clearDetail(); notice();
  for (const b of document.querySelectorAll('[data-view]')) { const active = b.dataset.view === view; b.classList.toggle('selected', active); b.setAttribute('aria-pressed', String(active)); }
  $('workspace').hidden = view === 'status'; $('status-page').hidden = view !== 'status'; $('filters').hidden = view !== 'cards'; $('search-form').hidden = view !== 'cards'; $('candidate-filter').hidden = view !== 'candidates'; $('search-hint').hidden = view !== 'cards'; $('clear').hidden = view !== 'cards';
  $('workspace').style.gridTemplateColumns = view === 'candidates' ? 'minmax(290px,34%) minmax(300px,1fr)' : '';
  if (view === 'status') loadStatus(); else loadList(true);
}
for (const b of document.querySelectorAll('[data-view]')) b.addEventListener('click', () => switchView(b.dataset.view));
$('search-form').addEventListener('submit', e => { e.preventDefault(); if (S.busy) return; clearDetail(); notice(); loadList(true); });
for (const id of ['agent', 'lifecycle', 'candidate-status']) $(id).addEventListener('change', () => { if (S.busy) return; clearDetail(); notice(); loadList(true); });
$('clear').addEventListener('click', () => { if (S.busy) return; $('agent').value = 'all'; $('lifecycle').value = 'visible'; $('search').value = ''; clearDetail(); notice(); loadList(true); });
$('refresh').addEventListener('click', () => { if (S.busy) return; notice(); if (S.view === 'status') loadStatus(); else { clearDetail(); loadList(true); } });
$('prev').addEventListener('click', () => { if (S.busy) return; clearDetail(); S.offset = Math.max(0, S.offset - S.limit); loadList(); });
$('next').addEventListener('click', () => { if (S.busy || S.next === null) return; clearDetail(); S.offset = S.next; loadList(); });
try {
  await hana.ready();
  const theme = createThemeController({ sdk: hana, document, select: $('theme-mode'), status: $('theme-notice') });
  void theme.start();
  window.addEventListener('pagehide', () => theme.dispose(), { once: true });
  await loadList(true);
} catch (e) { notice('KC 页面初始化失败：' + problem(e)); empty($('list'), '连接尚未就绪', '请从 Hana 的 KC 知识库页面入口打开。'); }
