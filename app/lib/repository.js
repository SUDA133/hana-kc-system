// lib/repository.js — KC5 read model over the formal JSONL shards.
//
// 真源只有 dataDir 下的合法 *.notes.jsonl（目录发现，而非固定名单）；index.json 不参与正文、快照或完整性判断。
// 物理身份 = 分片 agent::id；card.agent 不一致只报诊断，绝不把正文路由到别的分片。
import fs from 'node:fs';
import {
  discoverShards,
  unsafeIgnoredEntries,
  getJsonlPath,
  stableStringify,
  sha256,
  isValidAgent,
  validateId,
} from './jsonl-io.js';
import { readLifecycle, legacyLifecycleEntry, isLifecycleVisible } from './lifecycle.js';

export const MAX_SHARD_BYTES = 16 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
export const MAX_CARDS = 20000;
export const DIGEST_VERSION = 1;

const DIGEST_EXCLUDED = new Set([
  'created', 'lastUpdated', 'queryCount', 'lastQueried',
  'storageAgent', 'identity', 'contentDigest', 'lifecycle',
  'agentMismatch', 'duplicate', 'duplicateCount',
]);
const DIGEST_RE = /^[0-9a-f]{64}$/i;
const plain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function canonicalKeywords(value) {
  if (!Array.isArray(value)) return value;
  const out = [];
  for (const raw of value) {
    if (typeof raw !== 'string') return value;
    const t = raw.trim().toLowerCase();
    if (t && !out.includes(t)) out.push(t);
  }
  return out.sort();
}

function canonicalRelated(value) {
  if (!Array.isArray(value)) return value;
  const out = [];
  for (const raw of value) {
    if (typeof raw !== 'string') return value;
    const t = raw.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out.sort();
}

/**
 * 语义内容快照 hash：排除时间戳/统计/运行派生字段；keywords 去重排序、related 稳定；
 * 未知业务字段原样参与（键序由 stableStringify 固定）。不是来源认证。
 */
export function cardDigest(card) {
  if (!plain(card)) throw new Error('cardDigest 需要普通卡片对象');
  const projection = {};
  for (const key of Object.keys(card)) {
    if (DIGEST_EXCLUDED.has(key)) continue;
    if (key === 'keywords') { projection[key] = canonicalKeywords(card[key]); continue; }
    if (key === 'related') { projection[key] = canonicalRelated(card[key]); continue; }
    projection[key] = card[key];
  }
  return sha256(stableStringify({ digestVersion: DIGEST_VERSION, card: projection }));
}

function diag(code, message, extra = {}) {
  return { code, message, ...extra };
}

/** 有界读取单个分片：不会把 >16MiB 的文件整体读入内存，且在末尾截断时只保留完整行。 */
function readShardBounded(agent, remainingBytes) {
  const file = getJsonlPath(agent);
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (e) {
    if (e && e.code === 'ENOENT') return { missing: true, bytes: 0 };
    return { ok: false, bytes: 0, diag: diag('shard-unreadable', `分片不可读：${e.message}`, { storageAgent: agent }) };
  }
  if (stat.isSymbolicLink()) {
    return { ok: false, bytes: 0, diag: diag('shard-symlink', '拒绝读取符号链接分片', { storageAgent: agent }) };
  }
  if (remainingBytes <= 0) {
    return { ok: false, bytes: 0, diag: diag('total-bytes-exceeded', '已超过总读取预算', { storageAgent: agent }) };
  }
  const size = stat.size;
  const take = Math.min(size, MAX_SHARD_BYTES, remainingBytes);
  const buf = Buffer.alloc(take);
  let read = 0;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    while (read < take) {
      const n = fs.readSync(fd, buf, read, take - read, read);
      if (!n) break;
      read += n;
    }
  } catch (e) {
    return { ok: false, bytes: read, diag: diag('shard-read-failed', `分片读取失败：${e.message}`, { storageAgent: agent }) };
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed */ } }
  }
  const truncated = size > take;
  let end = read;
  if (truncated) {
    const nl = buf.subarray(0, read).lastIndexOf(0x0a);
    end = nl >= 0 ? nl + 1 : 0;
  }
  const reasons = [];
  if (size > MAX_SHARD_BYTES) reasons.push('shard-too-large');
  if (size > remainingBytes) reasons.push('total-bytes-exceeded');
  return { ok: true, bytes: take, size, truncated, reasons, text: buf.toString('utf8', 0, end) };
}

