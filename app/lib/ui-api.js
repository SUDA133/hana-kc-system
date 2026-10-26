// KC page read model. Uses the formal repository and the same scorer/projection
// as model retrieval, without calling knowledge-query's heat-writing adapter.
import { readRepository } from './repository.js';
import { isLifecycleVisible, isLifecycleExpired } from './lifecycle.js';
import { isValidAgent } from './jsonl-io.js';
import { parseKeywordInput, scoreKnowledgeCard, toResultCard, exactIdentity } from './retrieval.js';
import { listCandidates, readCandidate } from './candidate-store.js';

const STATUSES = ['visible', 'disabled', 'all', 'active', 'legacy-unverified', 'deprecated', 'superseded', 'archived', 'expired'];
const fail = (code, error, extra = {}) => ({ ok: false, code, error, ...extra });
function candidateView(c) {
  return { candidateId: c.candidateId, identity: c.identity, kind: c.kind, status: c.status,
    revision: c.revision, proposed: c.proposed, created: c.created, updated: c.updated,
    publishable: c.publishable, hasIntent: !!c.intent, diagnostic: c.diagnostic,
    origins: (c.origins || []).map(o => ({ source: o.source, at: o.at, trust: o.trust })) };
}
function integer(value, fallback, min, max) {
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(String(value))) throw new Error('分页参数必须是非负整数');
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`分页参数需在 ${min}..${max} 之间`);
  return n;
}
function project(card, detail = false, scored = null) {
  return { ...toResultCard(card, { mode: detail ? 'detail' : 'summary', exact: detail, input: {}, scored }),
    related: Array.isArray(card.related) ? card.related.filter(x => typeof x === 'string').slice(0, 50) : [],
    expired: isLifecycleExpired(card.lifecycle), available: isLifecycleVisible(card.lifecycle) && !card.agentMismatch && !card.duplicate };
}
function matchesStatus(card, status) {
  if (status === 'all') return true;
  if (status === 'visible') return isLifecycleVisible(card.lifecycle) && !card.agentMismatch && !card.duplicate;
  if (status === 'disabled') return card.lifecycle?.status !== 'archived' && (!isLifecycleVisible(card.lifecycle) || card.agentMismatch || card.duplicate);
  if (status === 'expired') return isLifecycleExpired(card.lifecycle);
  return card.lifecycle?.status === status;
}
export async function listCards(input = {}) {
  try {
    const agent = input.agent || 'all', status = input.status || 'visible';
    if (agent !== 'all' && !isValidAgent(agent)) return fail('INPUT_INVALID', 'Agent 筛选无效');
    if (!STATUSES.includes(status)) return fail('INPUT_INVALID', '生命周期筛选无效');
    const offset = integer(input.offset, 0, 0, 20000), limit = integer(input.limit, 30, 1, 100);
    const q = typeof input.q === 'string' ? input.q.trim() : '';
    const parsed = q ? parseKeywordInput(q) : null;
    if (parsed && !parsed.ok) return fail('INPUT_INVALID', parsed.error);
    const repo = readRepository({ includeInactive: true });
    if (!repo.ok) return fail('DATA_UNAVAILABLE', '正式库不可读', { complete: false, total: null, diagnostics: repo.diagnostics });
    if (!repo.lifecycleOk && status !== 'all') return fail('LIFECYCLE_UNAVAILABLE', '生命周期不可读，请用全部状态进行审计', { complete: false, total: null, diagnostics: repo.diagnostics });
    if (input.snapshotId && input.snapshotId !== repo.snapshotId) return fail('KC_SNAPSHOT_CHANGED', '卡片库已变化，请从第一页重新读取', { snapshotId: repo.snapshotId });
    // facets 只反映库里实际出现的 agent（按卡片计数派生），不预先列出任何名单。
    const facets = { agents: {}, statuses: Object.fromEntries(STATUSES.map(s => [s, 0])) };
    const rows = [];
    for (const card of repo.cards) {
      facets.agents[card.storageAgent] = (facets.agents[card.storageAgent] || 0) + 1;
      for (const s of STATUSES) if (matchesStatus(card, s)) facets.statuses[s]++;
      if (agent !== 'all' && card.storageAgent !== agent) continue;
      if (!matchesStatus(card, status)) continue;
      // Default retrieval excludes physical identity corruption; audit-all keeps it visible.
      if (status === 'visible' && (card.agentMismatch || card.duplicate)) continue;
      const scored = parsed ? scoreKnowledgeCard(card, parsed.terms) : null;
      if (scored && scored.score <= 0) continue;
      rows.push({ card, scored });
    }
    rows.sort((a, b) => ((b.scored?.score || 0) - (a.scored?.score || 0)) || a.card.identity.localeCompare(b.card.identity, 'en'));
    const page = rows.slice(offset, offset + limit);
    const sortedAgents = Object.fromEntries(Object.keys(facets.agents).sort().map(k => [k, facets.agents[k]]));
    return { ok: true, complete: repo.complete, items: page.map(({ card, scored }) => project(card, false, scored)), total: repo.complete ? rows.length : null,
      lowerBound: rows.length, offset, limit, nextOffset: offset + page.length < rows.length ? offset + page.length : null,
      snapshotId: repo.snapshotId, diagnostics: repo.diagnostics, facets: { ...facets, agents: sortedAgents } };
  } catch (e) { return fail('INPUT_INVALID', String(e.message)); }
}
export async function getCard(input = {}) {
  let identity;
  try { identity = exactIdentity(input.identity, undefined).identity; }
  catch (e) { return fail('IDENTITY_INVALID', e.message); }
  const repo = readRepository({ includeInactive: true });
  if (!repo.ok) return fail('DATA_UNAVAILABLE', '正式库不可读', { complete: false, diagnostics: repo.diagnostics });
  const hit = repo.cards.find(c => c.identity === identity);
  if (!hit) return fail('CARD_NOT_FOUND', '未找到卡片：' + identity);
  if (hit.duplicate) return fail('AMBIGUOUS_TARGET', '同身份有重复记录，拒绝歧义详情');
  const card = project(hit, true);
  if (!repo.lifecycleOk) card.warnings.push('生命周期侧车不可用，本卡仅供审计');
  if (!repo.complete) card.warnings.push('正式库存在完整性诊断，本详情只覆盖目标卡');
  return { ok: true, card, snapshotId: repo.snapshotId, complete: repo.complete, diagnostics: repo.diagnostics,
    lifecycleRevision: repo.lifecycle?.revision ?? null,
    canManage: repo.complete && repo.lifecycleOk && !hit.agentMismatch && !hit.duplicate && !hit.lifecycle?.stale };
}
export async function getCandidates(input = {}) {
  try { return await listCandidates({ status: input.status || 'pending', offset: integer(input.offset, 0, 0, 20000), limit: integer(input.limit, 30, 1, 100) }); }
  catch (e) { return fail('INPUT_INVALID', e.message); }
}
export async function getCandidate(input = {}) {
  const read = await readCandidate(input.candidateId);
  if (!read.ok) return read;
  const candidate = read.candidate;
  const repo = readRepository({ includeInactive: true });
  const hit = candidate.identity ? repo.cards.find(c => c.identity === candidate.identity) : null;
  const safeTarget = !hit?.duplicate && !hit?.agentMismatch;
  return { ok: true, candidate: candidateView(candidate), target: { exists: !!hit, card: hit && safeTarget ? project(hit, true) : null,
      digest: repo.complete && safeTarget ? (hit?.contentDigest || 'absent') : null },
    canReview: repo.ok && repo.complete && safeTarget, complete: repo.complete, diagnostics: repo.diagnostics };
}
