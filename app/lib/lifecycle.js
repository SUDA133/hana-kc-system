// lib/lifecycle.js — KC5 lifecycle sidecar (data/lifecycle.json)
//
// 单一职责：只读写侧车，不读卡片正文（annotate 时懒加载 repository 校验目标）。
// 侧车记录“对某张正式卡内容的生命周期声明”，绑定 targetDigest；不认证知识正确性。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  resolveDataDir,
  atomicWriteFile,
  enqueueWrite,
  isValidAgent,
  validateId,
  APP_DATA_DIR,
} from './jsonl-io.js';

import {
  SCHEMA_VERSION, MAX_ENTRIES, MAX_BYTES, MAX_REASON_LENGTH, DIGEST_RE, plain,
  isStrictDateOnly, parseIdentityKey, normalizeMetadata, validateStoredEntry,
} from './lifecycle-schema.js';
export {
  SCHEMA_VERSION, MAX_ENTRIES, MAX_BYTES, MAX_SOURCE_REFS, MAX_SOURCE_REF_LENGTH,
  MAX_SCOPE_LENGTH, MAX_REASON_LENGTH, STATUSES, isStrictDateOnly,
  isStrictIsoDateOrDateTime, normalizeMetadata,
} from './lifecycle-schema.js';

const nowIso = () => new Date().toISOString();
const failedRead = (code, error, revision = null) => ({
  ok: false, complete: false, revision, entries: {},
  error, diagnostics: [{ code, message: error }],
});

/** 侧车路径固定在 App dataDir 下；调用方不可传入任意路径。 */
export function getLifecyclePath() {
  return path.join(resolveDataDir(), 'lifecycle.json');
}

/** 无侧车条目时的显式视图：可检索，但明确“未核验”，不是 active 已核。 */
export function legacyLifecycleEntry(extra = {}) {
  return {
    status: 'legacy-unverified', targetDigest: null, sourceRefs: [], scope: {}, verifiedAt: null,
    validUntil: null, supersededBy: null, reason: null, updatedAt: null, ...extra,
  };
}

export function isLifecycleExpired(entry, now = new Date()) {
  if (!entry || typeof entry.validUntil !== 'string' || !entry.validUntil) return false;
  if (isStrictDateOnly(entry.validUntil)) {
    return entry.validUntil < now.toISOString().slice(0, 10);
  }
  return Date.parse(entry.validUntil) < now.getTime();
}

/** 默认可见：active/legacy-unverified 且未过期；显式 deprecated/superseded/archived 默认隐藏。 */
export function isLifecycleVisible(entry, now = new Date()) {
  const status = entry && entry.status;
  if (status !== 'active' && status !== 'legacy-unverified') return false;
  return !isLifecycleExpired(entry, now);
}

function lifecycleFailure(code, error, revision = null, extra = {}) {
  return { ok: false, revision, error, code, ...extra };
}

/** 覆盖侧车前的逐字节备份；备份读回不一致就不允许进入写阶段。 */
function backupLifecycleBytes(bytes) {
  try {
    const dir = path.join(APP_DATA_DIR, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `lifecycle-${stamp}-${crypto.randomBytes(4).toString('hex')}.json`);
    fs.writeFileSync(file, bytes, { flag: 'wx' });
    const back = fs.readFileSync(file);
    if (!back.equals(bytes)) {
      try { fs.unlinkSync(file); } catch { /* best effort */ }
      return { ok: false, error: '生命周期侧车备份读回校验失败' };
    }
    return { ok: true, path: file };
  } catch (e) {
    return { ok: false, error: `生命周期侧车备份失败：${e.message}` };
  }
}

/**
 * 读取侧车。从不缓存：await 前后不得复用旧快照。
 * @returns {{ok:boolean,complete:boolean,revision:number|null,entries:object,error:string|null,diagnostics:Array}}
 */
