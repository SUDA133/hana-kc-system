// lib/lifecycle-schema.js — strict schema/validation for data/lifecycle.json (schemaVersion 1).
// 纯校验，不读盘不写盘；lifecycle.js 负责存储与 CAS，repository.js 不直接依赖本文件。
import { isValidAgent, validateId } from './jsonl-io.js';

export const SCHEMA_VERSION = 1;
export const MAX_ENTRIES = 5000;
export const MAX_BYTES = 2 * 1024 * 1024;
export const MAX_SOURCE_REFS = 10;
export const MAX_SOURCE_REF_LENGTH = 500;
export const MAX_SCOPE_LENGTH = 200;
export const MAX_REASON_LENGTH = 1000;
export const STATUSES = Object.freeze(['active', 'deprecated', 'superseded', 'archived']);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
export const DIGEST_RE = /^[0-9a-f]{64}$/i;
const ENTRY_KEYS = new Set([
  'status', 'targetDigest', 'sourceRefs', 'scope', 'verifiedAt', 'validUntil',
  'supersededBy', 'reason', 'updatedAt',
]);

export const plain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

export function isStrictDateOnly(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function isStrictIsoDateOrDateTime(value) {
  if (typeof value !== 'string') return false;
  if (isStrictDateOnly(value)) return true;
  if (!DATETIME_RE.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}

export function parseIdentityKey(key) {
  if (typeof key !== 'string') return null;
  const i = key.indexOf('::');
  if (i <= 0 || i !== key.lastIndexOf('::')) return null;
  const agent = key.slice(0, i);
  const id = key.slice(i + 2);
  if (!isValidAgent(agent) || !validateId(id)) return null;
  return { agent, id, identity: `${agent}::${id}` };
}

function validateIdentityRef(value) {
  if (typeof value !== 'string' || !value.trim()) return { ok: false, error: '身份必须是非空字符串' };
  const parsed = parseIdentityKey(value.trim());
  if (!parsed) return { ok: false, error: `身份不是合法的 agent::id：${value}` };
  return { ok: true, value: parsed.identity };
}

function validateDateField(value, field) {
  if (value === null) return { ok: true, value: null };
  if (!isStrictIsoDateOrDateTime(value)) {
    return { ok: false, error: `${field} 必须是严格 ISO 日期或日期时间：${String(value)}` };
  }
  return { ok: true, value };
}

/**
 * 校验并归一化 metadata（不含 targetDigest/reason/updatedAt）。
 * 未知字段拒绝，不把畸形 shape 静默洗白。
 */
export function normalizeMetadata(metadata) {
  if (!plain(metadata)) return { ok: false, error: 'metadata 必须是对象（清除用 null）' };
  for (const key of Object.keys(metadata)) {
    if (!ENTRY_KEYS.has(key) || key === 'targetDigest' || key === 'reason' || key === 'updatedAt') {
      return { ok: false, error: `metadata 含未知字段：${key}` };
    }
  }
  if (!STATUSES.includes(metadata.status)) {
    return { ok: false, error: `status 必须是 ${STATUSES.join('|')}` };
  }
  const refs = metadata.sourceRefs === undefined ? [] : metadata.sourceRefs;
  if (!Array.isArray(refs)) return { ok: false, error: 'sourceRefs 必须是数组' };
  if (refs.length > MAX_SOURCE_REFS) return { ok: false, error: `sourceRefs 最多 ${MAX_SOURCE_REFS} 条` };
  const sourceRefs = [];
  for (const ref of refs) {
    if (typeof ref !== 'string' || !ref.trim()) return { ok: false, error: 'sourceRefs 每项必须是非空字符串' };
    const t = ref.trim();
    if (t.length > MAX_SOURCE_REF_LENGTH) return { ok: false, error: `sourceRef 超长（>${MAX_SOURCE_REF_LENGTH}）` };
    if (!sourceRefs.includes(t)) sourceRefs.push(t);
  }
  const scopeRaw = metadata.scope === undefined ? {} : metadata.scope;
  if (!plain(scopeRaw)) return { ok: false, error: 'scope 必须是对象' };
  const scope = {};
  for (const key of Object.keys(scopeRaw)) {
    if (key !== 'project' && key !== 'versionRange') return { ok: false, error: `scope 含未知字段：${key}` };
    const v = scopeRaw[key];
    if (typeof v !== 'string' || !v.trim()) return { ok: false, error: `scope.${key} 必须是非空字符串` };
    if (v.trim().length > MAX_SCOPE_LENGTH) return { ok: false, error: `scope.${key} 超长` };
    scope[key] = v.trim();
  }
  const verified = validateDateField(metadata.verifiedAt === undefined ? null : metadata.verifiedAt, 'verifiedAt');
  if (!verified.ok) return verified;
  const until = validateDateField(metadata.validUntil === undefined ? null : metadata.validUntil, 'validUntil');
  if (!until.ok) return until;
  let supersededBy = null;
  if (metadata.supersededBy !== undefined && metadata.supersededBy !== null) {
    const ref = validateIdentityRef(metadata.supersededBy);
    if (!ref.ok) return ref;
    supersededBy = ref.value;
    // 状态与替代目标必须自洽：只有 superseded 才谈得上「被谁替代」。
    // active/deprecated/archived + supersededBy 是矛盾组合，写入拒、读取判坏（不洗白成有效 active）。
    if (metadata.status !== 'superseded') {
      return { ok: false, error: `status=${metadata.status} 与 supersededBy 矛盾：只有 superseded 才能记录替代目标` };
    }
  }
  return {
    ok: true, value: {
      status: metadata.status, sourceRefs, scope,
      verifiedAt: verified.value, validUntil: until.value, supersededBy,
    },
  };
}

export function validateStoredEntry(raw) {
  if (!plain(raw)) return { ok: false, error: 'entry 不是对象' };
  for (const key of Object.keys(raw)) {
    if (!ENTRY_KEYS.has(key)) return { ok: false, error: `entry 含未知字段：${key}` };
  }
  if (typeof raw.targetDigest !== 'string' || !DIGEST_RE.test(raw.targetDigest)) {
    return { ok: false, error: 'targetDigest 必须是 64 位十六进制' };
  }
  const metaRaw = {
    status: raw.status, sourceRefs: raw.sourceRefs, scope: raw.scope,
    verifiedAt: raw.verifiedAt, validUntil: raw.validUntil, supersededBy: raw.supersededBy,
  };
  const meta = normalizeMetadata(metaRaw);
  if (!meta.ok) return meta;
  if (typeof raw.reason !== 'string' || !raw.reason.trim()) return { ok: false, error: 'reason 必须是非空字符串' };
  if (raw.reason.length > MAX_REASON_LENGTH) return { ok: false, error: `reason 超长（>${MAX_REASON_LENGTH}）` };
  if (!isStrictIsoDateOrDateTime(raw.updatedAt)) return { ok: false, error: 'updatedAt 必须是严格 ISO 时间' };
  return {
    ok: true, value: {
      ...meta.value, targetDigest: raw.targetDigest.toLowerCase(),
      reason: raw.reason.trim(), updatedAt: raw.updatedAt,
    },
  };
}