function parseShardLines(agent, text, state) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    let raw;
    try { raw = JSON.parse(line); }
    catch {
      state.diagnostics.push(diag('bad-line', 'JSONL 行无法解析', { storageAgent: agent, line: i + 1 }));
      state.complete = false;
      continue;
    }
    if (!plain(raw) || typeof raw.id !== 'string' || !raw.id.trim()) {
      state.diagnostics.push(diag('invalid-record', '记录不是带 id 的对象', { storageAgent: agent, line: i + 1 }));
      state.complete = false;
      continue;
    }
    const identity = `${agent}::${raw.id}`;
    if (state.byIdentity.has(identity)) {
      const first = state.byIdentity.get(identity);
      first.duplicate = true;
      first.duplicateCount = (first.duplicateCount || 1) + 1;
      state.diagnostics.push(diag('duplicate-identity', '同一分片/身份出现重复记录', { storageAgent: agent, line: i + 1, identity }));
      state.complete = false;
      continue;
    }
    if (state.cards.length >= MAX_CARDS) {
      state.diagnostics.push(diag('card-limit', `卡片数达到 ${MAX_CARDS} 上限`, { storageAgent: agent, line: i + 1 }));
      state.complete = false;
      return false;
    }
    const agentMismatch = raw.agent !== undefined && raw.agent !== agent;
    const card = {
      ...raw,
      storageAgent: agent,
      identity,
      contentDigest: cardDigest(raw),
      lifecycle: null,
      ...(agentMismatch ? { agentMismatch: true } : {}),
    };
    if (agentMismatch) {
      state.diagnostics.push(diag('agent-mismatch', '卡内 agent 与分片物理身份不一致', { storageAgent: agent, line: i + 1, identity }));
      state.complete = false;
    }
    state.cards.push(card);
    state.byIdentity.set(identity, card);
  }
  return true;
}

function findCycle(entries) {
  const done = new Set();
  for (const start of Object.keys(entries)) {
    if (done.has(start)) continue;
    const local = new Set();
    let cur = start;
    while (cur && entries[cur]) {
      if (done.has(cur)) break;
      if (local.has(cur)) return true;
      local.add(cur);
      cur = entries[cur].supersededBy || null;
      if (local.size > MAX_CARDS) return true;
    }
    for (const key of local) done.add(key);
  }
  return false;
}

function attachLifecycle(cards, life, state) {
  const identities = new Set(cards.map((c) => c.identity));
  for (const [identity, entry] of Object.entries(life.entries)) {
    if (!identities.has(identity)) {
      state.diagnostics.push(diag('lifecycle-orphan', '侧车条目没有对应的物理卡（可显式清除）', { identity }));
    }
    if (!entry.supersededBy) continue;
    if (entry.supersededBy === identity) {
      state.diagnostics.push(diag('lifecycle-self-superseded', 'supersededBy 指向自身', { identity }));
      state.complete = false;
    } else if (!identities.has(entry.supersededBy)) {
      state.diagnostics.push(diag('lifecycle-dangling-superseded', 'supersededBy 目标不存在', { identity, target: entry.supersededBy }));
      state.complete = false;
    }
  }
  if (findCycle(life.entries)) {
    state.diagnostics.push(diag('lifecycle-cycle', 'supersededBy 存在循环', {}));
    state.complete = false;
  }
  for (const card of cards) {
    const entry = life.entries[card.identity];
    if (!entry) { card.lifecycle = legacyLifecycleEntry(); continue; }
    if (entry.targetDigest !== card.contentDigest) {
      state.diagnostics.push(diag('lifecycle-digest-mismatch', '侧车条目绑定的 digest 与当前卡不一致，条目失效', {
        identity: card.identity, severity: 'warn',
      }));
      card.lifecycle = legacyLifecycleEntry({ stale: true, previousStatus: entry.status });
      continue;
    }
    card.lifecycle = entry;
  }
}

function snapshotOf(cards, life) {
  const snapCards = cards
    .map((c) => ({ identity: c.identity, digest: c.contentDigest }))
    .sort((a, b) => (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0));
  const entries = {};
  for (const key of Object.keys(life.entries).sort()) entries[key] = life.entries[key];
  return sha256(stableStringify({
    version: 1,
    cards: snapCards,
    lifecycle: { revision: life.revision, entries },
  }));
}

/**
 * 读取正式卡库（同步）。完整性错误可返回部分 cards，但 complete=false。
 * @returns {{ok:boolean,complete:boolean,cards:object[],diagnostics:object[],snapshotId:string,total:number,lifecycleOk:boolean}}
 */
