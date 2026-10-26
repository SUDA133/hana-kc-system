// lib/retrieval.js — KC5 single retrieval engine for kc_check / kc_query / HC search.
//
// 固定评分合同：exact keyword +4；keyword token 边界 +3；summary 完整子串 +1；
// 长词（>=4）去末字符 keyword 弱匹配 +0.25。每词只取最强项，不叠加；legacy score 不参与相关度。
import {
  isValidAgent,
  validateId,
} from './jsonl-io.js';
import { readRepository } from './repository.js';
import { isLifecycleExpired, legacyLifecycleEntry } from './lifecycle.js';

export const POLICY_VERSION = 5;
export const DEFAULT_LIMIT = 8;
export const MAX_LIMIT = 50;
export const MAX_KEYWORDS = 20;
export const MAX_KEYWORD_LENGTH = 100;
export const MAX_QUERY_LENGTH = 2000;

const plain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const textResult = (content, details, isError = false) => ({
  content: [{ type: 'text', text: content }],
  ...(isError ? { isError: true } : {}),
  details,
});
const baseDetails = (extra = {}) => ({
  code: 'OK', available: true, complete: true, total: 0, returned: 0, truncated: false,
  cards: [], snapshotId: '', diagnostics: [], policyVersion: POLICY_VERSION, ...extra,
});
function fail(code, message, extra = {}) {
  return textResult(`错误：${message}`, baseDetails({ code, available: false, complete: false, ...extra }), true);
}

export function normalizeLimit(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return { limit: DEFAULT_LIMIT, requestedAll: false, clamped: false };
  }
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return { limit: DEFAULT_LIMIT, requestedAll: false, clamped: false };
  }
  if (n === 0) return { limit: MAX_LIMIT, requestedAll: true, clamped: false };
  if (n < 0) return { limit: 1, requestedAll: false, clamped: true };
  if (n > MAX_LIMIT) return { limit: MAX_LIMIT, requestedAll: false, clamped: true };
  return { limit: n, requestedAll: false, clamped: false };
}

export function exactIdentity(raw, agent) {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('非法的卡片 id');
  const t = raw.trim();
  const parsed = parseIdentityText(t);
  const parsedAgent = parsed ? parsed.agent : null;
  const id = parsed ? parsed.id : t;
  if (agent && agent !== 'all' && parsedAgent && agent !== parsedAgent) throw new Error('agent 与 id 身份冲突');
  const owner = parsedAgent || (agent && agent !== 'all' ? agent : null);
  if (!owner) throw new Error('精确读取 bare id 需要明确 agent');
  if (!isValidAgent(owner) || !validateId(id)) {
    throw new Error(`非法的 agent 或卡片 id：${owner}::${id}`);
  }
  return { agent: owner, id, identity: `${owner}::${id}` };
}

/**
 * 从文本中解析 KC 身份，不做“默认归属”推断。
 * - `agent::id`：在第一个 `::` 处切开（agent 段不允许冒号，所以无歧义）
 * - `kc--agent-note--id`：在 `-note-` 分隔处切分；agent 自身可含连字符与 `-note-`，
 *   因此遍历所有可切分点，取**最长合法 agent**（最具体）且剩余段是合法 id 的那个。
 * - 其它形式返回 null（不是“猜一个归属”）。
 * @returns {{agent:string,id:string}|null}
 */
export function parseIdentityText(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if (!t) return null;
  const sep = t.indexOf('::');
  if (sep > 0) {
    const owner = t.slice(0, sep);
    const id = t.slice(sep + 2);
    return isValidAgent(owner) && validateId(id) ? { agent: owner, id } : null;
  }
  if (!t.startsWith('kc--')) return null;
  const body = t.slice(4);
  // 分隔符两侧允许任意多个连字符（单/双连字符历史写法都合法）：
  // 匹配每一个 `-+note-+` 出现位置作为候选切分点，而不是只认字面 `-note-`。
  const SEP = /-+note-+/g;
  let best = null;
  for (let m = SEP.exec(body); m; m = SEP.exec(body)) {
    const owner = body.slice(0, m.index);
    const id = body.slice(m.index + m[0].length);
    if (!isValidAgent(owner) || !validateId(id)) continue;
    if (!best || owner.length > best.agent.length) best = { agent: owner, id };
  }
  return best;
}

