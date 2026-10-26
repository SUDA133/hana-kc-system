// candidate-store.js — KC5 知识候选隔离存储 + 显式发布协调（唯一正式卡写者仍是 card-writer.storeCard）
//
// 设计边界（见 docs/api-contract.md / docs/design-amendments.md）：
//  - 候选是独立 schema1 JSON，一候选一文件，根目录 APP_DATA_DIR/candidates；
//    发布收据在 APP_DATA_DIR/publish-receipts；本模块不读写生产 App 数据目录以外的路径。
//  - 候选内容来自代理，一律「未核实来源」：候选 id 只是内容+目标哈希，不是认证。
//    候选永不自动变成正式卡；只有显式 publishCandidate 才会调用 storeCard。
//  - 畸形输入用 kind=diagnostic 的登记候选留档（没有 proposed，不可发布）。
//  - publish 事务跨两个文件（候选记录 / 正式分片），不能原子提交，因此用可恢复收据：
//      1) 短同步临界区：复核候选 CAS、读当前目标摘要、固化 planned card + plannedDigest，
//         把候选置 publishing 并写 prepared 收据；临界区内不 await（数据锁不能跨 await）。
//      2) 调用 storeCard({expectedDigest, beforeCommit})：beforeCommit 在写者数据锁内同步
//         写 prepared 收据（精确 card + contentDigest），失败则不提交。
//      3) 短同步临界区 finalize：按「当前目标摘要 == plannedDigest」判定是否已提交，
//         不靠时间/文件名猜；候选状态写失败如实返回 committed:true/statusPending:true。
//  - beforeCommit 回调内禁止再取 dataLock（storeCard 已持有锁，重入会自锁）。
//  - 状态迁移只由 CAS + 当前目标摘要决定；published/rejected 不做反向假回滚。

import fs from 'node:fs';
import path from 'node:path';
import {
  APP_DATA_DIR,
  enqueueDataWrite,
  getJsonlPath,
  isValidAgent,
  agentRejectionReason,
  normalizeCard,
  readAllLines,
  sha256,
  stableStringify,
  atomicWriteFile,
  validateId,
} from './jsonl-io.js';
import { normalizeCardId } from './card-writer.js';
import { cardDigest } from './repository.js';

export const SCHEMA_VERSION = 1;
export const STATUSES = ['pending', 'publishing', 'published', 'already-present', 'rejected', 'published-superseded', 'conflict'];
export const RECEIPT_PHASES = ['prepared', 'committed', 'finalized', 'conflict', 'abandoned'];
// 「已提交证据」相位：这些收据说明正式卡可能已经被本次审查写过，绝不得换成新计划。
const COMMITTED_PHASES = ['committed', 'finalized'];
// 「可重规划」相位：能证明本次审查没有提交（准备阶段失败 / 已显式 abandon）。
const REPLANNABLE_PHASES = ['prepared', 'abandoned', 'conflict'];
export const CANDIDATES_DIR = path.join(APP_DATA_DIR, 'candidates');
export const RECEIPTS_DIR = path.join(APP_DATA_DIR, 'publish-receipts');
export const LIMITS = {
  maxCandidates: 1000,
  maxTotalBytes: 16 * 1024 * 1024,
  maxRecordBytes: 64 * 1024,
  maxReceiptBytes: 128 * 1024,
  maxOrigins: 5,
  maxHistory: 20,
  maxReceiptHistory: 16,
  maxKeywords: 20,
  maxKeywordLength: 50,
  maxSummary: 100,
  maxContent: 500,
  maxRelated: 20,
  maxReviewSummary: 500,
  maxReason: 500,
  maxDiagnosticMessage: 300,
  maxSnippet: 200,
  maxSource: 128,
  maxTaskId: 128,
  maxSessionPath: 512,
  listLimitDefault: 20,
  listLimitMax: 100,
};

const CANDIDATE_ID_RE = /^cand-[0-9a-f]{64}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const RECORD_KEYS = [
  'schemaVersion', 'candidateId', 'kind', 'identity', 'proposed', 'digest', 'status', 'revision',
  'created', 'updated', 'origins', 'originOverflow', 'diagnostic', 'review', 'intent',
  'publishedDigest', 'lastReconcile', 'history', 'integrity',
];
const KINDS = ['content', 'diagnostic'];

export const isCandidateId = (id) => typeof id === 'string' && CANDIDATE_ID_RE.test(id);

function nowIso() {
  return new Date().toISOString();
}
function today() {
  return new Date().toISOString().split('T')[0];
}
function fail(code, error, extra = {}) {
  return { ok: false, code, error, ...extra };
}

// ── 内容摘要 ─────────────────────────────────────────────
// 唯一实现来自 repository.cardDigest（card-writer 的 contentDigest 同源）：
// 排除时间戳/统计/运行派生字段；keywords 小写去重排序；related 去重排序；未知业务字段参与。
// 本模块不复制算法，避免 CAS 与 lifecycle 绑定漂移。
export const digestCard = cardDigest;

// ── 输入校验 ─────────────────────────────────────────────
export function validateProposed(proposed, limits = LIMITS) {
  const errors = [];
  if (!proposed || typeof proposed !== 'object' || Array.isArray(proposed)) {
    return { ok: false, errors: ['proposed 必须是对象'] };
  }
  const allowed = ['agent', 'id', 'keywords', 'summary', 'content', 'related'];
  const unknown = Object.keys(proposed).filter((k) => !allowed.includes(k));
  if (unknown.length) errors.push(`未知字段：${unknown.join('、')}`);

  const agent = proposed.agent;
  if (!isValidAgent(agent)) errors.push(`agent 非法（${agentRejectionReason(agent)}；需为小写 kebab-case 名称）`);

  const rawId = typeof proposed.id === 'string' ? proposed.id.trim() : proposed.id;
  if (!validateId(rawId)) errors.push('id 必须是 kebab-case（小写字母/数字/连字符）');

  const summary = typeof proposed.summary === 'string' ? proposed.summary.trim() : '';
  if (!summary) errors.push('summary 不能为空');
  else if (summary.length > limits.maxSummary) errors.push(`summary 超过 ${limits.maxSummary} 字（当前 ${summary.length}）`);

  const content = typeof proposed.content === 'string' ? proposed.content.trim() : '';
  if (!content) errors.push('content 不能为空');
  else if (content.length > limits.maxContent) errors.push(`content 超过 ${limits.maxContent} 字（当前 ${content.length}）`);

  const rawKeywords = Array.isArray(proposed.keywords) ? proposed.keywords : null;
  let keywords = [];
  if (!rawKeywords || rawKeywords.length === 0) {
    errors.push('keywords 必须是非空数组');
  } else if (rawKeywords.length > limits.maxKeywords) {
    errors.push(`keywords 最多 ${limits.maxKeywords} 个（当前 ${rawKeywords.length}）`);
  } else {
    for (const raw of rawKeywords) {
      if (typeof raw !== 'string') { errors.push('keywords 元素必须是字符串'); continue; }
      const kw = raw.trim();
      if (!kw) { errors.push('keywords 不能含空白项'); continue; }
      if (kw.length > limits.maxKeywordLength) { errors.push(`keyword 过长（上限 ${limits.maxKeywordLength}）：${kw.slice(0, 20)}…`); continue; }
      if (/[\r\n]/.test(kw)) { errors.push('keyword 不能包含换行'); continue; }
      if (!keywords.includes(kw)) keywords.push(kw);
    }
  }

  let related = [];
  if (proposed.related !== undefined && proposed.related !== null) {
    if (!Array.isArray(proposed.related)) errors.push('related 必须是数组');
    else if (proposed.related.length > limits.maxRelated) errors.push(`related 最多 ${limits.maxRelated} 项（当前 ${proposed.related.length}）`);
    else {
      for (const raw of proposed.related) {
        if (!validateId(raw)) { errors.push(`related 含非法 id：${String(raw)}`); continue; }
        if (!related.includes(raw)) related.push(raw);
      }
    }
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { agent, id: rawId, keywords, summary, content, related } };
}

function normalizeOrigin(origin, limits = LIMITS) {
  if (origin === undefined || origin === null) return { ok: true, value: null };
  if (typeof origin !== 'object' || Array.isArray(origin)) return { ok: false, error: 'origin 必须是对象' };
  const pick = (value, max, field) => {
    if (value === undefined || value === null) return { ok: true, value: null };
    if (typeof value !== 'string') return { ok: false, error: `origin.${field} 必须是字符串` };
    const trimmed = value.trim();
    if (trimmed.length > max) return { ok: false, error: `origin.${field} 超过 ${max} 字符` };
    return { ok: true, value: trimmed || null };
  };
  const source = pick(origin.source, limits.maxSource, 'source');
  if (!source.ok) return source;
  const taskId = pick(origin.taskId, limits.maxTaskId, 'taskId');
  if (!taskId.ok) return taskId;
  const sessionPath = pick(origin.sessionPath, limits.maxSessionPath, 'sessionPath');
  if (!sessionPath.ok) return sessionPath;
  const snippet = pick(origin.snippet, limits.maxSnippet, 'snippet');
  if (!snippet.ok) return snippet;
  return {
    ok: true,
    value: {
      source: source.value || 'unknown',
      taskId: taskId.value,
      sessionPath: sessionPath.value,
      snippet: snippet.value,
      at: nowIso(),
      trust: 'caller-reported',
    },
  };
}

function normalizeDiagnostic(diagnostic, limits = LIMITS) {
  if (diagnostic === undefined || diagnostic === null) return { ok: true, value: null };
  if (typeof diagnostic !== 'object' || Array.isArray(diagnostic)) return { ok: false, error: 'diagnostic 必须是对象' };
  const kind = typeof diagnostic.kind === 'string' ? diagnostic.kind.trim().slice(0, 60) : 'unspecified';
  const message = typeof diagnostic.message === 'string' ? diagnostic.message.trim() : '';
  const snippet = typeof diagnostic.snippet === 'string' ? diagnostic.snippet.trim().slice(0, limits.maxSnippet) : null;
  return { ok: true, value: { kind: kind || 'unspecified', message: message.slice(0, limits.maxDiagnosticMessage), snippet } };
}

function sameOrigin(a, b) {
  if (!a || !b) return false;
  return (a.source || '') === (b.source || '')
    && (a.taskId || '') === (b.taskId || '')
    && (a.sessionPath || '') === (b.sessionPath || '');
}

