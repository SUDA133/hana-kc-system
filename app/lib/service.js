// kc-system/lib/service.js — 跨 App 只读查询服务（bus.handle，schemaVersion 1）
//
// v5：正文真源改为 repository（JSONL + lifecycle 侧车），不再读 index 元数据冒充正文。
// 兼容旧 HC：info/list/status/card 字段保持；跨 agent 同 id 不丢卡，list/info 投影在碰撞时
// 使用 agent::id 并携带 legacyId/compositeId；card 精确 op 仍使用原 agent/id。
import {
  isValidAgent,
  validateId,
  stableStringify,
  sha256,
} from './jsonl-io.js';
import { readRepository, cardDigest } from './repository.js';
import { legacyLifecycleEntry, isLifecycleVisible } from './lifecycle.js';
import { searchKnowledge } from './retrieval.js';

export const SERVICE_NAME = 'query';
export const MAX_PAGE = 400;

const plain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const svcError = (code, message, extra = {}) => {
  const e = new Error(`${code}：${message}`);
  e.code = code;
  Object.assign(e, extra);
  return e;
};

/** 兼容旧导出：返回全部正式卡（含 inactive）。不再静默截断。 */
export function readAllCards() {
  const r = readRepository({ includeInactive: true });
  return r.ok ? r.cards : [];
}

function project(card, { includeContent = true } = {}) {
  return {
    agent: card.storageAgent || card.agent || null,
    id: card.id,
    keywords: Array.isArray(card.keywords) ? card.keywords.slice(0, 30) : [],
    summary: typeof card.summary === 'string' ? card.summary : '',
    score: typeof card.score === 'number' ? card.score : 5,
    lastUpdated: card.lastUpdated || card.created || null,
    lifecycle: card.lifecycle || legacyLifecycleEntry(),
    requiresReview: card.requiresReview === true,
    ...(includeContent ? { content: typeof card.content === 'string' ? card.content : '' } : {}),
  };
}

function projectListCard(card, includeContent, collides) {
  const base = project(card, { includeContent });
  if (!collides) return base;
  return {
    ...base,
    id: card.identity,
    legacyId: card.id,
    compositeId: card.identity,
  };
}

function snapshotFromCards(rawCards) {
  const cards = rawCards.map((card) => {
    const agent = card.storageAgent || card.agent || null;
    const identity = card.identity || `${agent}::${card.id}`;
    return {
      ...card,
      storageAgent: agent,
      identity,
      contentDigest: card.contentDigest || cardDigest(card),
      lifecycle: card.lifecycle || legacyLifecycleEntry(),
    };
  }).sort((a, b) => (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0));
  const snapshotId = sha256(stableStringify({
    version: 1,
    cards: cards.map((c) => ({ identity: c.identity, digest: c.contentDigest })),
  }));
  return {
    ok: true, complete: true, cards, diagnostics: [], snapshotId,
    total: cards.length, lifecycleOk: true,
  };
}

function loadSnapshot(readCards, readRepositoryFn) {
  if (typeof readCards === 'function') return snapshotFromCards(readCards());
  const repo = readRepositoryFn({ includeInactive: true });
  if (!repo || typeof repo !== 'object') throw svcError('KC_DATA_INCOMPLETE', '仓库返回空结果');
  if (Array.isArray(repo.cards)) {
    repo.cards = repo.cards.slice().sort((a, b) => (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0));
  }
  return repo;
}

function ensureComplete(snapshot) {
  if (snapshot.ok && snapshot.complete && snapshot.lifecycleOk !== false) return;
  const codes = Array.isArray(snapshot.diagnostics)
    ? snapshot.diagnostics.map((d) => d && d.code).filter(Boolean).slice(0, 8)
    : [];
  throw svcError('KC_DATA_INCOMPLETE', `正式库不完整，拒绝报告精确 total${codes.length ? `（${codes.join(',')}）` : ''}`, {
    diagnostics: snapshot.diagnostics || [],
    total: undefined,
  });
}