/**
 * 解析并校验关键词输入；返回去重后的 lower-case 词表。
 * @returns {{ok:true,terms:string[]}|{ok:false,error:string}}
 */
export function parseKeywordInput(raw) {
  let items;
  if (typeof raw === 'string') items = raw.split(/[,，\s]+/);
  else if (Array.isArray(raw)) {
    items = [];
    for (const part of raw) {
      if (typeof part !== 'string') return { ok: false, error: '关键词数组只能包含字符串' };
      items.push(...part.split(/[,，\s]+/));
    }
  } else return { ok: false, error: '关键词必须是字符串或字符串数组' };
  const terms = [];
  let total = 0;
  for (const item of items) {
    const t = item.trim().toLowerCase();
    if (!t) continue;
    if (t.length > MAX_KEYWORD_LENGTH) return { ok: false, error: `关键词单项超过 ${MAX_KEYWORD_LENGTH} 字符` };
    total += t.length;
    if (total > MAX_QUERY_LENGTH) return { ok: false, error: `关键词总长度超过 ${MAX_QUERY_LENGTH}` };
    if (!terms.includes(t)) terms.push(t);
  }
  if (terms.length === 0) return { ok: false, error: '请提供至少一个检索关键词' };
  if (terms.length > MAX_KEYWORDS) return { ok: false, error: `关键词最多 ${MAX_KEYWORDS} 项` };
  return { ok: true, terms };
}

function keywordTokens(keyword) {
  return keyword.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
}

/**
 * 可解释评分：每个词只取最强项，scoreParts 回传来源。
 * @returns {{score:number, parts:Array, matchedTerms:string[]}}
 */
export function scoreKnowledgeCard(card, terms) {
  const keywords = Array.isArray(card.keywords)
    ? card.keywords.map((k) => String(k).trim().toLowerCase()).filter(Boolean)
    : [];
  const tokens = keywords.flatMap(keywordTokens);
  const summary = typeof card.summary === 'string' ? card.summary.toLowerCase() : '';
  const parts = [];
  let score = 0;
  for (const term of terms) {
    let best = null;
    if (keywords.includes(term)) best = { term, kind: 'exact-keyword', weight: 4, source: 'keyword' };
    else if (term.length > 2 && tokens.includes(term)) best = { term, kind: 'keyword-token', weight: 3, source: 'keyword' };
    if (term.length > 2 && summary.includes(term) && (!best || best.weight < 1)) {
      best = { term, kind: 'summary-substring', weight: 1, source: 'summary' };
    }
    if (!best && term.length >= 4) {
      const partial = term.slice(0, -1);
      if (keywords.some((kw) => kw.includes(partial))) {
        best = { term, kind: 'keyword-prefix-weak', weight: 0.25, source: 'keyword' };
      }
    }
    if (best) { score += best.weight; parts.push(best); }
  }
  return { score, parts, matchedTerms: parts.map((p) => p.term) };
}

function scopeView(card, input) {
  const scope = card.lifecycle && card.lifecycle.scope ? card.lifecycle.scope : {};
  if (input.project && scope.project && scope.project !== input.project) return { exclude: true };
  const warnings = [];
  let requiresReview = false;
  if (scope.project && !input.project) {
    requiresReview = true;
    warnings.push(`该卡 scope.project=${scope.project}，未提供 project，需人工核对适用范围`);
  }
  if (scope.versionRange) {
    requiresReview = true;
    warnings.push(`该卡 scope.versionRange=${scope.versionRange}（文本约束，不做 semver 解析）`);
  }
  return { exclude: false, requiresReview, warnings };
}