export function readLifecycle() {
  const file = getLifecyclePath();
  const diagnostics = [];
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      return { ok: true, complete: true, revision: 0, entries: {}, error: null, diagnostics };
    }
    return failedRead('lifecycle-unreadable', `读取 lifecycle.json 失败：${e.message}`);
  }
  if (stat.isSymbolicLink()) return failedRead('lifecycle-symlink', '拒绝读取符号链接 lifecycle.json');
  if (stat.size > MAX_BYTES) return failedRead('lifecycle-limit-bytes', `lifecycle.json 超过 ${MAX_BYTES} 字节上限`);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    return failedRead('lifecycle-corrupt', `lifecycle.json 已损坏（corrupt）：${e.message}`);
  }
  if (!plain(parsed)) return failedRead('lifecycle-corrupt', 'lifecycle.json 顶层不是对象（corrupt）');
  if (parsed.schemaVersion !== SCHEMA_VERSION) {
    return failedRead('lifecycle-unsupported-schema', `不支持的 lifecycle schemaVersion：${String(parsed.schemaVersion)}`);
  }
  if (!Number.isInteger(parsed.revision) || parsed.revision < 0) {
    return failedRead('lifecycle-corrupt', 'lifecycle revision 必须是非负整数（corrupt）');
  }
  if (!plain(parsed.entries)) {
    return failedRead('lifecycle-corrupt', 'lifecycle entries 不是对象（corrupt）', parsed.revision);
  }
  const keys = Object.keys(parsed.entries);
  if (keys.length > MAX_ENTRIES) {
    diagnostics.push({ code: 'lifecycle-limit-entries', message: `entries=${keys.length} > ${MAX_ENTRIES}` });
  }
  const entries = {};
  for (const key of keys) {
    const identity = parseIdentityKey(key);
    if (!identity) {
      diagnostics.push({ code: 'lifecycle-entry-invalid', identity: key, message: 'invalid identity key' });
      continue;
    }
    const v = validateStoredEntry(parsed.entries[key]);
    if (!v.ok) {
      diagnostics.push({ code: 'lifecycle-entry-invalid', identity: key, message: v.error });
      continue;
    }
    entries[key] = v.value;
  }
  const complete = diagnostics.length === 0;
  return {
    ok: true, complete, revision: parsed.revision, entries,
    error: complete ? null : diagnostics.map((d) => d.message).join('；'),
    diagnostics,
  };
}

function wouldCreateCycle(entries, startIdentity, targetIdentity) {
  let cur = targetIdentity;
  const seen = new Set([startIdentity]);
  while (cur) {
    if (seen.has(cur)) return true;
    seen.add(cur);
    const entry = entries[cur];
    cur = entry && entry.supersededBy ? entry.supersededBy : null;
    if (seen.size > MAX_ENTRIES) return true;
  }
  return false;
}

// 主数据层锁接入点：主代理把 data-lock 的同步临界区包在这里；本模块不复制锁实现。
let criticalSection = (fn) => fn();
export function setLifecycleCriticalSection(fn) {
  criticalSection = typeof fn === 'function' ? fn : ((inner) => inner());
}
export function _resetLifecycleCriticalSection() { criticalSection = (fn) => fn(); }

function validateAnnotateInput(input) {
  if (!plain(input)) return { ok: false, error: 'input 必须是对象' };
  const { agent, id, metadata, expectedRevision, expectedDigest, reason } = input;
  if (!isValidAgent(agent)) return { ok: false, error: 'agent 非法' };
  if (!validateId(id)) return { ok: false, error: 'id 非法' };
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    return { ok: false, error: 'expectedRevision 必须是非负整数' };
  }
  if (typeof expectedDigest !== 'string' || !DIGEST_RE.test(expectedDigest)) {
    return { ok: false, error: 'expectedDigest 必须是 64 位十六进制' };
  }
  if (typeof reason !== 'string' || !reason.trim()) return { ok: false, error: 'reason 必须是非空字符串' };
  if (reason.trim().length > MAX_REASON_LENGTH) return { ok: false, error: `reason 超长（>${MAX_REASON_LENGTH}）` };
  if (metadata === undefined) return { ok: false, error: 'metadata 必须是对象或 null（null 表示清除）' };
  let normalized = null;
  if (metadata !== null) {
    const m = normalizeMetadata(metadata);
    if (!m.ok) return m;
    normalized = m.value;
  }
  return {
    ok: true,
    value: {
      agent, id, identity: `${agent}::${id}`, metadata: normalized,
      expectedRevision, expectedDigest: expectedDigest.toLowerCase(), reason: reason.trim(),
    },
  };
}

/**
 * 只写侧车，不写原卡。必须在同一个同步临界区内完成 read→check→write。
 * @returns {Promise<{ok:boolean,revision:number|null,error:string|null,code?:string}>}
 */