export function readRepository({ includeInactive = false } = {}) {
  const state = { cards: [], byIdentity: new Map(), diagnostics: [], complete: true };
  let bytes = 0;
  try {
    // 分片集合由目录发现决定：新增的合法 agent 无需改动任何枚举即可被读到。
    const discovery = discoverShards();
    if (!discovery.ok) {
      state.diagnostics.push(diag('data-dir-unreadable', discovery.error || '数据目录不可读'));
      state.complete = false;
    }
    // 两类 ignored 严重度不同：
    //  - invalid-name 的名字本来就不可能被寻址为合法身份，告知即可，不拖垮完整库；
    //  - symlink / not-a-file / unreadable 里可能真有卡而本函数没读到，必须判为不完整。
    for (const item of discovery.ignored || []) {
      const unsafe = unsafeIgnoredEntries({ ignored: [item] }).length > 0;
      state.diagnostics.push(diag(unsafe ? 'shard-ignored' : 'shard-name-invalid',
        unsafe ? `已跳过不可信的分片条目（未读取其中内容）：${item.name}` : `已跳过名称不合规的分片条目：${item.name}`,
        { file: item.name, code: item.code, reason: item.reason }));
      if (unsafe) state.complete = false;
    }
    if (discovery.truncated) {
      state.diagnostics.push(diag('shard-discovery-truncated',
        '分片目录条目超过扫描上限，未能确认全部分片；本次结果不能当作全量'));
      state.complete = false;
    }
    for (const agent of discovery.agents) {
      const remaining = MAX_TOTAL_BYTES - bytes;
      if (remaining <= 0) {
        state.diagnostics.push(diag('total-bytes-exceeded', '已超过全库读取预算', { storageAgent: agent }));
        state.complete = false;
        break;
      }
      const shard = readShardBounded(agent, remaining);
      bytes += shard.bytes || 0;
      if (shard.missing) continue;
      if (!shard.ok) {
        state.diagnostics.push(shard.diag);
        state.complete = false;
        continue;
      }
      for (const code of shard.reasons || []) {
        state.diagnostics.push(diag(code, code === 'shard-too-large' ? '分片超过 16MiB 读取上限' : '全库超过 64MiB 读取预算', {
          storageAgent: agent, size: shard.size,
        }));
        state.complete = false;
      }
      if (!parseShardLines(agent, shard.text, state)) break;
    }
    const life = readLifecycle();
    for (const d of life.diagnostics) state.diagnostics.push({ ...d, source: 'lifecycle' });
    const lifecycleOk = life.ok && life.complete;
    if (!lifecycleOk) state.complete = false;
    attachLifecycle(state.cards, life, state);
    const snapshotId = snapshotOf(state.cards, life);
    const cards = includeInactive ? state.cards.slice() : state.cards.filter((c) => isLifecycleVisible(c.lifecycle));
    return {
      ok: true,
      complete: state.complete,
      cards,
      diagnostics: state.diagnostics,
      snapshotId,
      // 不完整库的 total 只能是「已读到的下界」，不能冒充精确总数。
      // 保持 total 字段形态不变（number|null），调用方按 complete 决定能否当精确值用；
      // 同时给出 lowerBound 以免丢信息。
      total: state.complete ? cards.length : null,
      lowerBound: cards.length,
      lifecycleOk,
      lifecycle: { ok: life.ok, complete: life.complete, revision: life.revision, error: life.error },
    };
  } catch (e) {
    return {
      ok: false,
      complete: false,
      cards: state.cards,
      diagnostics: [...state.diagnostics, diag('repository-error', `读取仓库失败：${e.message}`)],
      snapshotId: '',
      total: null,
      lowerBound: state.cards.length,
      lifecycleOk: false,
      lifecycle: { ok: false, complete: false, revision: null, error: e.message },
    };
  }
}

/**
 * 精确目标读取（供 lifecycle annotate 使用）：同一物理分片内多张同 id -> TARGET_AMBIGUOUS。
 * 目标行本身必须可解析；其它坏行不阻止精确目标审计。
 */
export function findCardByIdentity({ agent, id } = {}) {
  if (!isValidAgent(agent)) return { ok: false, code: 'TARGET_INVALID', error: 'agent 非法' };
  if (!validateId(id)) return { ok: false, code: 'TARGET_INVALID', error: 'id 非法' };
  const shard = readShardBounded(agent, MAX_SHARD_BYTES);
  if (shard.missing) return { ok: false, code: 'TARGET_MISSING', error: `目标不存在：${agent}::${id}` };
  if (!shard.ok) return { ok: false, code: 'TARGET_UNREADABLE', error: shard.diag.message };
  if (shard.truncated) return { ok: false, code: 'TARGET_UNREADABLE', error: '分片超过 16MiB，无法保证精确读取' };
  const hits = [];
  for (const line of shard.text.split('\n')) {
    if (!line.trim()) continue;
    let card;
    try { card = JSON.parse(line); } catch { continue; }
    if (plain(card) && card.id === id) hits.push(card);
  }
  if (hits.length === 0) return { ok: false, code: 'TARGET_MISSING', error: `目标不存在：${agent}::${id}` };
  if (hits.length > 1) return { ok: false, code: 'TARGET_AMBIGUOUS', error: `同身份存在 ${hits.length} 张卡，拒绝歧义` };
  const card = hits[0];
  return {
    ok: true,
    card,
    digest: cardDigest(card),
    agentMismatch: card.agent !== undefined && card.agent !== agent,
  };
}

export function assertDigest(value) {
  return typeof value === 'string' && DIGEST_RE.test(value);
}