function lifecycleWarnings(card, input, exact) {
  const warnings = [];
  let requiresReview = false;
  if (card.agentMismatch) warnings.push('卡内 agent 与分片物理身份不一致（仅审计）');
  if (card.duplicate) warnings.push('同身份存在重复记录（仅审计，精确读取拒绝歧义）');
  const lc = card.lifecycle || legacyLifecycleEntry();
  if (lc.status === 'legacy-unverified') warnings.push('生命周期未核验（legacy-unverified），可检索但不应视为已验证');
  if (lc.stale) warnings.push('侧车条目与当前内容 digest 不一致，已失效');
  if (lc.status === 'deprecated' || lc.status === 'superseded' || lc.status === 'archived') {
    warnings.push(`该卡 lifecycle=${lc.status}，默认检索不返回${exact ? '（精确审计可读）' : ''}`);
  }
  if (isLifecycleExpired(lc)) warnings.push('该卡已过 validUntil，默认检索不返回');
  const scoped = scopeView(card, input);
  if (scoped.exclude) return { exclude: true, warnings, requiresReview };
  warnings.push(...scoped.warnings);
  requiresReview = requiresReview || scoped.requiresReview;
  return { exclude: false, warnings, requiresReview };
}

// Shared read projection for model tools and the KC page; never records heat.
export function toResultCard(card, { mode, exact, input, scored }) {
  const gate = lifecycleWarnings(card, input, exact);
  return {
    agent: card.storageAgent,
    id: card.id,
    identity: card.identity,
    contentDigest: card.contentDigest || null,
    source: typeof card.source === 'string' ? card.source : null,
    name: `kc--${card.storageAgent}-note--${card.id}`,
    summary: typeof card.summary === 'string' ? card.summary : '',
    keywords: Array.isArray(card.keywords) ? card.keywords.slice(0, 30) : [],
    lastUpdated: card.lastUpdated || card.created || null,
    relevance: scored ? scored.score : 0,
    legacyScore: typeof card.score === 'number' ? card.score : 5,
    scoreParts: scored ? scored.parts : [],
    matchedTerms: scored ? scored.matchedTerms : [],
    lifecycle: card.lifecycle,
    requiresReview: gate.requiresReview,
    warnings: gate.warnings,
    ...(mode === 'detail' || exact ? { content: typeof card.content === 'string' ? card.content : '' } : {}),
  };
}

function lifecycleLabel(lc) {
  if (!lc) return 'unknown';
  const bits = [lc.status];
  if (lc.validUntil) bits.push(`validUntil=${lc.validUntil}`);
  if (lc.verifiedAt) bits.push(`verifiedAt=${lc.verifiedAt}`);
  return bits.join(' ');
}

function formatSearchText(title, cards, { mode, total, returned, complete, diagnostics }) {
  const lines = [title, ''];
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    lines.push(`${i + 1}. **${c.name}** (归属: ${c.agent}, 相关度: ${c.relevance.toFixed(2)})`);
    lines.push(`   卡片ID: ${c.id}`);
    lines.push(`   ${mode === 'detail' ? c.content || '(无全文)' : c.summary || '(无摘要)'}`);
    lines.push(`   关键词: ${c.keywords.join(', ')}`);
    lines.push(`   来源: ${c.source || '(未标注)'}`);
    lines.push(`   生命周期: ${lifecycleLabel(c.lifecycle)}${c.requiresReview ? '（需核对适用范围）' : ''}`);
    for (const w of c.warnings) lines.push(`   注意: ${w}`);
    lines.push('');
  }
  if (total > returned) lines.push(`（还有 ${total - returned} 张卡片未列出，如需请缩小关键词范围）`);
  if (!complete) lines.push('警告：数据不完整（见 diagnostics），以上结果不能称为全量。');
  if (diagnostics.length) lines.push(`诊断：${diagnostics.map((d) => d.code).join(', ')}`);
  if (mode === 'summary') {
    lines.push('---');
    lines.push('如需查看全文，请再调用一次 `kc_query` 并指定 mode=detail（可同时指定 agent/limit 收窄范围）。');
  }
  lines.push('注：来源/元数据为卡片自报，不构成认证；相关度与热度不代表知识正确或当前有效。');
  return lines.join('\n');
}