export async function annotateLifecycle(input) {
  const checked = validateAnnotateInput(input);
  if (!checked.ok) return lifecycleFailure('INPUT_INVALID', checked.error);
  const v = checked.value;
  // 懒加载：避免 repository（静态 import lifecycle）与本模块形成初始化环。
  const repo = await import('./repository.js');
  // 跨进程数据锁：动态 import 在进入 queue 前完成；锁只包同步短事务，不跨 await。
  // 无锁不写：锁模块不可用/接口不对时 fail-closed，绝不退回「无锁同步区」静默降级。
  let withDataLock = null;
  let lockUnavailable = null;
  try {
    const lockModule = await import('./data-lock.js');
    if (typeof lockModule.withDataLock === 'function') withDataLock = lockModule.withDataLock;
    else lockUnavailable = 'data-lock.withDataLock 不是函数';
  } catch (e) {
    lockUnavailable = e?.message || String(e);
  }
  if (!withDataLock) {
    return lifecycleFailure('LIFECYCLE_LOCK_UNAVAILABLE', `数据锁不可用（${lockUnavailable || '未知原因'}），拒绝在无锁状态下写生命周期侧车`);
  }
  return enqueueWrite('__lifecycle__', () => {
    const run = () => criticalSection(() => {
      const current = readLifecycle();
      if (!current.ok) {
        return lifecycleFailure('LIFECYCLE_UNAVAILABLE', current.error || 'lifecycle unavailable', current.revision);
      }
      if (!current.complete) {
        return lifecycleFailure('LIFECYCLE_UNAVAILABLE', current.error || 'lifecycle incomplete', current.revision);
      }
      if (current.revision !== v.expectedRevision) {
        return lifecycleFailure('REVISION_CONFLICT', `expectedRevision=${v.expectedRevision}，当前=${current.revision}`, current.revision);
      }
      const target = repo.findCardByIdentity({ agent: v.agent, id: v.id });
      if (!target.ok) {
        return lifecycleFailure(target.code || 'TARGET_MISSING', target.error || 'target missing', current.revision);
      }
      if (target.agentMismatch) {
        return lifecycleFailure('TARGET_AGENT_MISMATCH', '目标卡内 agent 与分片物理身份不一致，拒绝标注', current.revision);
      }
      if (target.digest !== v.expectedDigest) {
        return lifecycleFailure('DIGEST_MISMATCH', '目标内容 digest 与 expectedDigest 不一致', current.revision, {
          currentDigest: target.digest,
        });
      }

      const entries = { ...current.entries };
      if (v.metadata === null) {
        if (!entries[v.identity]) {
          return { ok: true, revision: current.revision, error: null, noop: true };
        }
        delete entries[v.identity];
      } else {
        if (v.metadata.supersededBy) {
          if (v.metadata.supersededBy === v.identity) {
            return lifecycleFailure('SUPERSEDED_SELF', 'supersededBy 不能指向自身', current.revision);
          }
          const ref = repo.findCardByIdentity({
            agent: v.metadata.supersededBy.slice(0, v.metadata.supersededBy.indexOf('::')),
            id: v.metadata.supersededBy.slice(v.metadata.supersededBy.indexOf('::') + 2),
          });
          if (!ref.ok) {
            return lifecycleFailure('SUPERSEDED_TARGET_MISSING', `supersededBy 目标不存在：${v.metadata.supersededBy}`, current.revision);
          }
          if (wouldCreateCycle(entries, v.identity, v.metadata.supersededBy)) {
            return lifecycleFailure('SUPERSEDED_CYCLE', 'supersededBy 形成循环', current.revision);
          }
        }
        if (!entries[v.identity] && Object.keys(entries).length >= MAX_ENTRIES) {
          return lifecycleFailure('LIFECYCLE_LIMIT', `entries 已达 ${MAX_ENTRIES} 上限`, current.revision);
        }
        entries[v.identity] = {
          ...v.metadata,
          targetDigest: v.expectedDigest,
          reason: v.reason,
          updatedAt: nowIso(),
        };
      }

      const sorted = {};
      for (const key of Object.keys(entries).sort()) sorted[key] = entries[key];
      const text = JSON.stringify({ schemaVersion: SCHEMA_VERSION, revision: current.revision + 1, entries: sorted }, null, 2);
      if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) {
        return lifecycleFailure('LIFECYCLE_LIMIT', `lifecycle.json 将超过 ${MAX_BYTES} 字节`, current.revision);
      }
      const file = getLifecyclePath();
      if (fs.existsSync(file)) {
        const backup = backupLifecycleBytes(fs.readFileSync(file));
        if (!backup.ok) return lifecycleFailure('LIFECYCLE_BACKUP_FAILED', backup.error, current.revision);
      }
      try {
        atomicWriteFile(file, text);
      } catch (e) {
        // rename 之前失败：目标字节未被替换，如实报未提交（不谎报已写）。
        return lifecycleFailure('LIFECYCLE_WRITE_FAILED', `侧车写入失败（未提交）：${e.message}`, current.revision, {
          committed: false,
        });
      }
      const nextRevision = current.revision + 1;
      let verify;
      try {
        verify = readLifecycle();
      } catch (e) {
        // rename 已成功、读回抛错：提交事实不能因为核验失败而改变。
        return lifecycleFailure('LIFECYCLE_WRITE_UNVERIFIED', `侧车已提交但写后读回失败：${e.message}`, nextRevision, {
          committed: true, writeUnverified: true, expectedRevision: nextRevision,
        });
      }
      if (!verify.ok || verify.revision !== nextRevision) {
        return lifecycleFailure('LIFECYCLE_WRITE_UNVERIFIED', '侧车已提交但写后读回不一致', nextRevision, {
          committed: true, writeUnverified: true, expectedRevision: nextRevision,
        });
      }
      return { ok: true, revision: nextRevision, error: null, committed: true };
    });
    try {
      return withDataLock(run);
    } catch (e) {
      const code = e?.code === 'E_LOCKED' ? 'DATA_LOCK_BUSY'
        : (typeof e?.code === 'string' && e.code.startsWith('E_LOCK') ? 'DATA_LOCK_FAILED'
          : 'LIFECYCLE_WRITE_FAILED');
      return lifecycleFailure(code, `侧车写入失败：${e.message}`, null, e?.lock ? { lock: e.lock } : {});
    }
  });
}
