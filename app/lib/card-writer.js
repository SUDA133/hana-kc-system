// 卡片写入核心（B12）：原在 tools/knowledge-store.js，下沉到 lib 以解开
// 「旧归档模块 → tools/knowledge-store.js」的层次倒置（lib 不应依赖 tools）。
//
// KC5 数据 owner 合同（docs/api-contract.md / design-amendments.md）：
// - CAS：expectedDigest='absent'|sha256；检查在 data-lock + 全库写队列回调内、对当前分片重读后执行。
// - 缺 expected 只允许「新建」或「完全相同幂等」；existing 实质更新一律拒绝。
// - 覆盖既有分片前写 APP_DATA_DIR/backups 恢复点（wx + 逐字节读回）。
// - beforeCommit 在锁内、正式分片替换前同步调用；Promise/throw 都拒绝提交。
// - contentDigest 统一来自 repository.cardDigest（同一算法，排 timestamps/stats/派生字段）。
import {
  isValidAgent,
  validateId,
  getJsonlPath,
  readAllLines,
  writeAllLines,
  normalizeCard,
  rebuildIndexSerialized,
  loadIndex,
  parseIndexKey,
  enqueueDataWrite,
  backupShardExclusive,
} from './jsonl-io.js';
import { withDataLock } from './data-lock.js';
import { cardDigest } from './repository.js';

export const MAX_CONTENT_LENGTH = 500;
export const MAX_SUMMARY_LENGTH = 100;
export const MAX_KEYWORDS = 20;
export const MAX_KEYWORD_LENGTH = 50;
/** 新输入未知扩展的字节上限：防止单卡扩展把 16MiB 分片上限撑爆 */
export const MAX_EXTRA_BYTES = 16 * 1024;

const DIGEST_RE = /^[0-9a-f]{64}$/i;
// 卡片正文已知字段 + 内部校验结果：不进入 extras。
const BASE_SKIP_KEYS = new Set([
  'agent', 'id', 'keywords', 'summary', 'content', 'source', 'score', 'related',
  'expectedDigest', 'created', 'lastUpdated',
  'normalizedId', 'kwCheck', 'expected', 'mode', 'extras',
]);
// 工具面 input 的保留键：wrapper 会 strip，这里再防御一层；只影响新输入，
// 既有卡里同名未知业务字段仍由 BASE_SKIP_KEYS 之外的原样保留。
const TOOL_INPUT_KEYS = new Set([
  'action', 'reason', 'metadata', 'expectedLifecycleRevision', 'expectedRevision',
]);
const INPUT_SKIP_KEYS = new Set([...BASE_SKIP_KEYS, ...TOOL_INPUT_KEYS]);

/**
 * 归一化卡片 id：剥离与归属 agent 重复的归档元前缀（v3.0.17）。
 * - `kc-{agent}-note-<rest>` / `{agent}-note-<rest>` → `<rest>`
 * - 其余 id 原样返回（含 `kc-enforce-*` 等非元前缀），仅做 trim / lowercase。
 */
export function normalizeCardId(agent, rawId) {
  if (typeof rawId !== 'string') return rawId;
  const t = rawId.trim().toLowerCase();
  if (!isValidAgent(agent)) return t;
  const esc = agent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m1 = t.match(new RegExp(`^kc-${esc}-note-+(.+)$`));
  if (m1) return m1[1];
  const m2 = t.match(new RegExp(`^${esc}-note-+(.+)$`));
  if (m2) return m2[1];
  return t;
}

function now() {
  return new Date().toISOString().split('T')[0];
}

function fail(code, error, extra = {}) {
  return { ok: false, committed: false, code, error, ...extra };
}
function isThenable(v) {
  return !!v && (typeof v === 'object' || typeof v === 'function') && typeof v.then === 'function';
}

/**
 * 关键词校验：数量 / 元素长度 / 元素类型 / 空值 / 换行。
 * 校验失败即拒绝写入——这是防止「死键」进入倒排表的唯一入口。
 */