function formatExactText(card, mode) {
  const lines = [
    `**${card.identity}**`,
    `更新时间：${card.lastUpdated || '未知'}`,
    `生命周期：${lifecycleLabel(card.lifecycle)}`,
  ];
  for (const w of card.warnings) lines.push(`警告：${w}`);
  lines.push(`关键词：${card.keywords.join(', ')}`);
  lines.push(`来源：${card.source || '(未标注)'}；contentDigest：${card.contentDigest || '(不可用)'}`);
  lines.push(mode === 'detail' ? card.content || '(无全文)' : card.summary || '(无摘要)');
  lines.push('', '注：更新时间不等于当前有效；inactive/未核验状态不代表知识正确。');
  return lines.join('\n');
}

function validateInput(input) {
  if (!plain(input)) return { ok: false, error: 'input 必须是对象' };
  if (input.mode !== undefined && input.mode !== 'summary' && input.mode !== 'detail') {
    return { ok: false, error: 'mode 必须是 summary|detail' };
  }
  if (input.includeInactive !== undefined && typeof input.includeInactive !== 'boolean') {
    return { ok: false, error: 'includeInactive 必须是布尔值' };
  }
  if (input.agent !== undefined && input.agent !== 'all' && !isValidAgent(input.agent)) {
    return { ok: false, error: `agent 非法：${String(input.agent)}` };
  }
  if (input.limit !== undefined && (!Number.isInteger(input.limit))) {
    return { ok: false, error: 'limit 必须是整数（0 表示尽量取全部，上限 50）' };
  }
  for (const key of ['project', 'version']) {
    if (input[key] !== undefined && (typeof input[key] !== 'string' || !input[key].trim() || input[key].trim().length > 200)) {
      return { ok: false, error: `${key} 必须是非空字符串（<=200 字符）` };
    }
  }
  if (input.id !== undefined) {
    try { exactIdentity(input.id, input.agent); }
    catch (e) { return { ok: false, error: e.message }; }
  } else {
    const kw = parseKeywordInput(input.keywords);
    if (!kw.ok) return kw;
  }
  return { ok: true };
}

function scopeInput(input) {
  return {
    project: input.project === undefined ? undefined : input.project.trim(),
    version: input.version === undefined ? undefined : input.version.trim(),
  };
}

async function exactRead(input) {
  const identity = exactIdentity(input.id, input.agent);
  const repo = readRepository({ includeInactive: true });
  if (!repo.ok) return fail('DATA_UNAVAILABLE', '正式卡库不可读', { diagnostics: repo.diagnostics });
  const card = repo.cards.find((c) => c.identity === identity.identity);
  if (!card) {
    return textResult(`未找到卡片：${identity.identity}`, baseDetails({
      code: 'NO_MATCH', complete: repo.complete, snapshotId: repo.snapshotId, diagnostics: repo.diagnostics,
    }));
  }
  if (card.duplicate) return fail('AMBIGUOUS_TARGET', `同身份存在重复记录，精确读取拒绝歧义：${identity.identity}`, {
    snapshotId: repo.snapshotId, diagnostics: repo.diagnostics,
  });
  const resultCard = toResultCard(card, {
    mode: input.mode === 'summary' ? 'summary' : 'detail', exact: true, input: scopeInput(input), scored: null,
  });
  if (!repo.lifecycleOk) resultCard.warnings.push('生命周期侧车（lifecycle.json）不可用：本卡仅供精确审计，不能作为有效检索视图');
  if (!repo.complete) resultCard.warnings.push('正式库存在完整性诊断，本次精确读取只覆盖目标卡');
  return textResult(formatExactText(resultCard, input.mode === 'summary' ? 'summary' : 'detail'), baseDetails({
    complete: repo.complete, total: 1, returned: 1, cards: [resultCard],
    snapshotId: repo.snapshotId, diagnostics: repo.diagnostics,
  }));
}