// ── 候选 id / 摘要 ──────────────────────────────────────
function canonicalProposed(value) {
  const normalizedId = normalizeCardId(value.agent, value.id);
  return {
    agent: value.agent,
    id: String(normalizedId || '').toLowerCase(),
    keywords: [...new Set(value.keywords.map((k) => k.trim().toLowerCase()))].sort(),
    summary: value.summary,
    content: value.content,
    related: [...new Set(value.related)].sort(),
  };
}

function identityOf(value) {
  const normalizedId = normalizeCardId(value.agent, value.id);
  if (!validateId(normalizedId)) return { ok: false, error: 'id 归一化后不是合法 kebab-case' };
  const canonical = canonicalProposed(value);
  const canonicalJson = stableStringify(canonical);
  const candidateId = `cand-${sha256(`kc5-candidate\u0000${canonicalJson}\u0000${value.agent}::${canonical.id}`)}`;
  const proposalDigest = sha256(`kc5-proposal\u0000${canonicalJson}`);
  return { ok: true, candidateId, proposalDigest, identity: `${value.agent}::${canonical.id}` };
}

// ── 记录读写 ─────────────────────────────────────────────
function candidatePath(candidateId) {
  return path.join(CANDIDATES_DIR, `${candidateId}.json`);
}
function receiptKey(candidateId, revision) {
  return `${candidateId}::${revision}`;
}
function receiptPath(candidateId, revision) {
  // 文件名安全：Windows 不允许 ':'，用 __revN 承担 key 的 revision 部分
  return path.join(RECEIPTS_DIR, `${candidateId}__rev${revision}.json`);
}

function sealRecord(record) {
  const body = { ...record };
  delete body.integrity;
  return { ...body, integrity: { algorithm: 'sha256', sha256: sha256(`kc5-candidate-record\u0000${stableStringify(body)}`) } };
}

function recordIntegrityOk(record) {
  const stored = record?.integrity?.sha256;
  if (typeof stored !== 'string' || !HEX64_RE.test(stored)) return false;
  const body = { ...record };
  delete body.integrity;
  return sha256(`kc5-candidate-record\u0000${stableStringify(body)}`) === stored;
}