export function validateKeywords(keywords) {
  const errors = [];
  if (!Array.isArray(keywords) || keywords.length === 0) {
    return { ok: false, errors: ['关键词不能为空，至少提供一个关键词。'], normalized: [] };
  }
  if (keywords.length > MAX_KEYWORDS) {
    errors.push(`关键词最多 ${MAX_KEYWORDS} 个（当前 ${keywords.length} 个）。`);
  }
  const normalized = [];
  for (const raw of keywords) {
    if (typeof raw !== 'string') {
      errors.push(`关键词必须是字符串：${JSON.stringify(raw)}`);
      continue;
    }
    const kw = raw.trim();
    if (!kw) {
      errors.push('关键词不能为空白字符串。');
      continue;
    }
    if (kw.length > MAX_KEYWORD_LENGTH) {
      errors.push(`关键词过长（上限 ${MAX_KEYWORD_LENGTH} 字符）："${kw.slice(0, 30)}..."（${kw.length} 字符）`);
      continue;
    }
    if (/[\r\n]/.test(kw)) {
      errors.push(`关键词不能包含换行："${kw.slice(0, 30)}"`);
      continue;
    }
    normalized.push(kw);
  }
  return { ok: errors.length === 0, errors, normalized: [...new Set(normalized)] };
}

function validateInput(input, options) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return fail('INVALID_INPUT', 'storeCard 需要普通对象输入。');
  }
  const agent = input.agent;
  const id = input.id;
  if (!agent) return fail('INVALID_AGENT', '缺少 agent 字段。');
  if (!isValidAgent(agent)) return fail('INVALID_AGENT', `agent 非法：${String(agent)}。`);
  if (!id) return fail('INVALID_ID', '缺少 id 字段。');
  if (!validateId(id)) return fail('INVALID_ID', 'id 格式无效。必须为 kebab-case。');
  const normalizedId = normalizeCardId(agent, id);
  if (!validateId(normalizedId)) return fail('INVALID_ID', 'id 归一化后无效。必须为 kebab-case。');

  if (typeof input.summary !== 'string') return fail('INVALID_SUMMARY_TYPE', 'summary 必须是字符串。');
  if (typeof input.content !== 'string') return fail('INVALID_CONTENT_TYPE', 'content 必须是字符串。');
  const summary = input.summary.trim();
  const content = input.content.trim();
  if (!summary) return fail('EMPTY_SUMMARY', 'summary 不能为空。');
  if (!content) return fail('EMPTY_CONTENT', 'content 不能为空。');
  if (summary.length > MAX_SUMMARY_LENGTH) return fail('SUMMARY_TOO_LONG', `摘要超过 ${MAX_SUMMARY_LENGTH} 字限制（当前 ${summary.length} 字）。`);
  if (content.length > MAX_CONTENT_LENGTH) return fail('CONTENT_TOO_LONG', `内容超过 ${MAX_CONTENT_LENGTH} 字限制（当前 ${content.length} 字）。`);

  if (input.score !== undefined && (typeof input.score !== 'number' || !Number.isFinite(input.score))) {
    return fail('INVALID_SCORE', 'score 必须是有限数字。');
  }
  if (input.source !== undefined && typeof input.source !== 'string') {
    return fail('INVALID_SOURCE', 'source 必须是字符串。');
  }
  const related = input.related === undefined ? undefined : input.related;
  if (related !== undefined) {
    if (!Array.isArray(related)) return fail('INVALID_RELATED', 'related 必须是数组。');
    const bad = related.filter((r) => !validateId(r));
    if (bad.length > 0) return fail('INVALID_RELATED', `related 中存在非法 id（必须为 kebab-case）：${bad.join(', ')}`);
  }
  const kwCheck = validateKeywords(Array.isArray(input.keywords) ? input.keywords : []);
  if (!kwCheck.ok) return fail('INVALID_KEYWORDS', `关键词校验未通过——${kwCheck.errors.join('；')}`);
  if (options.mode !== undefined && options.mode !== 'create-or-identical') {
    return fail('INVALID_MODE', `不支持的 mode：${String(options.mode)}`);
  }
  const extras = collectExtras(input);
  if (!extras.ok) return fail(extras.code, extras.error);

  let expected = options.expectedDigest !== undefined ? options.expectedDigest : input.expectedDigest;
  if (options.expectedDigest !== undefined && input.expectedDigest !== undefined) {
    const a = options.expectedDigest;
    const b = input.expectedDigest;
    const na = a === 'absent' ? 'absent' : (typeof a === 'string' && DIGEST_RE.test(a) ? a.toLowerCase() : null);
    const nb = b === 'absent' ? 'absent' : (typeof b === 'string' && DIGEST_RE.test(b) ? b.toLowerCase() : null);
    if (na === null || nb === null) return fail('INVALID_EXPECTED_DIGEST', "expectedDigest 必须为 'absent' 或 64 位十六进制 sha256。");
    if (na !== nb) return fail('EXPECTED_CONFLICT', 'options.expectedDigest 与 input.expectedDigest 不一致；未改动任何字节。');
    expected = na;
  }
  if (expected !== undefined) {
    if (typeof expected !== 'string' || (expected !== 'absent' && !DIGEST_RE.test(expected))) {
      return fail('INVALID_EXPECTED_DIGEST', "expectedDigest 必须为 'absent' 或 64 位十六进制 sha256。");
    }
    if (expected !== 'absent') expected = expected.toLowerCase();
  }

  return {
    ok: true,
    value: {
      agent, id, normalizedId, summary, content, related, kwCheck, expected, mode: options.mode,
      source: input.source, score: input.score, extras: extras.value,
    },
  };
}

