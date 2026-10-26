// lib/data-lock.js — KC5 数据修改私有全库锁（单入口）
//
// 合同：docs/api-contract.md / docs/design-amendments.md
// - withDataLock(fn,{ownerToken?}) 同步；fn 返回 Promise 即拒绝（短事务，锁不跨 await）。
// - tmp + hard link 原子发布，lock 文件不存在半写窗口；不支持 link 明确报错，不降级 wx。
// - 释放前核对模块自己的内部 token；不按 TTL 抢锁，不信任 caller 任意字符串。
// - inspectDataLock 只读；recoverDataLock 仅 dead / ownerless（ownerless 必须 digest 匹配）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { APP_DATA_DIR } from './jsonl-io.js';
import { noteFailure,noteSuccess } from './runtime-health.js';

export const LOCK_DIR = path.join(APP_DATA_DIR, 'locks');
export const LOCK_PATH = path.join(LOCK_DIR, 'data.lock.json');
const TOKEN_RE = /^[0-9a-f]{64}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/i;
const UNSUPPORTED_LINK = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EINVAL', 'EXDEV']);
let _active = null; // { token, ownerLabel, pid, startedAt }
let _fsyncWarned = false;

function lockError(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}
function fail(code, message, extra = {}) {
  return { ok: false, code, error: message, ...extra };
}
function isFsyncCapabilityDisabled(err) {
  const m = String((err && (err.message || err)) || '').toLowerCase();
  return m.includes('fsync') && (m.includes('disabled') || m.includes('not permitted') || m.includes('eperm'));
}
function fsyncStrict(fd) {
  try {
    fs.fsyncSync(fd);
  } catch (e) {
    if (!isFsyncCapabilityDisabled(e)) throw e;
    if (!_fsyncWarned) {
      _fsyncWarned = true;
      console.warn('[kc-system] fsync 在此运行环境被禁用（Permission Model）——数据锁已降级为不 fsync（tmp+link 原子性不变）。此提示只出现一次。');
    }
  }
}
function digestOf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
function parseOwner(buf) {
  let value;
  try { value = JSON.parse(buf.toString('utf-8')); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!Number.isInteger(value.pid) || value.pid <= 0) return null;
  if (typeof value.token !== 'string' || !TOKEN_RE.test(value.token)) return null;
  if (typeof value.startedAt !== 'string' || !value.startedAt) return null;
  return value;
}
function processState(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return 'unknown';
  if (pid === process.pid) return 'live';
  try {
    process.kill(pid, 0);
    return 'live';
  } catch (e) {
    if (e && e.code === 'ESRCH') return 'dead';
    if (e && e.code === 'EPERM') return 'live';
    return 'unknown';
  }
}
function readArtifact() {
  const st = fs.lstatSync(LOCK_PATH);
  if (st.isSymbolicLink()) {
    const err = lockError('LOCK_SYMLINK', `拒绝读取符号链接锁：${LOCK_PATH}`);
    throw err;
  }
  const buf = fs.readFileSync(LOCK_PATH);
  return { buf, digest: digestOf(buf) };
}
function remedyFor(state) {
  if (state === 'missing') return '无需处理';
  if (state === 'live') return '等待持锁进程完成；不要按时间强夺。若确认进程已失效，先完整停止 App 再按 kc_verify recover-lock 显式恢复。';
  if (state === 'dead') return '持有进程已不存在：使用 recoverDataLock({confirm:true,reason}) 隔离锁文件。';
  if (state === 'ownerless') return '锁文件无有效 owner：核对 digest 后使用 recoverDataLock({confirm:true,reason,expectedDigest}) 隔离。';
  if (state === 'unknown') return '无法证明持有进程死亡（PID 复用或权限错误）：不要强夺；完整停止 App 后人工核查。';
  return '锁文件不可读：检查文件权限/介质错误。';
}

/**
 * 只读检查数据锁。永不写文件、永不自动恢复。
 * @returns {{ok:boolean, exists:boolean|null, state:'missing'|'live'|'dead'|'ownerless'|'unknown'|'unavailable', path:string, digest?:string|null, owner?:object|null, remedy?:string, error?:object}}
 */