function searchByKeywords(input, repositoryReader = readRepository) {
  const parsed = parseKeywordInput(input.keywords);
  if (!parsed.ok) return fail('INPUT_INVALID', parsed.error);
  const repo = repositoryReader({ includeInactive: input.includeInactive === true });
  if (!repo.ok) {
    return fail('DATA_UNAVAILABLE', '正式卡库不可读', { diagnostics: repo.diagnostics });
  }
  if (!repo.lifecycleOk) {
    return fail('LIFECYCLE_UNAVAILABLE', '生命周期侧车损坏或不可用；精确 id 仍可审计单卡，但本结果不能作为有效检索视图', {
      complete: false, snapshotId: repo.snapshotId, diagnostics: repo.diagnostics,
    });
  }
  const agentFilter = input.agent && input.agent !== 'all' ? input.agent : null;
  const scope = scopeInput(input);
  const scored = [];
  for (const card of repo.cards) {
    if (card.agentMismatch || card.duplicate) continue;
    if (agentFilter && card.storageAgent !== agentFilter) continue;
    const gate = lifecycleWarnings(card, scope, false);
    if (gate.exclude) continue;
    const s = scoreKnowledgeCard(card, parsed.terms);
    if (s.score <= 0) continue;
    scored.push({ card, score: s });
  }
  scored.sort((a, b) => (b.score.score - a.score.score)
    || (a.card.identity < b.card.identity ? -1 : a.card.identity > b.card.identity ? 1 : 0));
  const total = scored.length;
  const { limit, clamped } = normalizeLimit(input.limit);
  const page = scored.slice(0, limit);
  const cards = page.map(({ card, score }) => toResultCard(card, {
    mode: input.mode || 'summary', exact: false, input: scope, scored: score,
  }));
  // repo.total 在不完整库下为 null（只表示已读到的下界）；文案不能把 null 直接拼进去。
  const repoTotalText = repo.complete ? String(repo.total) : `至少 ${repo.lowerBound ?? repo.cards.length}（不完整）`;
  if (total === 0) {
    return textResult(`已检索 ${repoTotalText} 张知识卡片，未找到与关键词「${parsed.terms.join(', ')}」匹配的卡片。`, baseDetails({
      code: 'NO_MATCH', complete: repo.complete, snapshotId: repo.snapshotId, diagnostics: repo.diagnostics,
    }));
  }
  const title = `检索到 ${total} 张匹配的 KC（共 ${repoTotalText} 张可检索），按相关度排序：`;
  let text = formatSearchText(title, cards, {
    mode: input.mode || 'summary', total, returned: cards.length,
    complete: repo.complete, diagnostics: repo.diagnostics,
  });
  if (clamped) text += `\n（提示：limit 已归一化到 1–${MAX_LIMIT} 区间）`;
  return textResult(text, baseDetails({
    complete: repo.complete, total, returned: cards.length, truncated: cards.length < total,
    cards, snapshotId: repo.snapshotId, diagnostics: repo.diagnostics,
  }));
}

/**
 * 统一检索入口。返回 SDK result；普通无命中不是错误，输入/数据/生命周期不可用才是。
 * @returns {Promise<{content:Array,details:object,isError?:boolean}>}
 */
export async function searchKnowledge(input, options = {}) {
  const checked = validateInput(input);
  if (!checked.ok) return fail('INPUT_INVALID', checked.error);
  if (input.id !== undefined) return exactRead(input);
  const repositoryReader = typeof options.readRepository === 'function' ? options.readRepository : readRepository;
  return searchByKeywords(input, repositoryReader);
}