function validateSnapshotArg(payload, snapshot) {
  if (payload.snapshotId === undefined) return;
  if (typeof payload.snapshotId !== 'string' || !payload.snapshotId) {
    throw svcError('PAYLOAD_INVALID', 'snapshotId 必须是非空字符串');
  }
  if (payload.snapshotId !== snapshot.snapshotId) {
    throw svcError('KC_SNAPSHOT_CHANGED', '分页快照已变化，请从第一页重新拉取', {
      currentSnapshotId: snapshot.snapshotId,
    });
  }
}

function validateAgent(payload) {
  if (payload.agent === undefined || payload.agent === 'all') return null;
  // 形状校验而非名单校验：库里出现的任何合法分片都能作为过滤值。
  if (typeof payload.agent !== 'string' || !isValidAgent(payload.agent)) {
    throw svcError('AGENT_INVALID', '非法 agent 过滤值');
  }
  return payload.agent;
}

function visibleCard(card, includeInactive) {
  if (includeInactive) return true;
  return isLifecycleVisible(card.lifecycle || legacyLifecycleEntry());
}

function parseStatusName(name) {
  const t = name.trim();
  if (!t.includes('::')) return null;
  const i = t.indexOf('::');
  const agent = t.slice(0, i);
  const id = t.slice(i + 2);
  if (!isValidAgent(agent) || !validateId(id)) return null;
  return { agent, id, identity: `${agent}::${id}` };
}