function readRecord(limits, candidateId) {
  if (!isCandidateId(candidateId)) return fail('INVALID_CANDIDATE_ID', 'candidateId 必须是 cand-<64 hex>');
  const file = candidatePath(candidateId);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return fail('CANDIDATE_NOT_FOUND', `找不到候选：${candidateId}`);
  }
  if (!stat.isFile()) return fail('CANDIDATE_CORRUPT', '候选路径不是普通文件');
  if (stat.size > limits.maxRecordBytes) return fail('CANDIDATE_CORRUPT', `候选记录超过 ${limits.maxRecordBytes} 字节上限`);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fail('CANDIDATE_CORRUPT', `候选记录无法解析：${e.message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('CANDIDATE_CORRUPT', '候选记录不是对象');
  if (raw.schemaVersion === undefined) return fail('CANDIDATE_CORRUPT', '候选记录缺少 schemaVersion');
  if (raw.schemaVersion > SCHEMA_VERSION) {
    return fail('CANDIDATE_SCHEMA_FUTURE', `候选 schemaVersion=${raw.schemaVersion} 高于本版 ${SCHEMA_VERSION}，拒绝读取与覆盖`);
  }
  if (raw.schemaVersion !== SCHEMA_VERSION) return fail('CANDIDATE_CORRUPT', `候选 schemaVersion=${raw.schemaVersion} 不受支持`);
  if (raw.candidateId !== candidateId) return fail('CANDIDATE_CORRUPT', '候选记录 candidateId 与文件名不一致');
  const unknownKeys = Object.keys(raw).filter((k) => !RECORD_KEYS.includes(k));
  if (unknownKeys.length) return fail('CANDIDATE_CORRUPT', `候选记录含未知字段：${unknownKeys.join('、')}`);
  const missing = RECORD_KEYS.filter((k) => !(k in raw));
  if (missing.length) return fail('CANDIDATE_CORRUPT', `候选记录缺少字段：${missing.join('、')}`);
  if (!STATUSES.includes(raw.status)) return fail('CANDIDATE_CORRUPT', `候选 status 非法：${raw.status}`);
  if (!KINDS.includes(raw.kind)) return fail('CANDIDATE_CORRUPT', `候选 kind 非法：${raw.kind}`);
  if (raw.kind === 'content' && (!raw.proposed || typeof raw.proposed !== 'object')) return fail('CANDIDATE_CORRUPT', '内容候选缺少 proposed');
  if (raw.kind === 'diagnostic' && raw.proposed !== null) return fail('CANDIDATE_CORRUPT', '畸形登记候选不应携带 proposed');
  if (!Number.isInteger(raw.revision) || raw.revision < 1) return fail('CANDIDATE_CORRUPT', '候选 revision 非法');
  if (!Array.isArray(raw.origins) || !Array.isArray(raw.history)) return fail('CANDIDATE_CORRUPT', '候选 origins/history 形状非法');
  if (!recordIntegrityOk(raw)) return fail('CANDIDATE_CORRUPT', '候选记录完整性校验失败（可能被外部改写或写入中断）');
  return { ok: true, record: raw };
}

function writeRecord(limits, record) {
  record.updated = nowIso();
  const sealed = sealRecord(record);
  const text = JSON.stringify(sealed);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > limits.maxRecordBytes) return fail('CANDIDATE_RECORD_TOO_LARGE', `候选记录 ${bytes} 字节超过 ${limits.maxRecordBytes} 上限`);
  try {
    atomicWriteFile(candidatePath(record.candidateId), text);
  } catch (e) {
    return fail('CANDIDATE_WRITE_FAILED', `候选记录写入失败：${e.message}`);
  }
  record.integrity = sealed.integrity;
  return { ok: true, bytes };
}

function pushHistory(record, event, detail, limits = LIMITS) {
  record.history.push({ at: nowIso(), event, detail: detail ? String(detail).slice(0, 240) : null });
  if (record.history.length > limits.maxHistory) record.history = record.history.slice(-limits.maxHistory);
}

function capacityOf(limits) {
  let count = 0;
  let bytes = 0;
  try {
    for (const name of fs.readdirSync(CANDIDATES_DIR)) {
      if (!/^cand-[0-9a-f]{64}\.json$/.test(name)) continue;
      count++;
      try { bytes += fs.statSync(path.join(CANDIDATES_DIR, name)).size; } catch { /* 统计失败不阻塞，容量判断偏保守 */ }
    }
  } catch { /* 目录不存在等于空 */ }
  return { count, bytes };
}

// ── 收据读写 ─────────────────────────────────────────────
function baseReceipt(ctx) {
  return {
    schemaVersion: SCHEMA_VERSION,
    key: receiptKey(ctx.candidateId, ctx.reviewedRevision),
    candidateId: ctx.candidateId,
    reviewedRevision: ctx.reviewedRevision,
    phase: 'prepared',
    identity: ctx.identity,
    proposedDigest: ctx.proposalDigest,
    expectedDigest: ctx.expectedDigest,
    plannedCard: ctx.plannedCard,
    plannedDigest: ctx.plannedDigest,
    plannedDigestSource: 'prepare',
    currentDigestAtPrepare: ctx.currentDigest ?? null,
    committedDigest: null,
    reviewSummary: ctx.reviewSummary,
    reviewNote: 'caller declaration only; not human certification',
    created: nowIso(),
    updated: nowIso(),
    history: [],
  };
}

function validateReceiptShape(receipt, candidateId, revision) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return '收据不是对象';
  if (receipt.schemaVersion !== SCHEMA_VERSION) return `收据 schemaVersion=${receipt.schemaVersion} 不受支持`;
  if (receipt.candidateId !== candidateId) return '收据 candidateId 不匹配';
  if (receipt.reviewedRevision !== revision) return '收据 reviewedRevision 不匹配';
  if (receipt.key !== receiptKey(candidateId, revision)) return '收据 key 不匹配';
  if (!RECEIPT_PHASES.includes(receipt.phase)) return `收据 phase 非法：${receipt.phase}`;
  if (receipt.expectedDigest !== 'absent' && !HEX64_RE.test(String(receipt.expectedDigest))) return '收据 expectedDigest 非法';
  if (!HEX64_RE.test(String(receipt.plannedDigest))) return '收据 plannedDigest 非法';
  if (!receipt.plannedCard || typeof receipt.plannedCard !== 'object') return '收据缺少 plannedCard';
  if (!Array.isArray(receipt.history)) return '收据 history 形状非法';
  return null;
}

function readReceipt(limits, candidateId, revision) {
  const file = receiptPath(candidateId, revision);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return { ok: true, receipt: null };
  }
  if (!stat.isFile()) return fail('RECEIPT_CORRUPT', '收据路径不是普通文件');
  if (stat.size > limits.maxReceiptBytes) return fail('RECEIPT_CORRUPT', '收据文件超过大小上限');
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fail('RECEIPT_CORRUPT', `收据无法解析：${e.message}`);
  }
  const problem = validateReceiptShape(parsed, candidateId, revision);
  if (problem) return fail('RECEIPT_CORRUPT', problem);
  return { ok: true, receipt: parsed };
}

function readReceiptSafe(limits, candidateId, revision) {
  const r = readReceipt(limits, candidateId, revision);
  return r.ok ? { receipt: r.receipt, error: null } : { receipt: null, error: r.error, code: r.code };
}

/**
 * 写收据（同步、原子）。语义分层：
 *  - 同一 key+revision 不得把「已提交证据」的 plannedDigest 换成新内容（防止旧回执复用为新内容的已提交证据）。
 *  - 若旧收据处于 prepared/abandoned/conflict（能证明本次审查没提交），允许按新的 base 重规划：
 *    保留旧 plannedDigest 到 history，不静默覆盖历史。
 *  - prepare → writer 的来源升级（writer 给出精确 contentDigest）始终允许。
 */
function writeReceipt(limits, receipt, { source = 'prepare', allowDigestChange = false } = {}) {
  const existing = readReceipt(limits, receipt.candidateId, receipt.reviewedRevision);
  if (existing.ok && existing.receipt) {
    const prev = existing.receipt;
    const digestChanged = prev.plannedDigest !== receipt.plannedDigest;
    if (digestChanged && !allowDigestChange) {
      if (COMMITTED_PHASES.includes(prev.phase)) {
        const err = new Error(`收据 key ${receipt.key} 已记录提交证据（phase=${prev.phase}，内容 ${prev.plannedDigest.slice(0, 12)}…），不得复用为新内容`);
        err.code = 'RECEIPT_KEY_REUSE';
        throw err;
      }
      if (!REPLANNABLE_PHASES.includes(prev.phase)) {
        const err = new Error(`收据 key ${receipt.key} 处于 ${prev.phase}，不能按新计划重写`);
        err.code = 'RECEIPT_KEY_REUSE';
        throw err;
      }
      // 未提交的计划：显式记录一次重规划，旧摘要保留在 history 而不是被抹掉
      const note = `replanned: ${prev.plannedDigest.slice(0, 12)}… (phase=${prev.phase}) -> ${receipt.plannedDigest.slice(0, 12)}…`;
      receipt.history = [
        ...(receipt.history || []),
        { phase: 'replanned', at: nowIso(), note, previousDigest: prev.plannedDigest, previousPhase: prev.phase },
      ];
    }
    receipt.created = prev.created || receipt.created;
    receipt.history = [...(prev.history || []).slice(-(limits.maxReceiptHistory - 1)), ...(receipt.history || [])].slice(-limits.maxReceiptHistory);
  }
  receipt.plannedDigestSource = source;
  receipt.updated = nowIso();
  const text = JSON.stringify(receipt);
  if (Buffer.byteLength(text, 'utf8') > limits.maxReceiptBytes) {
    const err = new Error('收据超过大小上限');
    err.code = 'RECEIPT_TOO_LARGE';
    throw err;
  }
  atomicWriteFile(receiptPath(receipt.candidateId, receipt.reviewedRevision), text);
  return receipt;
}

// ── 正式库目标快照（只读）─────────────────────────────────
function readTargetSnapshot(identity) {
  // 只切第一个 `::`：id 段不参与身份拆分，agent 段必须是形状合法的名字。
  const raw = String(identity || '');
  const sep = raw.indexOf('::');
  const agent = sep < 0 ? '' : raw.slice(0, sep);
  const id = sep < 0 ? '' : raw.slice(sep + 2);
  if (!isValidAgent(agent) || !id) return { error: `目标身份非法：${identity}` };
  let file;
  try {
    file = getJsonlPath(agent);
  } catch (e) {
    return { error: e.message };
  }
  let lines;
  try {
    lines = readAllLines(file);
  } catch (e) {
    return { error: `读取分片失败：${e.message}` };
  }
  const matches = [];
  for (const line of lines) {
    try {
      const card = JSON.parse(line);
      if (card && card.id === id) matches.push(card);
    } catch { /* 坏行由 repository 报诊断；写路径只关心目标身份是否唯一 */ }
  }
  if (matches.length > 1) return { error: '同分片存在重复 id，拒绝在该目标上发布' };
  if (matches.length === 0) return { card: null };
  // 与 card-writer 同口径：缺 agent 字段的历史卡不按跨身份处理；显式不同 agent 才拒
  const cardAgent = matches[0].agent;
  if (cardAgent !== undefined && cardAgent !== agent) return { error: '卡片 agent 与分片物理身份不一致，拒绝发布' };
  return { card: matches[0] };
}

// ── 规划与生命周期 ────────────────────────────────────────
/** 按 card-writer 的合并规则预演写入结果（不写），用于固化 plannedDigest。 */
function planCard(proposed, existingCard) {
  const base = existingCard || {};
  const agent = proposed.agent;
  const id = existingCard ? existingCard.id : normalizeCardId(agent, proposed.id);
  const keywords = [...new Set((proposed.keywords || []).map((k) => k.trim()).filter(Boolean))];
  return normalizeCard({
    ...base,
    id,
    agent,
    source: base.source || `kc--${agent}-note--${id}`,
    keywords,
    score: typeof base.score === 'number' ? base.score : 5,
    summary: proposed.summary,
    content: proposed.content,
    created: base.created || today(),
    lastUpdated: today(),
    related: Array.isArray(proposed.related) ? proposed.related : [],
  });
}

function checkLifecycle(d, identity, currentDigest) {
  if (typeof d.readLifecycle !== 'function') return { checked: false };
  let life;
  try {
    life = d.readLifecycle();
  } catch (e) {
    return { refused: true, result: fail('LIFECYCLE_UNAVAILABLE', `生命周期侧车读取失败：${e.message}`) };
  }
  if (!life || life.ok !== true || life.complete === false) {
    return { refused: true, result: fail('LIFECYCLE_UNAVAILABLE', `生命周期侧车不可用（${life?.error || '未知错误'}），发布已拒绝`) };
  }
  const entry = life.entries && life.entries[identity];
  if (!entry) return { checked: true };
  // 只有绑定到当前内容摘要的条目才生效；摘要不同说明条目属于旧内容，不继承 inactive
  if (entry.targetDigest && entry.targetDigest !== currentDigest) return { checked: true };
  const expired = typeof d.isLifecycleExpired === 'function' ? d.isLifecycleExpired(entry) : false;
  const inactive = ['deprecated', 'superseded', 'archived'].includes(entry.status) || expired;
  if (inactive) {
    return {
      refused: true,
      result: fail(
        'LIFECYCLE_INACTIVE',
        `目标当前内容在生命周期侧车标记为 ${entry.status}${expired ? '（已过期）' : ''}；需先用 kc_store action=annotate（expectedLifecycleRevision+reason）显式解除后再发布`,
        { nextAction: 'annotate' },
      ),
    };
  }
  return { checked: true };
}

// ── 依赖解析（同包模块必须存在；缺失 fail-closed，不静默降级）──
let realDepsPromise = null;
function realDeps() {
  if (!realDepsPromise) {
    realDepsPromise = (async () => {
      const [writer, lock, lifecycle] = await Promise.all([
        import('./card-writer.js'),
        import('./data-lock.js'),
        import('./lifecycle.js'),
      ]);
      if (typeof writer.storeCard !== 'function') throw new Error('card-writer.storeCard 缺失');
      if (typeof lock.withDataLock !== 'function') throw new Error('data-lock.withDataLock 缺失');
      if (typeof lifecycle.readLifecycle !== 'function') throw new Error('lifecycle.readLifecycle 缺失');
      return {
        storeCard: writer.storeCard,
        withLock: lock.withDataLock,
        readLifecycle: lifecycle.readLifecycle,
        isLifecycleExpired: lifecycle.isLifecycleExpired,
        lockMode: 'global',
      };
    })();
  }
  return realDepsPromise;
}

async function resolveDeps(overrides) {
  const limits = { ...LIMITS, ...(overrides.limits || {}) };
  let base;
  try {
    base = await realDeps();
  } catch (e) {
    // 测试/宿主显式注入时可不依赖真实模块；否则绝不无锁继续
    const injected = typeof overrides.storeCard === 'function' && typeof overrides.withLock === 'function';
    if (!injected) return { limits, unavailable: `同包依赖模块不可用：${e?.message || e}` };
    base = { storeCard: null, withLock: null, readLifecycle: null, isLifecycleExpired: null, lockMode: 'injected' };
  }
  const d = { ...base, ...overrides, limits };
  if (typeof d.storeCard !== 'function') return { ...d, unavailable: '依赖缺失：card-writer.storeCard' };
  if (typeof d.withLock !== 'function') return { ...d, unavailable: '依赖缺失：data-lock.withDataLock（拒绝无锁继续）' };
  return d;
}

async function runLocked(d, fn) {
  try {
    // 同进程写队列 + 共享数据锁：短同步临界区，回调内绝不 await。
    const value = await enqueueDataWrite(() => d.withLock(fn));
    return { ok: true, value };
  } catch (e) {
    const code = ['LOCK_BUSY', 'LOCK_TIMEOUT', 'LOCK_HELD', 'ELOCKED', 'E_LOCKED'].includes(e?.code) ? 'LOCK_BUSY' : 'CANDIDATE_STORE_ERROR';
    return { ok: false, value: fail(code, `候选临界区执行失败：${e?.message || e}`) };
  }
}

// ── propose ──────────────────────────────────────────────
function mergeOrigin(limits, record, origin) {
  if (!origin || record.origins.some((o) => sameOrigin(o, origin))) return false;
  if (record.origins.length < limits.maxOrigins) record.origins.push(origin);
  else record.originOverflow = (record.originOverflow || 0) + 1;
  record.revision += 1;
  pushHistory(record, 'origin-merged', origin.source, limits);
  return true;
}

function createRecord(limits, ident, { kind, proposed, diagnostic, origin }) {
  const capacity = capacityOf(limits);
  if (capacity.count >= limits.maxCandidates) {
    return fail('CANDIDATE_CAPACITY', `候选数量已达上限 ${limits.maxCandidates}。reject 不会释放容量；需先备份，再按人工归档流程清理 ${CANDIDATES_DIR} 下的候选文件`);
  }
  const created = nowIso();
  const record = {
    schemaVersion: SCHEMA_VERSION,
    candidateId: ident.candidateId,
    kind,
    identity: ident.identity,
    proposed,
    digest: { proposal: ident.proposalDigest },
    status: 'pending',
    revision: 1,
    created,
    updated: created,
    origins: origin ? [origin] : [],
    originOverflow: 0,
    diagnostic: diagnostic || null,
    review: null,
    intent: null,
    publishedDigest: null,
    lastReconcile: null,
    history: [],
  };
  pushHistory(record, 'created', origin?.source || 'manual', limits);
  const written = writeRecord(limits, record);
  if (!written.ok) return written;
  if (capacity.bytes + (written.bytes || 0) > limits.maxTotalBytes) {
    // 写入后总量超限：回滚该文件，保持容量契约
    let rollbackError=null;
    try { fs.unlinkSync(candidatePath(record.candidateId)); } catch(e) { if(e?.code!=='ENOENT')rollbackError=String(e?.code||e?.message||e); }
    return fail('CANDIDATE_CAPACITY', `候选目录总量将超过 ${limits.maxTotalBytes} 字节上限。reject 不会释放容量；需先备份，再按人工归档流程清理候选文件`,{rollbackPending:rollbackError!==null,rollbackError});
  }
  return { ok: true, record, bytes: written.bytes || 0 };
}

/** 畸形登记：没有可发布的 proposed，只留一条可审计的 diagnostic 候选（kind=diagnostic）。 */
function diagnosticIdentity(diagnostic, origin) {
  const seed = stableStringify({
    kind: diagnostic.kind,
    message: diagnostic.message,
    snippet: diagnostic.snippet || null,
    origin: origin ? { source: origin.source, taskId: origin.taskId, sessionPath: origin.sessionPath } : null,
  });
  return {
    candidateId: `cand-${sha256(`kc5-diagnostic\u0000${seed}`)}`,
    proposalDigest: sha256(`kc5-diagnostic-proposal\u0000${seed}`),
    identity: `diagnostic::${diagnostic.kind}`,
  };
}

async function proposeImpl(overrides, input) {
  const d = await resolveDeps(overrides);
  if (d.unavailable) return fail('DEPENDENCY_UNAVAILABLE', d.unavailable);
  const limits = d.limits;
  const diagnostic = normalizeDiagnostic(input?.diagnostic, limits);
  if (!diagnostic.ok) return fail('INVALID_DIAGNOSTIC', diagnostic.error);
  const origin = normalizeOrigin(input?.origin, limits);
  if (!origin.ok) return fail('INVALID_ORIGIN', origin.error);
  const hasProposed = input?.proposed !== undefined && input?.proposed !== null;

  // ── 畸形登记分支（不需要 proposed）──
  if (!hasProposed) {
    if (!diagnostic.value) {
      return fail('INVALID_PROPOSED', '缺少 proposed：内容候选必须给出 proposed；畸形输入请提供 diagnostic{kind,message}');
    }
    const ident = diagnosticIdentity(diagnostic.value, origin.value);
    const locked = await runLocked(d, () => {
      const found = readRecord(limits, ident.candidateId);
      if (found.ok) {
        const record = found.record;
        if (record.kind !== 'diagnostic' || record.digest.proposal !== ident.proposalDigest) {
          return fail('CANDIDATE_ID_COLLISION', '畸形登记 id 命中但内容不同，拒绝覆盖');
        }
        const merged = mergeOrigin(limits, record, origin.value);
        if (merged) {
          const written = writeRecord(limits, record);
          if (!written.ok) return written;
        }
        return { ok: false, code: 'DIAGNOSTIC_REGISTERED', registered: true, duplicate: !merged, kind: 'diagnostic', candidateId: record.candidateId, revision: record.revision, status: record.status, identity: record.identity };
      }
      if (found.code !== 'CANDIDATE_NOT_FOUND') return found;
      const created = createRecord(limits, ident, { kind: 'diagnostic', proposed: null, diagnostic: diagnostic.value, origin: origin.value });
      if (!created.ok) return created;
      return { ok: false, code: 'DIAGNOSTIC_REGISTERED', registered: true, created: true, kind: 'diagnostic', candidateId: ident.candidateId, revision: 1, status: 'pending', identity: ident.identity };
    });
    return locked.value;
  }

  const check = validateProposed(input.proposed, limits);
  if (!check.ok) return fail('INVALID_PROPOSED', check.errors.join('；'), { errors: check.errors });
  const ident = identityOf(check.value);
  if (!ident.ok) return fail('INVALID_PROPOSED', ident.error);

  const locked = await runLocked(d, () => {
    const found = readRecord(limits, ident.candidateId);
    if (found.ok) {
      const record = found.record;
      if (record.kind !== 'content' || record.digest.proposal !== ident.proposalDigest) {
        return fail('CANDIDATE_ID_COLLISION', '候选 id 命中但内容不同，拒绝覆盖（哈希碰撞或记录被改写）');
      }
      const merged = mergeOrigin(limits, record, origin.value);
      if (merged) {
        const written = writeRecord(limits, record);
        if (!written.ok) return written;
      }
      return { ok: true, candidateId: record.candidateId, revision: record.revision, created: false, duplicate: !merged, kind: 'content', status: record.status, origins: record.origins.length };
    }
    if (found.code !== 'CANDIDATE_NOT_FOUND') return found;

    const created = createRecord(limits, ident, { kind: 'content', proposed: check.value, diagnostic: diagnostic.value, origin: origin.value });
    if (!created.ok) return created;
    return { ok: true, candidateId: ident.candidateId, revision: 1, created: true, duplicate: false, kind: 'content', status: 'pending', origins: created.record.origins.length };
  });
  return locked.value;
}

// ── read / list ──────────────────────────────────────────
function publicCandidate(record) {
  const { integrity, ...rest } = record;
  return {
    ...rest,
    integrityVerified: true,
    publishable: record.kind === 'content' && record.status === 'pending',
  };
}

function readImpl(overrides, candidateId) {
  const limits = { ...LIMITS, ...(overrides.limits || {}) };
  const r = readRecord(limits, candidateId);
  if (!r.ok) return r;
  return { ok: true, candidate: publicCandidate(r.record) };
}

function listImpl(overrides, options = {}) {
  const limits = { ...LIMITS, ...(overrides.limits || {}) };
  const status = options?.status;
  if (status !== undefined && status !== null && status !== 'all' && !STATUSES.includes(status)) {
    return fail('INVALID_STATUS', `status 必须是 ${STATUSES.join('/')} 之一`);
  }
  const limitRaw = options?.limit;
  const limit = Number.isInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), limits.listLimitMax) : limits.listLimitDefault;
  const offset = Number.isInteger(options?.offset) && options.offset > 0 ? options.offset : 0;

  let names = [];
  try {
    names = fs.readdirSync(CANDIDATES_DIR).filter((n) => /^cand-[0-9a-f]{64}\.json$/.test(n)).sort();
  } catch (e) {
    if (e?.code === 'ENOENT') {
      // 目录不存在 = 没有任何候选（正常空）
      return { ok: true, complete: true, items: [], total: 0, lowerBound: 0, truncated: false, nextOffset: null, diagnostics: [], limit, offset };
    }
    // 路径不是目录 / 无权限 / 其它错误 = 不可用，绝不伪装成空库
    return fail('CANDIDATES_UNAVAILABLE', `候选目录不可读（${e?.code || e?.message}）`, {
      complete: false, items: [], total: null, lowerBound: 0, truncated: true, nextOffset: null,
      diagnostics: [{ code: 'candidates-unreadable', error: String(e?.message || e) }], limit, offset,
    });
  }

  // 有界扫描：最多 maxCandidates 个文件 / maxTotalBytes 字节
  const diagnostics = [];
  const readable = [];
  let scannedFiles = 0;
  let scannedBytes = 0;
  let scanExhausted = false;
  for (const name of names) {
    if (scannedFiles >= limits.maxCandidates) { scanExhausted = true; break; }
    let size = 0;
    try { size = fs.statSync(path.join(CANDIDATES_DIR, name)).size; } catch { /* readRecord 会报 */ }
    if (scannedBytes + size > limits.maxTotalBytes) { scanExhausted = true; break; }
    scannedFiles++;
    scannedBytes += size;
    const id = name.slice(0, -5);
    const r = readRecord(limits, id);
    if (!r.ok) {
      diagnostics.push({ candidateId: id, code: r.code, error: r.error });
      continue;
    }
    const rec = r.record;
    if (status && status !== 'all' && rec.status !== status) continue;
    readable.push({
      candidateId: rec.candidateId,
      kind: rec.kind,
      identity: rec.identity,
      agent: rec.proposed ? rec.proposed.agent : null,
      id: rec.proposed ? rec.proposed.id : null,
      status: rec.status,
      revision: rec.revision,
      summary: rec.proposed ? rec.proposed.summary : (rec.diagnostic?.message || '').slice(0, 100),
      keywords: rec.proposed ? rec.proposed.keywords : [],
      publishable: rec.kind === 'content' && rec.status === 'pending',
      origins: rec.origins.length,
      hasIntent: !!rec.intent,
      reviewed: !!rec.review,
      diagnostic: rec.diagnostic ? rec.diagnostic.kind : null,
      created: rec.created,
      updated: rec.updated,
    });
  }
  if (scanExhausted) {
    diagnostics.push({ code: 'scan-truncated', error: `候选扫描达到上限（${limits.maxCandidates} 个 / ${limits.maxTotalBytes} 字节），结果不完整` });
  }

  readable.sort((a, b) => (a.updated === b.updated ? (a.candidateId < b.candidateId ? -1 : 1) : (a.updated > b.updated ? -1 : 1)));
  const lowerBound = readable.length;
  const page = readable.slice(offset, offset + limit);
  const pagingMore = offset + page.length < lowerBound;
  const complete = !scanExhausted && diagnostics.length === 0;
  const nextOffset = pagingMore ? offset + page.length : null;
  return {
    ok: complete,
    complete,
    ...(complete ? {} : { code: scanExhausted ? 'CANDIDATES_SCAN_TRUNCATED' : 'CANDIDATES_INCOMPLETE', error: diagnostics[0]?.error || '候选库不完整，total 只是可读项下界' }),
    items: page,
    total: complete ? lowerBound : null,
    lowerBound,
    truncated: !complete || pagingMore,
    nextOffset,
    diagnostics,
    limit,
    offset,
  };
}

// ── reject ───────────────────────────────────────────────
async function rejectImpl(overrides, input) {
  const d = await resolveDeps(overrides);
  if (d.unavailable) return fail('DEPENDENCY_UNAVAILABLE', d.unavailable);
  const limits = d.limits;
  const candidateId = input?.candidateId;
  if (!isCandidateId(candidateId)) return fail('INVALID_CANDIDATE_ID', 'candidateId 必须是 cand-<64 hex>');
  if (!Number.isInteger(input?.expectedRevision) || input.expectedRevision < 1) return fail('INVALID_REVISION', 'expectedRevision 必须是 >=1 的整数');
  const reason = typeof input?.reason === 'string' ? input.reason.trim() : '';
  if (!reason) return fail('INVALID_REASON', 'reject 必须给出非空 reason');
  if (reason.length > limits.maxReason) return fail('INVALID_REASON', `reason 超过 ${limits.maxReason} 字`);

  const locked = await runLocked(d, () => {
    const found = readRecord(limits, candidateId);
    if (!found.ok) return found;
    const record = found.record;
    if (record.revision !== input.expectedRevision) {
      return fail('REVISION_CONFLICT', `候选 revision 已变为 ${record.revision}，请基于当前版本重新审查`, { currentRevision: record.revision });
    }
    if (record.status === 'rejected') return { ok: true, changed: false, status: 'rejected', candidateId, revision: record.revision };
    if (record.status === 'published' || record.status === 'published-superseded') {
      return fail('PUBLISHED_CANNOT_REJECT', '候选已有发布历史，reject 不能反向假回滚正式库');
    }
    if (record.status === 'publishing' || record.intent) {
      return fail('PUBLICATION_IN_PROGRESS', '候选存在未闭合的发布意图，先 reconcile（恢复或显式 abandon）再 reject', { nextAction: 'reconcile' });
    }
    if (record.status === 'conflict') {
      return fail('INTENT_CONFLICT', '候选处于发布冲突，先 reconcile 显式 abandon 再 reject', { nextAction: 'reconcile' });
    }
    record.status = 'rejected';
    record.lastReconcile = { action: 'reject', reason, at: nowIso() };
    pushHistory(record, 'rejected', reason, limits);
    const written = writeRecord(limits, record);
    if (!written.ok) return written;
    return { ok: true, changed: true, status: 'rejected', candidateId, revision: record.revision };
  });
  return locked.value;
}

// ── publish ──────────────────────────────────────────────
function normalizeExpectedDigest(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === 'absent') return 'absent';
  if (HEX64_RE.test(trimmed)) return trimmed;
  return null;
}

function enterPublishing(limits, record, ctx) {
  record.status = 'publishing';
  record.intent = {
    phase: 'prepared',
    reviewedRevision: ctx.reviewedRevision,
    expectedDigest: ctx.expectedDigest,
    plannedDigest: ctx.plannedDigest,
    plannedCard: ctx.plannedCard,
    at: nowIso(),
  };
  pushHistory(record, 'publish-prepared', `rev ${ctx.reviewedRevision}`, limits);
  return writeRecord(limits, record);
}

function markAlreadyPresent(limits, record, { digest, reviewedRevision, reviewSummary }) {
  record.status = 'already-present';
  record.intent = null;
  record.publishedDigest = digest;
  record.review = { reviewedRevision, summary: reviewSummary || record.review?.summary || null, at: nowIso(), declarationOnly: true, note: 'existing content; no commit in this publish call' };
  pushHistory(record, 'already-present', `rev ${reviewedRevision}`, limits);
  return writeRecord(limits, record);
}

function resetToPending(limits, record, event, detail) {
  record.status = 'pending';
  record.intent = null;
  pushHistory(record, event, detail, limits);
  return writeRecord(limits, record);
}

function markPublished(limits, record, { digest, reviewedRevision, reviewSummary, receipt, receiptPhase = 'finalized' }) {
  record.status = 'published';
  record.intent = null;
  record.publishedDigest = digest;
  record.review = { reviewedRevision, summary: reviewSummary || record.review?.summary || null, at: nowIso(), declarationOnly: true, note: 'caller declaration; not human certification' };
  pushHistory(record, 'published', `rev ${reviewedRevision}`, limits);
  let receiptError = null;
  if (receipt) {
    try {
      writeReceipt(receipt.limits || limits, {
        ...receipt.value,
        phase: receiptPhase,
        committedDigest: digest,
        plannedDigest: digest,
        history: [{ phase: receiptPhase, at: nowIso(), note: 'finalize' }],
      }, { source: 'prepare' });
    } catch (e) {
      receiptError = e.message;
    }
  }
  const written = writeRecord(limits, record);
  return { written, receiptError };
}

/**
 * 恢复未闭合的发布意图（同步、锁内）。
 * 返回 {kind:'continue'} 表示意图已清、可继续正常发布；
 * 返回 {kind:'done', result} 表示已有结论（已恢复发布 / 冲突 / 需 reconcile）。
 */
function recoverIntent(limits, record, target, actualDigest, reviewSummary, lockMode) {
  const intent = record.intent;
  const rev = intent?.reviewedRevision ?? record.revision;
  const receiptInfo = readReceiptSafe(limits, record.candidateId, rev);
  const receipt = receiptInfo.receipt;
  const planned = intent?.plannedDigest || receipt?.plannedDigest || null;
  const expected = intent?.expectedDigest ?? receipt?.expectedDigest ?? null;

  if (!planned && !receipt) {
    record.status = 'conflict';
    record.lastReconcile = { action: 'conflict', reason: 'intent-lost', at: nowIso() };
    pushHistory(record, 'intent-lost', '候选处于 publishing 但找不到发布意图', limits);
    const written = writeRecord(limits, record);
    if (!written.ok) return { kind: 'done', result: written };
    return { kind: 'done', result: fail('INTENT_LOST', '候选处于 publishing 但发布意图缺失；需显式 reconcile(abandon:true) 清理', { nextAction: 'reconcile' }) };
  }

  if (planned && actualDigest === planned && expected === planned && !(receipt && ['committed', 'finalized'].includes(receipt.phase))) {
    // The target already contained this content before the attempted publish.
    // A prepared receipt alone is not commit evidence.
    const written = markAlreadyPresent(limits, record, { digest: actualDigest, reviewedRevision: rev, reviewSummary });
    if (!written.ok) return { kind: 'done', result: { ...written, committed: false, statusPending: true } };
    return { kind: 'done', result: { ok: true, committed: false, alreadyPresent: true, recovered: true, status: 'already-present', candidateId: record.candidateId, revision: record.revision, lockMode, details: { status: 'already-present', receiptPhase: 'prepared', plannedDigest: actualDigest, expectedDigest: expected, currentDigest: actualDigest, reviewedRevision: rev, identity: record.identity } } };
  }

  if (planned && actualDigest === planned && expected !== null && (expected !== planned || (receipt && ['committed', 'finalized'].includes(receipt.phase)))) {
    const receiptForWrite = receipt
      ? { value: receipt, limits }
      : { value: baseReceipt({ candidateId: record.candidateId, reviewedRevision: rev, identity: record.identity, proposalDigest: record.digest.proposal, expectedDigest: expected || 'absent', plannedCard: intent?.plannedCard || target.card, plannedDigest: planned, reviewSummary, currentDigest: actualDigest }), limits };
    const out = markPublished(limits, record, { digest: actualDigest, reviewedRevision: rev, reviewSummary, receipt: receiptForWrite });
    if (!out.written.ok) return { kind: 'done', result: { ...out.written, committed: true, statusPending: true } };
    return {
      kind: 'done',
      result: {
        ok: true, committed: true, recovered: true, status: 'published', candidateId: record.candidateId,
        revision: record.revision, lockMode, receiptError: out.receiptError,
        details: { status: 'published', receiptPhase: 'finalized', plannedDigest: actualDigest, expectedDigest: expected, currentDigest: actualDigest, reviewedRevision: rev, identity: record.identity },
      },
    };
  }

  const committedEvidence = receipt && (receipt.phase === 'committed' || receipt.phase === 'finalized');
  if (committedEvidence) {
    return {
      kind: 'done',
      result: fail('PUBLISHED_SUPERSEDED_PENDING_RECONCILE', '发布意图已提交但当前目标已被改写；需 reconcile 标记 published-superseded（不改正式卡）', {
        nextAction: 'reconcile', committedDigest: receipt.committedDigest || null, currentDigest: actualDigest,
      }),
    };
  }

  if (expected !== null && actualDigest === expected) {
    // 目标仍是发布前摘要：安全清意图、回 pending，可按 CAS 重试
    const reset = resetToPending(limits, record, 'intent-reset', '目标未变，释放过期发布意图');
    if (!reset.ok) return { kind: 'done', result: reset };
    return { kind: 'continue' };
  }

  record.status = 'conflict';
  record.lastReconcile = { action: 'conflict', reason: 'target-changed', at: nowIso() };
  pushHistory(record, 'intent-conflict', `current=${String(actualDigest).slice(0, 12)}`, limits);
  const written = writeRecord(limits, record);
  if (!written.ok) return { kind: 'done', result: written };
  return {
    kind: 'done',
    result: fail('INTENT_CONFLICT', '发布意图准备后目标被改成其它摘要；需显式 reconcile(abandon:true) 清理候选意图（正式卡不动）', {
      nextAction: 'reconcile', currentDigest: actualDigest, plannedDigest: planned,
    }),
  };
}

function preparePublish(d, params) {
  const limits = d.limits;
  const found = readRecord(limits, params.candidateId);
  if (!found.ok) return found;
  const record = found.record;

  if (record.kind !== 'content') {
    return fail('DIAGNOSTIC_NOT_PUBLISHABLE', '畸形登记候选只作审计，不能发布为正式卡');
  }

  if (record.revision !== params.expectedRevision) {
    return fail('REVISION_CONFLICT', `候选 revision 已变为 ${record.revision}，请基于当前版本重新审查`, { currentRevision: record.revision });
  }
  if (record.status === 'published') {
    return {
      ok: true, alreadyPublished: true, committed: false, status: 'published', candidateId: record.candidateId,
      revision: record.revision, lockMode: d.lockMode,
      details: { status: 'published', receiptPhase: 'finalized', plannedDigest: record.publishedDigest, expectedDigest: params.expectedTargetDigest, currentDigest: record.publishedDigest, reviewedRevision: record.review?.reviewedRevision ?? record.revision, identity: record.identity },
    };
  }
  const target = readTargetSnapshot(record.identity);
  if (target.error) return fail('TARGET_UNREADABLE', target.error);
  const actualDigest = target.card ? digestCard(target.card) : 'absent';
  if (record.status === 'already-present') {
    if (actualDigest !== record.publishedDigest) return fail('TARGET_CHANGED', '已存在内容已被删除或更新，请先 reconcile 核对当前正式卡', { nextAction: 'reconcile', currentDigest: actualDigest, previousDigest: record.publishedDigest });
    return { ok: true, alreadyPresent: true, committed: false, status: 'already-present', candidateId: record.candidateId,
      revision: record.revision, lockMode: d.lockMode,
      details: { status: 'already-present', plannedDigest: record.publishedDigest, expectedDigest: params.expectedTargetDigest, currentDigest: actualDigest, reviewedRevision: record.review?.reviewedRevision ?? record.revision, identity: record.identity },
    };
  }
  if (record.status === 'rejected') return fail('CANDIDATE_REJECTED', '候选已被拒绝，不能发布');
  if (record.status === 'published-superseded') return fail('PUBLISHED_SUPERSEDED', '候选发布内容已被后续写入替代，不能再发布同一历史版本');

  if (record.status === 'publishing') {
    const recovered = recoverIntent(limits, record, target, actualDigest, params.reviewSummary, d.lockMode);
    if (recovered.kind === 'done') return recovered.result;
  }

  if (record.status === 'conflict') {
    return fail('INTENT_CONFLICT', '候选存在未闭合的发布冲突，先 reconcile（可显式 abandon）再发布', { nextAction: 'reconcile', currentDigest: actualDigest });
  }

  // 目标摘要 CAS（发布前快照）
  if (params.expectedTargetDigest === 'absent') {
    if (target.card) return fail('TARGET_CONFLICT', '目标已存在，expectedTargetDigest=absent 不再成立', { currentDigest: actualDigest });
  } else {
    if (!target.card) return fail('TARGET_CONFLICT', '目标不存在，无法按给定摘要更新', { currentDigest: 'absent' });
    if (actualDigest !== params.expectedTargetDigest) {
      return fail('TARGET_CONFLICT', '目标当前摘要与 expectedTargetDigest 不一致', { currentDigest: actualDigest });
    }
  }

  const lifecycle = checkLifecycle(d, record.identity, actualDigest);
  if (lifecycle.refused) return lifecycle.result;

  const plannedCard = planCard(record.proposed, target.card);
  const plannedDigest = digestCard(plannedCard);
  const ctx = {
    candidateId: record.candidateId,
    identity: record.identity,
    reviewedRevision: record.revision,
    expectedDigest: params.expectedTargetDigest,
    reviewSummary: params.reviewSummary,
    plannedCard,
    plannedDigest,
    proposalDigest: record.digest.proposal,
    currentDigest: actualDigest,
    lifecycleChecked: lifecycle.checked,
    lockMode: d.lockMode,
  };

  const claimed = enterPublishing(limits, record, ctx);
  if (!claimed.ok) return claimed;

  try {
    writeReceipt(limits, {
      ...baseReceipt(ctx),
      history: [{ phase: 'prepared', at: nowIso(), note: 'claimed in candidate lock' }],
    });
  } catch (e) {
    record.status = 'pending';
    record.intent = null;
    pushHistory(record, 'prepare-rollback', e.message, limits);
    const rolled = writeRecord(limits, record);
    if (!rolled.ok) {
      return fail('RECEIPT_WRITE_FAILED', `发布准备收据写入失败且候选回滚失败（${e.message} / ${rolled.error}）；请 reconcile`, { nextAction: 'reconcile', statusPending: true });
    }
    return fail('RECEIPT_WRITE_FAILED', `发布准备收据写入失败，未提交正式卡：${e.message}`);
  }

  return { ok: true, ready: true, ctx };
}

function finalizePublish(d, ctx, stored) {
  const limits = d.limits;
  const found = readRecord(limits, ctx.candidateId);
  if (!found.ok) {
    return { ...found, committed: !!stored?.committed, statusPending: true };
  }
  const record = found.record;
  const receiptInfo = readReceiptSafe(limits, ctx.candidateId, ctx.reviewedRevision);
  const receipt = receiptInfo.receipt;
  const plannedDigest = receipt?.plannedDigest || ctx.plannedDigest;

  const target = readTargetSnapshot(ctx.identity);

  if (target.error) {
    if (stored?.committed) {
      // 已提交但读不回目标：保留意图，如实报 committed + statusPending
      try {
        writeReceipt(limits, { ...(receipt || baseReceipt(ctx)), phase: 'committed', committedDigest: stored.contentDigest || plannedDigest, history: [{ phase: 'committed', at: nowIso(), note: 'finalize deferred' }] });
      } catch { /* 收据失败已由下方字段体现 */ }
      return { ok: true, committed: true, statusPending: true, code: 'FINALIZE_DEFERRED', error: target.error, status: 'publishing', candidateId: ctx.candidateId, revision: record.revision, lockMode: d.lockMode };
    }
    return fail('TARGET_UNREADABLE', target.error, { committed: false, nextAction: 'reconcile' });
  }
  const actualDigest = target.card ? digestCard(target.card) : 'absent';

  // An identical formal card may satisfy the proposal without a new commit.
  // Do not infer a commit merely from digest equality: storeCard deliberately
  // returns skipped+committed=false for this case.
  if (stored?.ok && stored.skipped && actualDigest === plannedDigest && record.status !== 'rejected') {
    const written = markAlreadyPresent(limits, record, { digest: actualDigest, reviewedRevision: ctx.reviewedRevision, reviewSummary: receipt?.reviewSummary || ctx.reviewSummary });
    if (!written.ok) return { ...written, committed: false, statusPending: true };
    return { ok: true, committed: false, alreadyPresent: true, status: 'already-present',
      candidateId: ctx.candidateId, revision: record.revision, lockMode: d.lockMode,
      details: { status: 'already-present', plannedDigest: actualDigest, expectedDigest: ctx.expectedDigest, currentDigest: actualDigest, reviewedRevision: ctx.reviewedRevision, identity: ctx.identity },
    };
  }

  if (actualDigest === plannedDigest) {
    if (record.status === 'rejected') {
      // 罕见竞争：意图被并发 abandon 后候选又被 reject，而本次提交已发生。正式卡不假改，候选也不假翻回。
      return fail('CANDIDATE_STATUS_CONFLICT', '正式卡已提交，但候选已被并发标记 rejected；需人工核对后用 reconcile/kc_verify 收口（本模块不会自动改写任一侧）', {
        committed: true, statusPending: true, status: 'rejected', currentDigest: actualDigest,
      });
    }
    const receiptForWrite = { value: receipt || baseReceipt(ctx), limits };
    const out = markPublished(limits, record, { digest: actualDigest, reviewedRevision: ctx.reviewedRevision, reviewSummary: receipt?.reviewSummary || ctx.reviewSummary, receipt: receiptForWrite });
    if (!out.written.ok) {
      return { ok: true, committed: true, statusPending: true, code: 'FINALIZE_DEFERRED', error: out.written.error, status: 'publishing', candidateId: ctx.candidateId, revision: record.revision, lockMode: d.lockMode, receiptError: out.receiptError };
    }
    return {
      ok: true, committed: true, recovered: !(stored && stored.committed === true), status: 'published',
      candidateId: ctx.candidateId, revision: record.revision, lockMode: d.lockMode,
      indexError: stored?.indexError || null, receiptError: out.receiptError,
      details: { status: 'published', receiptPhase: 'finalized', plannedDigest: actualDigest, expectedDigest: ctx.expectedDigest, currentDigest: actualDigest, reviewedRevision: ctx.reviewedRevision, identity: ctx.identity, lifecycleChecked: ctx.lifecycleChecked },
    };
  }

  if (stored?.thrown || ['BEFORE_COMMIT_FAILED', 'INVALID_BEFORE_COMMIT', 'BEFORE_COMMIT_ASYNC'].includes(stored?.code)) {
    const text = String(stored?.error || '');
    const mapped = ['LIFECYCLE_INACTIVE', 'LIFECYCLE_UNAVAILABLE', 'RECEIPT_WRITE_FAILED', 'CANDIDATE_UNREADABLE', 'CANDIDATE_STATUS_CONFLICT'].find((code) => text.includes(code));
    if (mapped === 'CANDIDATE_STATUS_CONFLICT' || mapped === 'CANDIDATE_UNREADABLE') {
      // 写者在提交前被拒：正式卡未动。不把候选改回 pending（raced abandon/reject 已经给了结论），
      // 也不宣称发布成功；如实交回调用方核对当前候选状态。
      return fail(mapped, `发布在提交前被拒（候选意图已被并发收回或不可读），未写入正式卡：${text}`, {
        committed: false, status: record.status, currentDigest: actualDigest, nextAction: 'reconcile',
      });
    }
    if (mapped) {
      return fail(mapped, `发布在提交前被拒，未写入正式卡：${text}`, {
        committed: false, nextAction: mapped === 'LIFECYCLE_INACTIVE' ? 'annotate' : 'reconcile', status: 'publishing', currentDigest: actualDigest,
      });
    }
    return fail(stored.code || 'STORE_THREW', `正式卡写入异常，候选意图保留待 reconcile：${stored.error}`, {
      committed: false, nextAction: 'reconcile', status: 'publishing', currentDigest: actualDigest,
    });
  }
  if (stored?.committed) {
    record.status = 'conflict';
    record.lastReconcile = { action: 'conflict', reason: 'committed-digest-mismatch', at: nowIso() };
    pushHistory(record, 'commit-digest-mismatch', `actual=${String(actualDigest).slice(0, 12)}`, limits);
    writeRecord(limits, record);
    try { writeReceipt(limits, { ...(receipt || baseReceipt(ctx)), phase: 'conflict', committedDigest: stored.contentDigest || null, history: [{ phase: 'conflict', at: nowIso(), note: 'committed digest differs from planned' }] }); } catch { /* 收据失败不掩盖冲突结论 */ }
    return fail('COMMIT_UNVERIFIED', '写者报告已提交，但目标摘要与预审 plannedDigest 不一致；不宣称发布成功', { committed: true, currentDigest: actualDigest, plannedDigest });
  }
  if (stored?.conflict) {
    record.status = 'conflict';
    record.lastReconcile = { action: 'conflict', reason: 'target-conflict', at: nowIso() };
    pushHistory(record, 'target-conflict', `current=${String(actualDigest).slice(0, 12)}`, limits);
    writeRecord(limits, record);
    try { writeReceipt(limits, { ...(receipt || baseReceipt(ctx)), phase: 'conflict', history: [{ phase: 'conflict', at: nowIso(), note: 'storeCard conflict' }] }); } catch { /* 同上 */ }
    return fail('TARGET_CONFLICT', '写者报告目标摘要冲突，未提交；候选意图需 reconcile', {
      committed: false, currentDigest: actualDigest, nextAction: 'reconcile', status: 'conflict',
    });
  }
  if (stored?.ok && stored.skipped) {
    const reset = resetToPending(limits, record, 'identical-metadata-differs', '目标已有相同正文但摘要不同');
    if (!reset.ok) return { ...reset, statusPending: true };
    return { ok: true, committed: false, skipped: true, code: 'TARGET_IDENTICAL_METADATA_DIFFERS', status: 'pending', currentDigest: actualDigest };
  }

  // 干净失败：写者明确未提交
  if (actualDigest === ctx.expectedDigest) {
    const reset = resetToPending(limits, record, 'store-failed', stored?.error || 'storeCard 未提交');
    if (!reset.ok) return { ...reset, statusPending: true, committed: false };
    return fail(stored?.code || 'STORE_FAILED', stored?.error || 'storeCard 未提交正式卡', { committed: false, status: 'pending' });
  }
  record.status = 'conflict';
  record.lastReconcile = { action: 'conflict', reason: 'target-changed-during-store', at: nowIso() };
  pushHistory(record, 'target-changed', `current=${String(actualDigest).slice(0, 12)}`, limits);
  writeRecord(limits, record);
  return fail('TARGET_CONFLICT', '写者未提交，且目标在发布过程中被改成其它摘要', { committed: false, currentDigest: actualDigest, nextAction: 'reconcile', status: 'conflict' });
}

/**
 * 锁内复查「本次发布仍持有候选意图」。
 * 返回 null 表示仍可提交；否则返回拒因。
 * 只读判断，不改记录：产生冲突时由 finalize 分支收口（保留 committed 事实与候选现状，不假装回滚）。
 */
function claimLossReason(record, ctx) {
  if (record.candidateId !== ctx.candidateId) {
    return { code: 'CANDIDATE_STATUS_CONFLICT', error: '提交前候选身份变化' };
  }
  if (record.revision !== ctx.reviewedRevision) {
    return { code: 'CANDIDATE_STATUS_CONFLICT', error: `提交前候选 revision 已变为 ${record.revision}（本次审查基于 ${ctx.reviewedRevision}）` };
  }
  if (record.status !== 'publishing') {
    return { code: 'CANDIDATE_STATUS_CONFLICT', error: `提交前候选已被并发改为 ${record.status}（本次发布意图已失效）` };
  }
  const intent = record.intent;
  if (!intent) return { code: 'CANDIDATE_STATUS_CONFLICT', error: '提交前候选发布意图已被并发清除（abandon 已生效）' };
  if (intent.reviewedRevision !== ctx.reviewedRevision) {
    return { code: 'CANDIDATE_STATUS_CONFLICT', error: '提交前发布意图已被替换为另一次审查' };
  }
  if (intent.plannedDigest && intent.plannedDigest !== ctx.plannedDigest) {
    return { code: 'CANDIDATE_STATUS_CONFLICT', error: '提交前发布意图的计划摘要已被改写' };
  }
  return null;
}

async function callWriter(d, ctx) {
  const options = { expectedDigest: ctx.expectedDigest, reason: ctx.reviewSummary };
  if (ctx.expectedDigest === 'absent') options.mode = 'create-or-identical';
  options.beforeCommit = (info) => {
    // 【禁止】此处运行在 card-writer 的数据锁内且必须同步：不得再取 dataLock（会自锁），不得 await。
    const card = info?.card;
    const contentDigest = info?.contentDigest;
    if (!card || typeof contentDigest !== 'string' || !HEX64_RE.test(contentDigest)) {
      const err = new Error('BEFORE_COMMIT_CONTRACT: beforeCommit 契约异常，缺少精确 card/contentDigest');
      err.code = 'BEFORE_COMMIT_CONTRACT';
      throw err;
    }
    // prepare 到 commit 之间可能发生 annotate（同一数据锁串行）：锁内重读生命周期，防跨 await 竞态
    const life = checkLifecycle(d, ctx.identity, ctx.currentDigest);
    if (life.refused) {
      const err = new Error(`${life.result.code}: ${life.result.error}`);
      err.code = life.result.code;
      throw err;
    }
    // 同一竞态窗口内也可能发生并发 abandon/reject（它们不写正式卡）：
    // 锁内重读候选记录，一旦意图已被收回或状态改变，就拒绝提交——不能一边「已放弃」一边写入正式库。
    const cand = readRecord(d.limits, ctx.candidateId);
    if (!cand.ok) {
      const err = new Error(`CANDIDATE_UNREADABLE: 提交前无法重读候选记录（${cand.error}）`);
      err.code = 'CANDIDATE_UNREADABLE';
      throw err;
    }
    const claimProblem = claimLossReason(cand.record, ctx);
    if (claimProblem) {
      const err = new Error(`${claimProblem.code}: ${claimProblem.error}`);
      err.code = claimProblem.code;
      throw err;
    }
    const existing = readReceiptSafe(d.limits, ctx.candidateId, ctx.reviewedRevision);
    const receipt = existing.receipt || baseReceipt(ctx);
    try {
      writeReceipt(d.limits, {
        ...receipt,
        phase: 'prepared',
        plannedCard: card,
        plannedDigest: contentDigest,
        currentDigestAtPrepare: info.currentDigest ?? receipt.currentDigestAtPrepare ?? null,
        history: [{ phase: 'prepared', at: nowIso(), note: 'beforeCommit exact card' }],
      }, { source: 'writer', allowDigestChange: true });
    } catch (e) {
      const err = new Error(`RECEIPT_WRITE_FAILED: 发布准备收据写入失败：${e?.message || e}`);
      err.code = 'RECEIPT_WRITE_FAILED';
      err.cause = e;
      throw err;
    }
  };
  try {
    const result = await d.storeCard({
      agent: ctx.plannedCard.agent,
      id: ctx.plannedCard.id,
      keywords: ctx.plannedCard.keywords,
      summary: ctx.plannedCard.summary,
      content: ctx.plannedCard.content,
      related: ctx.plannedCard.related,
    }, options);
    if (!result || typeof result !== 'object') return { ok: false, committed: false, error: 'storeCard 返回非对象' };
    return result;
  } catch (e) {
    return { ok: false, committed: false, thrown: true, code: e?.code || 'STORE_THREW', error: String(e?.message || e) };
  }
}

async function publishImpl(state, overrides, input) {
  const d = await resolveDeps(overrides);
  if (d.unavailable) return fail('DEPENDENCY_UNAVAILABLE', d.unavailable);
  if (typeof d.readLifecycle !== 'function' || typeof d.isLifecycleExpired !== 'function') {
    return fail('DEPENDENCY_UNAVAILABLE', '依赖缺失：lifecycle.readLifecycle/isLifecycleExpired（拒绝无生命周期校验发布）');
  }
  const candidateId = input?.candidateId;
  if (!isCandidateId(candidateId)) return fail('INVALID_CANDIDATE_ID', 'candidateId 必须是 cand-<64 hex>');
  if (!Number.isInteger(input?.expectedRevision) || input.expectedRevision < 1) return fail('INVALID_REVISION', 'expectedRevision 必须是 >=1 的整数');
  const expectedDigest = normalizeExpectedDigest(input?.expectedTargetDigest);
  if (!expectedDigest) return fail('EXPECTED_DIGEST_REQUIRED', 'publish 必须显式给出 expectedTargetDigest（新卡用 absent，更新用当前 64 位 hex 摘要）');
  const reviewSummary = typeof input?.reviewSummary === 'string' ? input.reviewSummary.trim() : '';
  if (reviewSummary.length < 10) return fail('REVIEW_SUMMARY_REQUIRED', 'reviewSummary 至少 10 字；它只是调用者审查声明，不构成人工/内容认证');
  if (reviewSummary.length > d.limits.maxReviewSummary) return fail('REVIEW_SUMMARY_REQUIRED', `reviewSummary 超过 ${d.limits.maxReviewSummary} 字`);

  if (state.inFlight.has(candidateId)) return fail('PUBLICATION_IN_PROGRESS', '同一候选已有发布在进行中', { nextAction: 'retry-later' });

  state.inFlight.add(candidateId);
  try {
    const prepared = await runLocked(d, () => preparePublish(d, { candidateId, expectedRevision: input.expectedRevision, expectedTargetDigest: expectedDigest, reviewSummary }));
    if (!prepared.ok) return prepared.value;
    const plan = prepared.value;
    if (!plan.ready) return plan;
    const stored = await callWriter(d, plan.ctx);
    const finished = await runLocked(d, () => finalizePublish(d, plan.ctx, stored));
    if (!finished.ok) {
      // 收尾临界区失败不能丢 committed 事实
      if (stored && stored.committed === true) {
        return {
          ok: true, committed: true, statusPending: true, code: 'FINALIZE_DEFERRED',
          error: finished.value?.error || 'finalize 临界区失败', status: 'publishing',
          candidateId, revision: input.expectedRevision, lockMode: d.lockMode,
        };
      }
      return finished.value;
    }
    return finished.value;
  } finally {
    state.inFlight.delete(candidateId);
  }
}

// ── reconcile ────────────────────────────────────────────
async function reconcileImpl(overrides, input) {
  const d = await resolveDeps(overrides);
  if (d.unavailable) return fail('DEPENDENCY_UNAVAILABLE', d.unavailable);
  const limits = d.limits;
  const candidateId = input?.candidateId;
  if (!isCandidateId(candidateId)) return fail('INVALID_CANDIDATE_ID', 'candidateId 必须是 cand-<64 hex>');
  if (!Number.isInteger(input?.expectedRevision) || input.expectedRevision < 1) return fail('INVALID_REVISION', 'expectedRevision 必须是 >=1 的整数');
  const reason = typeof input?.reason === 'string' ? input.reason.trim() : '';
  if (!reason) return fail('INVALID_REASON', 'reconcile 必须给出非空 reason');
  if (reason.length > limits.maxReason) return fail('INVALID_REASON', `reason 超过 ${limits.maxReason} 字`);
  const abandon = input?.abandon === true;

  const locked = await runLocked(d, () => {
    const found = readRecord(limits, candidateId);
    if (!found.ok) return found;
    const record = found.record;
    if (record.revision !== input.expectedRevision) {
      return fail('REVISION_CONFLICT', `候选 revision 已变为 ${record.revision}，请基于当前版本重新核对`, { currentRevision: record.revision });
    }
    if (record.status === 'pending') {
      return { ok: true, changed: false, status: 'pending', candidateId, revision: record.revision };
    }
    if (record.status === 'rejected') return fail('TERMINAL_STATE', '已拒绝的候选没有可恢复的发布意图');
    if (record.status === 'published-superseded') return fail('TERMINAL_STATE', '候选已标记 published-superseded，历史不回滚');

    const target = readTargetSnapshot(record.identity);
    if (target.error) return fail('TARGET_UNREADABLE', target.error);
    const actualDigest = target.card ? digestCard(target.card) : 'absent';

    if (record.status === 'already-present') {
      if (record.publishedDigest && actualDigest === record.publishedDigest) return { ok: true, changed: false, status: 'already-present', candidateId, revision: record.revision, currentDigest: actualDigest };
      record.status = 'published-superseded';
      record.lastReconcile = { action: 'published-superseded', reason, at: nowIso(), publishedDigest: record.publishedDigest, currentDigest: actualDigest };
      pushHistory(record, 'published-superseded', 'earlier already-present content changed', limits);
      const written = writeRecord(limits, record);
      if (!written.ok) return written;
      return { ok: true, changed: true, superseded: true, status: 'published-superseded', candidateId, revision: record.revision, publishedDigest: record.publishedDigest, currentDigest: actualDigest };
    }

    if (record.status === 'published') {
      if (!record.publishedDigest || actualDigest === record.publishedDigest) {
        return { ok: true, changed: false, status: 'published', candidateId, revision: record.revision, currentDigest: actualDigest };
      }
      record.status = 'published-superseded';
      record.lastReconcile = { action: 'published-superseded', reason, at: nowIso(), publishedDigest: record.publishedDigest, currentDigest: actualDigest };
      pushHistory(record, 'published-superseded', `current=${String(actualDigest).slice(0, 12)}`, limits);
      const written = writeRecord(limits, record);
      if (!written.ok) return written;
      return { ok: true, changed: true, superseded: true, status: 'published-superseded', candidateId, revision: record.revision, publishedDigest: record.publishedDigest, currentDigest: actualDigest };
    }

    // publishing / conflict：以 plannedDigest 与当前摘要决定「已提交」还是「意图失效」
    const rev = record.intent?.reviewedRevision ?? record.revision;
    const receiptInfo = readReceiptSafe(limits, candidateId, rev);
    const receipt = receiptInfo.receipt;
    const planned = record.intent?.plannedDigest || receipt?.plannedDigest || null;
    const expected = record.intent?.expectedDigest ?? receipt?.expectedDigest ?? null;

    if (planned && actualDigest === planned && expected !== null && (expected !== planned || (receipt && ['committed', 'finalized'].includes(receipt.phase)))) {
      if (abandon) return fail('PUBLISHED_CANNOT_ABANDON', '目标当前内容正是本次审查内容，不能把已生效的发布标记为放弃');
      const receiptForWrite = { value: receipt || baseReceipt({ candidateId, reviewedRevision: rev, identity: record.identity, proposalDigest: record.digest.proposal, expectedDigest: expected || 'absent', plannedCard: record.intent?.plannedCard || target.card, plannedDigest: planned, reviewSummary: record.review?.summary, currentDigest: actualDigest }), limits };
      const out = markPublished(limits, record, { digest: actualDigest, reviewedRevision: rev, reviewSummary: record.review?.summary, receipt: receiptForWrite });
      if (!out.written.ok) return { ...out.written, committed: true, statusPending: true };
      return { ok: true, changed: true, published: true, recovered: true, status: 'published', candidateId, revision: record.revision, currentDigest: actualDigest, receiptError: out.receiptError };
    }

    const committedEvidence = receipt && (receipt.phase === 'committed' || receipt.phase === 'finalized');
    if (committedEvidence) {
      if (abandon) return fail('PUBLISHED_CANNOT_ABANDON', '收据显示本次发布已提交，不能 abandon；正式卡被覆盖属事实变更，不是回滚');
      record.status = 'published-superseded';
      record.lastReconcile = { action: 'published-superseded', reason, at: nowIso(), committedDigest: receipt.committedDigest || null, currentDigest: actualDigest };
      pushHistory(record, 'published-superseded', reason, limits);
      const written = writeRecord(limits, record);
      if (!written.ok) return written;
      return { ok: true, changed: true, superseded: true, status: 'published-superseded', candidateId, revision: record.revision, currentDigest: actualDigest, committedDigest: receipt.committedDigest || null };
    }

    if (planned && actualDigest === planned && expected === planned) {
      const written = markAlreadyPresent(limits, record, { digest: actualDigest, reviewedRevision: rev, reviewSummary: record.review?.summary });
      if (!written.ok) return { ...written, committed: false, statusPending: true };
      return { ok: true, changed: true, alreadyPresent: true, status: 'already-present', candidateId, revision: record.revision, currentDigest: actualDigest };
    }

    if (!abandon) {
      record.status = 'conflict';
      record.lastReconcile = { action: 'conflict', reason, at: nowIso(), currentDigest: actualDigest };
      pushHistory(record, 'reconcile-conflict', reason, limits);
      const written = writeRecord(limits, record);
      if (!written.ok) return written;
      return fail('INTENT_CONFLICT', '发布意图与当前目标不一致；确认放弃请显式传 abandon:true（只清候选意图，不改正式卡）', { nextAction: 'reconcile', abandon: true, currentDigest: actualDigest, status: 'conflict' });
    }

    record.status = 'pending';
    record.intent = null;
    record.lastReconcile = { action: 'abandon', reason, at: nowIso(), currentDigest: actualDigest, expectedDigest: expected };
    pushHistory(record, 'abandoned', reason, limits);
    const written = writeRecord(limits, record);
    if (!written.ok) return written;
    if (receipt) {
      try {
        writeReceipt(limits, { ...receipt, phase: 'abandoned', history: [{ phase: 'abandoned', at: nowIso(), note: reason.slice(0, 120) }] });
      } catch { /* 收据失败不改变候选事实；下次 publish 会重写意图 */ }
    }
    return { ok: true, changed: true, abandoned: true, status: 'pending', candidateId, revision: record.revision, currentDigest: actualDigest };
  });
  return locked.value;
}

// ── 终态候选的受控维护 ────────────────────────────────────
const MAINTAINABLE_STATUSES = new Set(['rejected', 'published-superseded', 'already-present']);
async function discardCandidateImpl(overrides, input) {
  const d = await resolveDeps(overrides);
  if (d.unavailable) return fail('DEPENDENCY_UNAVAILABLE', d.unavailable);
  const limits = d.limits;
  const candidateId = input?.candidateId;
  if (!isCandidateId(candidateId)) return fail('INVALID_CANDIDATE_ID', 'candidateId 必须是 cand-<64 hex>');
  if (input?.confirm !== true) return fail('CONFIRM_REQUIRED', '候选清理必须显式 confirm=true');
  if (!Number.isInteger(input?.expectedRevision) || input.expectedRevision < 1) return fail('INVALID_REVISION', 'expectedRevision 必须是 >=1 的整数');
  const reason = typeof input?.reason === 'string' ? input.reason.trim() : '';
  if (reason.length < 10) return fail('REASON_INVALID', '候选清理理由至少10字，需说明审计去向');
  if (reason.length > limits.maxReason) return fail('REASON_INVALID', `reason 超过 ${limits.maxReason} 字`);
  const locked = await runLocked(d, () => {
    const found = readRecord(limits, candidateId);
    if (!found.ok) return found;
    const record = found.record;
    if (record.revision !== input.expectedRevision) return fail('REVISION_CONFLICT', `候选 revision 已变为 ${record.revision}，请重新核对`, { currentRevision: record.revision });
    if (!MAINTAINABLE_STATUSES.has(record.status)) return fail('CANDIDATE_NOT_MAINTAINABLE', `状态 ${record.status} 不允许清理；仅 rejected/published-superseded/already-present 的候选可维护`);
    if (record.intent) return fail('PUBLICATION_IN_PROGRESS', '候选存在发布意图，先完成或恢复发布流程');
    const file = candidatePath(candidateId);
    const raw = fs.readFileSync(file);
    const digest = sha256(raw.toString('utf8'));
    const archiveDir = path.join(APP_DATA_DIR, 'candidate-archive');
    fs.mkdirSync(archiveDir, { recursive: true });
    const stamp = nowIso().replace(/[:.]/g, '-');
    const archiveFile = path.join(archiveDir, `${candidateId}-${stamp}.json`);
    const auditFile = path.join(archiveDir, `${candidateId}-${stamp}.audit.json`);
    const receipts = fs.existsSync(RECEIPTS_DIR)
      ? fs.readdirSync(RECEIPTS_DIR).filter((name) => name.startsWith(`${candidateId}__rev`) && name.endsWith('.json')).map((name) => path.join(RECEIPTS_DIR, name))
      : [];
    const receiptBackups = [];
    let backupCreated = false;
    try {
      atomicWriteFile(archiveFile, raw);
      backupCreated = true;
      const readBack = fs.readFileSync(archiveFile);
      if (!readBack.equals(raw)) throw new Error('候选备份读回不一致');
      const audit = {
        schemaVersion: 1, action: 'discard-candidate', candidateId,
        identity: record.identity, previousStatus: record.status,
        revision: record.revision, digest, reason,
        archivedAt: nowIso(), source: 'explicit-kc-verify',
      };
      atomicWriteFile(auditFile, JSON.stringify(audit, null, 2) + '\n');
      if (!fs.existsSync(auditFile) || fs.readFileSync(auditFile, 'utf8') !== JSON.stringify(audit, null, 2) + '\n') throw new Error('清理审计读回不一致');
      for (const receiptFile of receipts) {
        const receiptRaw = fs.readFileSync(receiptFile);
        const receiptBackup = path.join(archiveDir, `${path.basename(receiptFile, '.json')}-${stamp}.receipt.json`);
        atomicWriteFile(receiptBackup, receiptRaw);
        if (!fs.readFileSync(receiptBackup).equals(receiptRaw)) throw new Error('发布收据备份读回不一致');
        receiptBackups.push({ source: receiptFile, backup: receiptBackup });
      }
      fs.unlinkSync(file);
      if (fs.existsSync(file)) throw new Error('候选文件删除后仍存在');
      for (const receiptFile of receipts) fs.unlinkSync(receiptFile);
      return { ok: true, removed: true, candidateId, previousStatus: record.status,
        archived: archiveFile, audit: auditFile,
        receiptArchived: receiptBackups[0]?.backup || null,
        receiptArchives: receiptBackups.map((entry) => entry.backup), formalWrites: 0 };
    } catch (e) {
      // The original record is the source of truth: restore it if a later step
      // failed after unlink. Never discard the only audit copy.
      let restoreError = null;
      try {
        if (!fs.existsSync(file) && backupCreated) atomicWriteFile(file, raw);
        for (const entry of receiptBackups) if (fs.existsSync(entry.backup) && !fs.existsSync(entry.source)) fs.copyFileSync(entry.backup, entry.source);
      } catch (restore) { restoreError = String(restore?.message || restore); }
      return fail('CANDIDATE_DISCARD_FAILED', `候选清理失败：${e.message}`, { archived: backupCreated ? archiveFile : null, formalWrites: 0, restoreError });
    }
  });
  return locked.value;
}

// ── 工厂与默认实例 ────────────────────────────────────────
export function createCandidateStore(overrides = {}) {
  const state = { inFlight: new Set() };
  return {
    proposeCandidate: (input) => proposeImpl(overrides, input),
    readCandidate: (id) => readImpl(overrides, id),
    listCandidates: (options) => listImpl(overrides, options),
    rejectCandidate: (input) => rejectImpl(overrides, input),
    publishCandidate: (input) => publishImpl(state, overrides, input),
    reconcileCandidate: (input) => reconcileImpl(overrides, input),
    discardCandidate: (input) => discardCandidateImpl(overrides, input),
  };
}

const defaultStore = createCandidateStore();

export const proposeCandidate = (input) => defaultStore.proposeCandidate(input);
export const readCandidate = (id) => defaultStore.readCandidate(id);
export const listCandidates = (options) => defaultStore.listCandidates(options);
export const rejectCandidate = (input) => defaultStore.rejectCandidate(input);
export const publishCandidate = (input) => defaultStore.publishCandidate(input);
export const reconcileCandidate = (input) => defaultStore.reconcileCandidate(input);
export const discardCandidate = (input) => defaultStore.discardCandidate(input);