export function inspectDataLock() {
  try {
    if (!fs.existsSync(LOCK_PATH)) {
      return { ok: true, exists: false, state: 'missing', path: LOCK_PATH, digest: null, owner: null, remedy: remedyFor('missing') };
    }
    const { buf, digest } = readArtifact();
    const parsed = parseOwner(buf);
    if (!parsed) {
      return { ok: true, exists: true, state: 'ownerless', path: LOCK_PATH, digest, owner: null, remedy: remedyFor('ownerless') };
    }
    const state = processState(parsed.pid);
    return {
      ok: true,
      exists: true,
      state,
      path: LOCK_PATH,
      digest,
      owner: {
        pid: parsed.pid,
        startedAt: parsed.startedAt,
        label: typeof parsed.label === 'string' ? parsed.label : null,
      },
      remedy: remedyFor(state),
    };
  } catch (e) {
    return {
      ok: false,
      exists: null,
      state: 'unavailable',
      path: LOCK_PATH,
      digest: null,
      owner: null,
      error: { code: e?.code || 'LOCK_UNREADABLE', message: e?.message || String(e) },
      remedy: remedyFor('unavailable'),
    };
  }
}

function busyError() {
  const snap = inspectDataLock();
  return lockError('E_LOCKED', `KC 数据锁忙（state=${snap.state}）：${snap.path}`, { lock: snap });
}
function acquire(owner) {
  fs.mkdirSync(LOCK_DIR, { recursive: true });
  if (fs.existsSync(LOCK_PATH)) throw busyError();
  const tmp = path.join(LOCK_DIR, `data.lock.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx');
    fs.writeFileSync(fd, JSON.stringify(owner));
    fsyncStrict(fd);
    fs.closeSync(fd);
    fd = undefined;
    try {
      fs.linkSync(tmp, LOCK_PATH);
    } catch (e) {
      if (e && e.code === 'EEXIST') throw busyError();
      if (e && UNSUPPORTED_LINK.has(e.code)) {
        throw lockError('E_LOCK_UNSUPPORTED', `当前文件系统不支持 hard link，拒绝降级为非原子锁：${e.message}`);
      }
      throw lockError('E_LOCK_ACQUIRE', `数据锁发布失败：${e.message}`);
    }
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
  }
  // 读回核对：确保最终文件就是本次完整写入，而不是别人的锁。
  const verify = parseOwner(fs.readFileSync(LOCK_PATH));
  if (!verify || verify.token !== owner.token) {
    throw lockError('E_LOCK_ACQUIRE', '数据锁读回 token 不一致，拒绝继续');
  }
}
function release(token) {
  _active = null;
  try {
    if (!fs.existsSync(LOCK_PATH)) return;
    const parsed = parseOwner(fs.readFileSync(LOCK_PATH));
    if (!parsed || parsed.token !== token) {
      throw lockError('E_LOCK_OWNERSHIP', '数据锁 token 不匹配，拒绝删除非本事务锁');
    }
    fs.unlinkSync(LOCK_PATH);
  } catch (e) {
    if (e && e.code === 'ENOENT') return;
    if (e && e.code === 'E_LOCK_OWNERSHIP') throw e;
    throw lockError('E_LOCK_RELEASE', `数据锁释放失败：${e.message}`);
  }
}
function invoke(fn) {
  const out = fn();
  if (out && (typeof out === 'object' || typeof out === 'function') && typeof out.then === 'function') {
    try { out.then(() => {}, () => {}); } catch {}
    throw lockError('E_LOCK_ASYNC', 'withDataLock 回调必须同步；返回 Promise 会造成锁跨 await，已拒绝');
  }
  return out;
}
function normalizeOwnerToken(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > 200) {
    throw lockError('E_LOCK_INVALID', 'ownerToken 必须是非空字符串（≤200 字符）');
  }
  return value;
}

/**
 * 同步短事务。回调内完成当前快照读取与写入；不得 await，不得嵌套索引重建。
 * 同进程嵌套可重入（ownerToken 匹配当前事务时允许传递）。
 */
export function withDataLock(fn, options = {}) {
  if (typeof fn !== 'function') throw lockError('E_LOCK_INVALID', 'withDataLock 需要同步函数');
  const ownerLabel = normalizeOwnerToken(options?.ownerToken);
  if (_active) {
    if (ownerLabel !== undefined) {
      const accepted = ownerLabel === _active.token || (_active.ownerLabel !== undefined && ownerLabel === _active.ownerLabel);
      if (!accepted) throw lockError('E_LOCK_OWNER_MISMATCH', '嵌套 ownerToken 与当前事务不匹配');
    }
    return invoke(fn);
  }
  const token = crypto.randomBytes(32).toString('hex');
  const owner = {
    version: 1,
    token,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    ...(ownerLabel !== undefined ? { label: ownerLabel } : {}),
  };
  acquire(owner);
  _active = { token, ownerLabel, pid: owner.pid, startedAt: owner.startedAt };
  let value,fnError=null,warning=null;
  try { value=invoke(fn); } catch(e) { fnError=e; }
  try { release(token);noteSuccess('data-lock-release'); }
  catch(e) {
    warning={code:e?.code||'E_LOCK_RELEASE',error:String(e?.message||e),remedy:'事务结果仍有效；锁文件可能残留。停止 App 后核查，禁止按 TTL 或 live PID 强夺。'};
    noteFailure('data-lock-release',e);
    console.warn(`[kc-system] 数据锁释放异常；保留事务结果：${warning.error}`);
  }
  if(fnError){if(warning)fnError.lockReleaseWarning=warning;throw fnError;}
  // Unlock is post-transaction maintenance, never evidence that a completed mutation did not happen.
  return warning&&value&&typeof value==='object'&&!Array.isArray(value)?{...value,lockReleaseWarning:warning}:value;
}

/**
 * 显式恢复：只处理 dead / ownerless；live/unknown/读不到一律拒绝。
 * ownerless 必须提供 expectedDigest（来自 inspectDataLock().digest）。
 */
export function recoverDataLock(input = {}) {
  if (input && input.path !== undefined) {
    let same = false;
    try { same = path.resolve(String(input.path)) === path.resolve(LOCK_PATH); } catch {}
    if (!same) return fail('INVALID_PATH', 'recoverDataLock 不接受任意路径，只处理 KC 私有数据锁');
  }
  if (input?.confirm !== true) return fail('CONFIRM_REQUIRED', '恢复数据锁必须显式 confirm: true');
  const reason = typeof input?.reason === 'string' ? input.reason.trim() : '';
  if (!reason) return fail('REASON_REQUIRED', '恢复数据锁必须提供 reason');
  if (reason.length > 500) return fail('REASON_TOO_LONG', 'reason 超过 500 字符');
  let expected;
  if (input?.expectedDigest !== undefined) {
    if (typeof input.expectedDigest !== 'string' || !DIGEST_RE.test(input.expectedDigest)) {
      return fail('INVALID_DIGEST', 'expectedDigest 必须是 64 位十六进制 sha256');
    }
    expected = input.expectedDigest.toLowerCase();
  }
  const snap = inspectDataLock();
  if (!snap.ok || snap.state === 'unavailable') {
    return fail('LOCK_UNAVAILABLE', snap.error?.message || '数据锁不可读', { lock: snap });
  }
  if (snap.state === 'missing') return fail('LOCK_MISSING', '数据锁不存在，无需恢复', { lock: snap });
  if (snap.state === 'live') return fail('LOCK_LIVE', '数据锁持有进程仍存活，拒绝恢复', { lock: snap });
  if (snap.state === 'unknown') return fail('LOCK_UNKNOWN', '无法证明持有进程已死亡，拒绝恢复', { lock: snap });
  if (snap.state === 'ownerless' && expected === undefined) {
    return fail('EXPECTED_DIGEST_REQUIRED', 'ownerless 锁必须提供 expectedDigest 才能隔离', { lock: snap });
  }
  if (expected !== undefined && expected !== String(snap.digest).toLowerCase()) {
    return fail('DIGEST_MISMATCH', 'expectedDigest 与当前锁文件不一致', { lock: snap, currentDigest: snap.digest });
  }
  // 隔离前再次核对字节：防止 inspect 与 rename 之间锁被替换成别的 owner。
  try {
    const now = readArtifact();
    if (now.digest !== snap.digest) {
      return fail('LOCK_CHANGED', '锁文件在恢复检查期间发生变化，拒绝隔离', { lock: inspectDataLock(), currentDigest: now.digest });
    }
  } catch (e) {
    return fail('LOCK_UNAVAILABLE', `恢复前复核锁文件失败：${e.message}`, { lock: inspectDataLock() });
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const quarantined = path.join(LOCK_DIR, `data.lock.quarantine-${stamp}-${crypto.randomBytes(4).toString('hex')}.json`);
  try {
    fs.renameSync(LOCK_PATH, quarantined);
  } catch (e) {
    return fail('QUARANTINE_FAILED', `隔离锁文件失败（原锁保留）：${e.message}`, { lock: snap });
  }
  return {
    ok: true,
    code: 'LOCK_RECOVERED',
    path: LOCK_PATH,
    quarantined,
    digest: snap.digest,
    state: snap.state,
    owner: snap.owner,
    reason,
  };
}