/** 服务 handler 工厂：纯逻辑，便于测试。readCards 是旧测试注入；默认走 repository。 */
export function makeQueryHandler({ readCards, readRepositoryFn = readRepository } = {}) {
  return async function handler(payload, ctx = {}) {
    const caller = ctx && ctx.callerAppId;
    if (caller !== 'hana-superpowers') {
      throw svcError('CALLER_DENIED', '本服务只对 hana-superpowers 开放');
    }
    if (!plain(payload)) throw svcError('PAYLOAD_INVALID', 'payload 必须为对象');
    const op = payload.op;
    if (!['info', 'list', 'status', 'card', 'search'].includes(op)) {
      throw svcError('OP_UNKNOWN', String(op));
    }
    const snapshot = loadSnapshot(readCards, readRepositoryFn);
    ensureComplete(snapshot);
    const visibleTotal = snapshot.cards.filter((card) => visibleCard(card, false)).length;
    const totals = { totalAll: snapshot.cards.length, visibleTotal, inactiveTotal: snapshot.cards.length - visibleTotal };

    if (op === 'info') {
      return {
        schemaVersion: 1, op, total: snapshot.cards.length,
        ...totals,
        operations: ['info', 'list', 'status', 'card', 'search'],
        generatedAt: new Date().toISOString(), snapshotId: snapshot.snapshotId, complete: true,
      };
    }
    if (op === 'search') {
      validateSnapshotArg(payload, snapshot);
      const result = await searchKnowledge({
        keywords: payload.keywords,
        agent: payload.agent,
        limit: payload.limit,
        includeInactive: payload.includeInactive,
        project: payload.project,
        version: payload.version,
        mode: payload.mode || 'detail',
      }, { readRepository: ({ includeInactive = false } = {}) => ({
        ...snapshot,
        cards: includeInactive ? snapshot.cards : snapshot.cards.filter((card) => visibleCard(card, false)),
        total: includeInactive ? snapshot.cards.length : snapshot.cards.filter((card) => visibleCard(card, false)).length,
      }) });
      const d = result.details || {};
      if (result.isError || d.available === false) throw svcError(d.code || 'KC_QUERY_FAILED', result.content?.[0]?.text || '检索失败', { diagnostics: d.diagnostics || [] });
      return {
        schemaVersion: 1, op,
        total: d.total ?? 0, returned: d.returned ?? 0, truncated: d.truncated === true,
        ...totals,
        cards: d.cards || [], snapshotId: d.snapshotId || snapshot.snapshotId,
        complete: d.complete === true, diagnostics: d.diagnostics || [],
        policyVersion: d.policyVersion || 5,
      };
    }

    if (op === 'list') {
      validateSnapshotArg(payload, snapshot);
      const agentFilter = validateAgent(payload);
      if (payload.includeInactive !== undefined && typeof payload.includeInactive !== 'boolean') {
        throw svcError('PAYLOAD_INVALID', 'includeInactive 必须是布尔值');
      }
      const includeInactive = payload.includeInactive === true;
      const includeContent = payload.includeContent !== false;
      const offset = Number.isInteger(payload.offset) && payload.offset >= 0 ? payload.offset : 0;
      const limitRaw = Number.isInteger(payload.limit) ? payload.limit : MAX_PAGE;
      const limit = Math.max(1, Math.min(MAX_PAGE, limitRaw));
      const all = snapshot.cards.filter((card) => {
        if (agentFilter && card.storageAgent !== agentFilter) return false;
        return visibleCard(card, includeInactive);
      });
      const total = all.length;
      const page = all.slice(offset, offset + limit);
      const counts = new Map();
      for (const card of all) counts.set(card.id, (counts.get(card.id) || 0) + 1);
      const cards = page.map((card) => projectListCard(card, includeContent, counts.get(card.id) > 1));
      const nextOffset = offset + page.length < total ? offset + page.length : null;
      return {
        schemaVersion: 1, op, total, offset, nextOffset, cards,
        snapshotId: snapshot.snapshotId, complete: true,
      };
    }

    if (op === 'status') {
      const name = payload.name;
      if (typeof name !== 'string' || !name.trim()) throw svcError('NAME_INVALID', 'name 必须是非空字符串');
      const composite = parseStatusName(name);
      const hits = composite
        ? snapshot.cards.filter((card) => card.identity === composite.identity)
        : snapshot.cards.filter((card) => card.id === name.trim() || (typeof card.source === 'string' && card.source === name.trim()));
      const hit = hits[0] || null;
      const lifecycle = hit?.lifecycle || legacyLifecycleEntry();
      const scope = lifecycle.scope || {};
      const scopeMatches = !payload.project || !scope.project || scope.project === payload.project;
      return {
        schemaVersion: 1, op, found: hits.length > 0,
        ...(hit ? { identity: hit.identity, agent: hit.storageAgent, lifecycle,
          active: isLifecycleVisible(lifecycle) && scopeMatches,
          requiresReview: !payload.project && !!scope.project,
          ambiguous: hits.length > 1 } : { active: false, ambiguous: false }),
        snapshotId: snapshot.snapshotId,
      };
    }

    if (op === 'card') {
      if (payload.agent === undefined || !isValidAgent(payload.agent) || typeof payload.id !== 'string' || !validateId(payload.id)) {
        throw svcError('IDENTITY_INVALID', 'card 需要合法的 agent + id');
      }
      const identity = `${payload.agent}::${payload.id}`;
      const hit = snapshot.cards.find((card) => card.identity === identity) || null;
      if (!hit) return { schemaVersion: 1, op, card: null, snapshotId: snapshot.snapshotId };
      const lifecycle = hit.lifecycle || legacyLifecycleEntry();
      return {
        schemaVersion: 1, op,
        card: { ...project(hit), lifecycle },
        lifecycle,
        ...(isLifecycleVisible(lifecycle) ? {} : { warning: `该卡 lifecycle=${lifecycle.status}，存在不代表当前有效` }),
        snapshotId: snapshot.snapshotId,
      };
    }

    throw svcError('OP_UNKNOWN', String(op));
  };
}

/** 注册服务（入口在 apply 内调用；await 注册收据）。 */
export async function registerQueryService(sdk, deps = {}) {
  const handler = makeQueryHandler(deps);
  const receipt = await sdk.bus.handle(SERVICE_NAME, handler, { allowCrossApp: true });
  return receipt;
}