function collectExtras(input) {
  const extras = {};
  for (const key of Object.keys(input)) {
    if (INPUT_SKIP_KEYS.has(key) || key === 'queryCount' || key === 'lastQueried') continue;
    extras[key] = input[key];
  }
  let text;
  try {
    text = JSON.stringify(extras);
  } catch {
    return { ok: false, code: 'INVALID_EXTENSIONS', error: '未知扩展字段无法序列化为 JSON。' };
  }
  if (Buffer.byteLength(text || '', 'utf8') > MAX_EXTRA_BYTES) {
    return {
      ok: false,
      code: 'EXTENSIONS_TOO_LARGE',
      error: `新输入未知扩展超过 ${MAX_EXTRA_BYTES} 字节上限；请拆分为正式字段或另存，避免撑爆分片。`,
    };
  }
  return { ok: true, value: extras };
}

function parseShard(lines) {
  const parsed = [];
  for (let i = 0; i < lines.length; i++) {
    let card;
    try { card = JSON.parse(lines[i]); } catch { return { ok: false, line: i + 1, reason: 'bad-json' }; }
    if (!card || typeof card !== 'object' || Array.isArray(card) || typeof card.id !== 'string' || !card.id) {
      return { ok: false, line: i + 1, reason: 'bad-shape' };
    }
    parsed.push({ line: i, card });
  }
  return { ok: true, parsed };
}

function plannedCard(input, base, targetId, today) {
  const extras = {};
  for (const key of Object.keys(base)) {
    if (BASE_SKIP_KEYS.has(key) || key === 'queryCount' || key === 'lastQueried') continue;
    extras[key] = base[key];
  }
  for (const key of Object.keys(input)) {
    if (BASE_SKIP_KEYS.has(key)) continue;
    extras[key] = input[key];
  }
  Object.assign(extras, input.extras || {});
  const source = input.source !== undefined
    ? input.source
    : (typeof base.source === 'string' && base.source ? base.source : `kc--${input.agent}-note--${targetId}`);
  const score = input.score !== undefined
    ? input.score
    : (typeof base.score === 'number' && Number.isFinite(base.score) ? base.score : 5);
  const related = input.related !== undefined
    ? input.related
    : (Array.isArray(base.related) ? base.related : []);
  return normalizeCard({
    ...extras,
    id: targetId,
    agent: input.agent,
    source,
    keywords: input.kwCheck.normalized,
    score,
    summary: input.summary,
    content: input.content,
    created: base.created || today,
    lastUpdated: today,
    related,
  });
}

/**
 * 新增或覆盖一张卡片。成功返回结构化结果（不再返回人读消息）。
 * @returns {Promise<{ok:boolean, committed?:boolean, isUpdate?:boolean, skipped?:boolean, id?:string, agent?:string, contentDigest?:string, currentDigest?:string|null, error?:string, code?:string, indexError?:string, totalCards?:number, overlapWarning?:string}>}
 */
export async function storeCard(input, options = {}) {
  const checked = validateInput(input, options || {});
  if (!checked.ok) return checked;
  const v = checked.value;
  const jsonlPath = getJsonlPath(v.agent);
  const today = now();

  // 重叠检测（advisory，读 index.json，不参与写入临界区）
  let overlapWarning = '';
  const index = loadIndex();
  if (index) {
    const overlapCards = [];
    for (const kw of v.kwCheck.normalized) {
      const matches = (index.index || {})[String(kw).toLowerCase()];
      if (!matches) continue;
      for (const matchKey of matches) {
        const mid = parseIndexKey(matchKey).id;
        if (mid !== v.id && mid !== v.normalizedId && !overlapCards.includes(mid)) overlapCards.push(mid);
      }
    }
    if (overlapCards.length > 0) {
      overlapWarning = `\n\n注意：检测到与现有卡片关键词重叠：${overlapCards.slice(0, 5).join(', ')}${overlapCards.length > 5 ? '...' : ''}。请确认是否为预期的新增/覆盖。`;
    }
  }

  let outcome;
  try {
    // 先排队（等待同进程其它数据写者），再在队列回调内拿全局锁并重读当前分片。
    outcome = await enqueueDataWrite(() => withDataLock(() => {
      const lines = readAllLines(jsonlPath);
      const parsed = parseShard(lines);
      if (!parsed.ok) {
        return fail('SHARD_CORRUPT', `分片第 ${parsed.line} 行不是有效卡片对象（${parsed.reason}）；拒绝改写以保留原字节。`);
      }
      const matches = parsed.parsed.filter(({ card }) => card.id === v.id || (v.normalizedId !== v.id && card.id === v.normalizedId));
      if (matches.length > 1) {
        return fail('TARGET_AMBIGUOUS', `分片内存在 ${matches.length} 条同 id 记录，拒绝精确覆盖。`);
      }
      const existing = matches.length === 1 ? matches[0].card : null;
      if (existing && existing.agent !== undefined && existing.agent !== v.agent) {
        return fail('AGENT_MISMATCH', `卡片物理分片为 ${v.agent}，但卡内 agent=${String(existing.agent)}；拒绝跨身份改写。`);
      }
      const currentDigest = existing ? cardDigest(existing) : null;
      const targetId = existing ? existing.id : v.normalizedId;
      const planned = plannedCard(v, existing || {}, targetId, today);
      // 以实际将要写入的序列化结果计算 digest：JSON 会丢弃 undefined/不可序列化值，
      // 不能让 contentDigest 与落盘字节脱节。
      const serialized = JSON.stringify(planned);
      const commitCard = JSON.parse(serialized);
      const contentDigest = cardDigest(commitCard);

      // CAS：全部基于临界区内当前读取。
      // expected=sha 的 mismatch 优先于幂等（防止拿旧摘要把已变更目标当作相同内容）。
      if (v.expected !== undefined && v.expected !== 'absent') {
        if (!existing) return fail('TARGET_MISSING', `目标不存在（${targetId}），无法按 expectedDigest 更新。`, { currentDigest: null, id: targetId });
        if (currentDigest !== v.expected) {
          return fail('DIGEST_MISMATCH', '当前分片内容与 expectedDigest 不一致；未改动任何字节。', { currentDigest, id: targetId });
        }
      }

      if (existing && contentDigest === currentDigest) {
        return {
          skipped: true,
          isUpdate: true,
          targetId,
          contentDigest,
          currentDigest,
        };
      }
      if (v.expected === 'absent' && existing) {
        return fail('TARGET_EXISTS', `目标已存在且内容不同（${targetId}），expectedDigest=absent 拒绝。`, {
          currentDigest,
          id: targetId,
          ...(v.mode === 'create-or-identical' ? { conflict: true } : {}),
        });
      }
      if (existing && v.expected === undefined) {
        if (v.mode === 'create-or-identical') {
          return { conflict: true, ...fail('CONTENT_CONFLICT', '同身份卡片内容已变更，需要人工核验（create-or-identical）。', { currentDigest, id: targetId }) };
        }
        return fail('DIGEST_REQUIRED', '目标已存在且内容不同：必须提供 expectedDigest 才能更新。', { currentDigest, id: targetId });
      }

      if(existing&&(typeof options.reason!=='string'||!options.reason.trim()||options.reason.length>1000)){
        return fail('REASON_REQUIRED','实质更新需1..1000字符reason；当前卡未改。',{currentDigest,id:targetId});
      }
      if (options.beforeCommit !== undefined && typeof options.beforeCommit !== 'function') {
        return fail('INVALID_BEFORE_COMMIT', 'beforeCommit 必须是同步函数。');
      }
      // 恢复点：任何会覆盖既有分片的写入都先落备份
      let backup = null;
      try {
        backup = backupShardExclusive(jsonlPath, { reason: existing ? 'store-update' : 'store-create' });
      } catch (e) {
        return fail('BACKUP_FAILED', `分片备份失败，拒绝写入：${e.message}`);
      }

      // beforeCommit：锁内、正式替换之前；必须同步
      if (options.beforeCommit !== undefined) {
        let cb;
        try {
          cb = options.beforeCommit({ card: commitCard, contentDigest, currentDigest });
        } catch (e) {
          return fail('BEFORE_COMMIT_FAILED', `beforeCommit 失败，未提交：${e.message}`);
        }
        if (isThenable(cb)) {
          try { cb.then(() => {}, () => {}); } catch {}
          return fail('BEFORE_COMMIT_ASYNC', 'beforeCommit 必须是同步函数；Promise 回调已拒绝提交。');
        }
      }

      try {
        if (existing) {
          const newLines = lines.slice();
          newLines[matches[0].line] = serialized;
          writeAllLines(jsonlPath, newLines);
        } else {
          writeAllLines(jsonlPath, [...lines, serialized]);
        }
      } catch (e) {
        return fail(e?.code==='SHARD_OVER_LIMIT'?'SHARD_OVER_LIMIT':'WRITE_FAILED', `写入分片失败（未提交任何内容）：${e.message}`);
      }
      return {
        isUpdate: Boolean(existing),
        targetId,
        contentDigest,
        currentDigest,
        backupPath: backup?.path || null,
        overlapWarning,
      };
    }));
  } catch (e) {
    if (e?.code === 'E_LOCKED') return fail('LOCKED', `KC 数据锁忙：${e.message}`, { lock: e.lock });
    if (e?.code === 'E_LOCK_UNSUPPORTED') return fail('LOCK_UNSUPPORTED', e.message);
    if (e?.code === 'SHARD_TOO_LARGE') return fail('READ_FAILED', e.message);
    return fail('WRITE_FAILED', `写入分片失败（未提交任何内容）：${e?.message || String(e)}`);
  }

  if (outcome.conflict) return { ...outcome, committed: false };
  if (outcome.ok === false) return outcome;
  if (outcome.skipped) {
    return {
      ok: true,
      committed: false,
      skipped: true,
      isUpdate: true,
      id: outcome.targetId,
      agent: v.agent,
      contentDigest: outcome.contentDigest,
      currentDigest: outcome.currentDigest,
    };
  }

  // 索引重建在锁外、全局串行；分片已提交，索引失败只报 indexError，不跑第二写者。
  let totalCards;
  try {
    totalCards = await rebuildIndexSerialized();
  } catch (err) {
    return {
      ok: true,
      committed: true,
      isUpdate: outcome.isUpdate,
      id: outcome.targetId,
      agent: v.agent,
      contentDigest: outcome.contentDigest,
      currentDigest: outcome.currentDigest,
      indexError: err.message,
      ...(outcome.lockReleaseWarning?{lockReleaseWarning:outcome.lockReleaseWarning}:{}),
    };
  }

  return {
    ok: true,
    committed: true,
    isUpdate: outcome.isUpdate,
    id: outcome.targetId,
    agent: v.agent,
    contentDigest: outcome.contentDigest,
    currentDigest: outcome.currentDigest,
    totalCards,
    ...(outcome.lockReleaseWarning ? {lockReleaseWarning:outcome.lockReleaseWarning} : {}),
    ...(outcome.backupPath ? { backupPath: outcome.backupPath } : {}),
    ...(outcome.overlapWarning ? { overlapWarning: outcome.overlapWarning } : {}),
  };
}
