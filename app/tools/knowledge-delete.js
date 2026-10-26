// knowledge-delete — 删除知识卡片
// KC5：删除保护保持 confirm/reason/dryRun/跨 agent 歧义/归档读回；新增
//   - 临界区内备份实际分片原文（APP_DATA_DIR/backups，wx + 逐字节读回）
//   - 全库数据锁 + 全局写队列（与 store 同顺序，不丢并发更新）
//   - 结构化 SDK 结果（content + details + isError），部分提交逐分片回报
//   - archiveRetention 需要额外 confirmPrune=true；无明确确认不清理恢复点
//   - 永不写 lifecycle 侧车（digest 绑定由 lifecycle 自己维护）
import fs from "node:fs";
import path from "node:path";
import {
  discoverShards,
  unsafeIgnoredEntries,
  MAX_SHARD_FILES,
  DELETED_DIR,
  DATA_DIR,
  isValidAgent,
  agentRejectionReason,
  validateId,
  getJsonlPath,
  assertInsideDataDir,
  readAllLines,
  writeAllLines,
  rebuildIndexSerialized,
  enqueueDataWrite,
  backupShardExclusive,
} from "../lib/jsonl-io.js";
import { withDataLock } from "../lib/data-lock.js";

export const name = "knowledge-delete";
export const description =
  "从知识卡片库删除指定卡片（按 id）。破坏性操作：删除前自动把被删卡片归档到 data/deleted/ 并逐字节校验，同时把分片原文备份到 APP_DATA_DIR/backups；必须提供 reason，必须显式 confirm=true 才执行；可先用 dryRun=true 预览，dryRun 时不会改动任何文件。";

export const parameters = {
  type: "object",
  properties: {
    ids: {
      type: "array",
      items: { type: "string" },
      description: "要删除的卡片 id 列表（kebab-case）；也可传单个字符串",
    },
    reason: {
      type: "string",
      description: "删除原因（必填，写入归档文件用于审计）",
    },
    agent: {
      type: "string",
      description: "限定卡片所属 agent（可选，收窄搜索范围，降低误删概率）；取值为库内实际存在的分片名",
    },
    confirm: {
      type: "boolean",
      description: "实际删除必须显式传 true；未传或 false 时拒绝执行（dryRun 预览不受此限）",
    },
    dryRun: {
      type: "boolean",
      description: "预览模式：只报告将删除哪些卡片，不写归档、不改动 jsonl",
    },
    ignoreMissing: {
      type: "boolean",
      description: "默认 false：任一 id 未找到则整体拒绝；置 true 时跳过未命中的 id 继续删除其余",
    },
    allowMultiAgent: {
      type: "boolean",
      description: "同一 id 在多个 agent 文件下存在时，默认拒绝；置 true 则删除全部命中（每个 agent 各删一处）",
    },
    archiveRetention: {
      type: "number",
      description: "归档保留数量（可选，默认 0 = 不清理）。>0 时必须同时传 confirmPrune:true 才会清理更早归档",
    },
    confirmPrune: {
      type: "boolean",
      description: "显式确认清理归档恢复点；未传时 archiveRetention 只报告、不删除任何归档",
    },
    expectedDigest: { type: "string", description: "可选单卡防覆盖：已预览内容的SHA256；与agent、单个id和expectedLifecycleRevision一起使用。" },
    expectedLifecycleRevision: { type: "integer", minimum: 0, description: "可选单卡防覆盖：预览时生命周期侧车全局revision。" },
  },
  required: ["ids", "reason"],
};

const MAX_BATCH = 200;
const MAX_REASON = 500;

function nowIso() {
  return new Date().toISOString();
}
function result(text, details = {}, isError = false) {
  return {
    ok: !isError,
    content: [{ type: "text", text }],
    details: { ok: !isError, ...details },
    ...(isError ? { isError: true } : {}),
  };
}
function deny(code, text, details = {}) {
  return result(text, { code, ...details }, true);
}

/**
 * 独占写入归档文件并 fsync。`wx` 保证同名文件不可覆盖；fsync 后再做逐字节读回校验。
 * 沙箱 Permission Model 禁用 fsync 时降级（仍读回校验）；其它 fsync 错误照旧抛。
 */
let _delFsyncWarned = false;
function isFsyncCapabilityDisabledDel(err) {
  const m = String((err && (err.message || err)) || "").toLowerCase();
  return m.includes("fsync") && (m.includes("disabled") || m.includes("not permitted") || m.includes("eperm"));
}
function writeArchiveExclusive(archivePath, content) {
  let fd;
  let created = false;
  try {
    fd = fs.openSync(archivePath, "wx");
    created = true;
    fs.writeFileSync(fd, content, "utf-8");
    try {
      fs.fsyncSync(fd);
    } catch (e) {
      if (isFsyncCapabilityDisabledDel(e)) {
        if (!_delFsyncWarned) {
          _delFsyncWarned = true;
          console.warn("[kc-system] fsync 在此运行环境被禁用（Permission Model）——归档写入已降级为不 fsync；读回校验仍在。此提示只出现一次。");
        }
      } else {
        throw e;
      }
    }
    fs.closeSync(fd);
    fd = undefined;
  } catch (e) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    // 写入/落盘失败时不保留可能是半截的归档；open 失败（如 EEXIST）不删既有文件。
    if (created) { try { if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath); } catch {} }
    throw e;
  }
}

/** 下一个归档批次序号：扫描既有归档文件名中的序号取最大值 +1（唯一性由临界区保证） */
function nextArchiveSeq() {
  let max = 0;
  try {
    for (const f of fs.readdirSync(DELETED_DIR)) {
      const m = f.match(/-(\d{3,})\.jsonl$/);
      if (m) {
        const n = Number(m[1]);
        if (Number.isFinite(n) && n > max) max = n;
      }
    }
  } catch {
    return 1;
  }
  return max + 1;
}

/** 归档文件名：`<agent>-<ISO>-<seq>.jsonl` */
const ARCHIVE_NAME_RE = /^(.+)-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-(\d+)\.jsonl$/;
function parseArchiveStamp(file) {
  const m = ARCHIVE_NAME_RE.exec(file);
  if (!m) return null;
  const t = Date.parse(`${m[2]}-${m[3]}-${m[4]}T${m[5]}:${m[6]}:${m[7]}.${m[8]}Z`);
  return Number.isFinite(t) ? t : null;
}

/** 只保留最近 retain 个归档文件；调用方必须已获得 confirmPrune 明确确认。 */
function pruneArchives(retain) {
  if (!Number.isInteger(retain) || retain <= 0) return 0;
  let files;
  try {
    files = fs.readdirSync(DELETED_DIR).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return 0;
  }
  const parsed = [];
  for (const f of files) {
    const ts = parseArchiveStamp(f);
    if (ts === null) continue; // 无法解析时间戳 → 保守保留
    parsed.push({ f, ts });
  }
  if (parsed.length <= retain) return 0;
  parsed.sort((a, b) => (b.ts - a.ts) || (a.f > b.f ? -1 : a.f < b.f ? 1 : 0));
  let n = 0;
  for (const { f } of parsed.slice(retain)) {
    const p = path.join(DELETED_DIR, f);
    try {
      assertInsideDataDir(p);
      if (fs.lstatSync(p).isSymbolicLink()) continue;
      fs.unlinkSync(p);
      n++;
    } catch {}
  }
  return n;
}

export async function execute(input, toolCtx) {
  const rawIds = input?.ids;
  const reason = (input?.reason || "").trim();
  const confirm = input?.confirm === true;
  const dryRun = input?.dryRun === true;
  const ignoreMissing = input?.ignoreMissing === true;
  const allowMultiAgent = input?.allowMultiAgent === true;
  const archiveRetention = input?.archiveRetention;
  const confirmPrune = input?.confirmPrune === true;
  const agentFilter = input?.agent;

  // ── 1. 参数与安全校验（不满足则不触碰文件系统）──
  const ids = Array.isArray(rawIds)
    ? rawIds
    : (typeof rawIds === "string" && rawIds.trim() ? [rawIds.trim()] : []);
  if (ids.length === 0) return deny("INVALID_IDS", "错误：缺少 ids。请提供要删除的卡片 id（字符串或字符串数组）。");
  if (ids.length > MAX_BATCH) return deny("TOO_MANY_IDS", `错误：单次最多删除 ${MAX_BATCH} 张（当前 ${ids.length} 张）。请分批操作。`);
  const badIds = ids.filter((id) => !validateId(id));
  if (badIds.length > 0) return deny("INVALID_ID", `错误：以下 id 格式非法（必须为 kebab-case）：${badIds.join(", ")}`);
  if (!reason) return deny("REASON_REQUIRED", "错误：缺少 reason。删除是破坏性操作，必须说明原因（会写入归档审计）。");
  if (reason.length > MAX_REASON) return deny("REASON_TOO_LONG", `错误：reason 过长（上限 ${MAX_REASON} 字，当前 ${reason.length} 字）。`);
  if (agentFilter !== undefined && !isValidAgent(agentFilter)) {
    return deny("INVALID_AGENT", `错误：agent 非法（${agentRejectionReason(agentFilter)}）。`);
  }
  if (archiveRetention !== undefined && (!Number.isInteger(archiveRetention) || archiveRetention < 0)) {
    return deny("INVALID_RETENTION", "错误：archiveRetention 必须为非负整数（不接收小数 / NaN / 负数）。");
  }
  if (!dryRun && !confirm) {
    return deny("CONFIRM_REQUIRED", "错误：未确认。实际删除必须显式传入 confirm: true；如仅需预览请传 dryRun: true。");
  }

  const guarded = input?.expectedDigest !== undefined || input?.expectedLifecycleRevision !== undefined;
  if (guarded && (!agentFilter || ids.length !== 1 || !/^[a-f0-9]{64}$/.test(input.expectedDigest || '') || !Number.isSafeInteger(input.expectedLifecycleRevision) || input.expectedLifecycleRevision < 0)) {
    return deny('INVALID_EXPECTATION', '带版本条件的删除必须指定单个id、agent、有效digest与生命周期revision。');
  }
  // Load lazily after data-root initialization, outside the short lock callback.
  const guardModules = guarded ? await Promise.all([import('../lib/repository.js'), import('../lib/lifecycle.js')]) : null;
  const uniqueIds = [...new Set(ids)];

  // ── 2. 定位（扫目录中发现的合法分片；物理身份 = 分片 agent）──
  const found = [];
  const missing = [];
  const multiAgentIds = new Set();
  const linesCache = new Map();
  const getLines = (agent) => {
    if (!linesCache.has(agent)) linesCache.set(agent, readAllLines(getJsonlPath(agent)));
    return linesCache.get(agent);
  };
  let scanAgents;
  try {
    const discovery = discoverShards();
    if (!discovery.ok) return deny("DATA_DIR_UNREADABLE", `错误：数据目录不可读，已中止删除（未做任何改动）：${discovery.error || "未知原因"}`);
    // 删除靠「按 id 跨分片定位」。未扫描到的分片、或可能藏着真实卡却读不到的分片，
    // 都会让本工具把「没找到」误报成 missing，甚至对别处的同名卡报告成功。因此整库拒绝。
    if (discovery.truncated) {
      return deny("SHARD_DISCOVERY_TRUNCATED", `错误：分片目录条目超过扫描上限，无法确认全部分片；已中止删除（未做任何改动）。请先归档或分流减少分片数。`, { maxShardFiles: MAX_SHARD_FILES });
    }
    const unsafe = unsafeIgnoredEntries(discovery);
    if (unsafe.length > 0) {
      return deny("SHARD_DISCOVERY_UNSAFE", `错误：存在可能包含卡片但无法安全读取的分片条目（${unsafe.map(x => `${x.name}: ${x.reason}`).join("；")}）；已中止删除（未做任何改动）。`);
    }
    scanAgents = discovery.agents;
  } catch (err) {
    return deny("LOCATE_FAILED", `错误：枚举分片失败（未做任何改动）：${err.message}`);
  }
  try {
    for (const id of uniqueIds) {
      const hits = [];
      for (const agent of scanAgents) {
        if (agentFilter && agent !== agentFilter) continue;
        for (const line of getLines(agent)) {
          try {
            const card = JSON.parse(line);
            if (card && card.id === id) {
              hits.push({ id, agent, card });
              break; // 每个 agent 文件内 id 唯一，命中即止
            }
          } catch {}
        }
      }
      if (hits.length === 0) missing.push(id);
      else {
        if (hits.length > 1) multiAgentIds.add(id);
        found.push(...hits);
      }
    }
  } catch (err) {
    return deny("LOCATE_FAILED", `错误：定位卡片时读取分片失败（未做任何改动）：${err.message}`);
  }

  if (multiAgentIds.size > 0 && !allowMultiAgent) {
    return deny(
      "MULTI_AGENT_AMBIGUOUS",
      `错误：以下 id 在多个 agent 下存在：${[...multiAgentIds].join(", ")}。请用 agent 参数限定归属，或传 allowMultiAgent: true 删除全部命中。`,
      { multiAgentIds: [...multiAgentIds] },
    );
  }
  if (missing.length > 0 && !ignoreMissing) {
    return deny("MISSING_IDS", `错误：以下 id 未找到，已整体拒绝：${missing.join(", ")}。如确认这些可跳过，请传 ignoreMissing: true 重试。`, { missing });
  }
  if (found.length === 0) {
    return deny("NOT_FOUND", `未找到任何匹配的卡片（未命中：${missing.join(", ") || "无"}）。`, { missing });
  }

  // ── 3. dryRun 预览 ──
  if (dryRun) {
    return result(
      [
        `【dryRun 预览】将删除 ${found.length} 张卡片（未做任何改动）：`,
        ...found.map((f) => `- ${f.card.id}（${f.agent}）：${f.card.summary || ""}`),
        `未命中跳过：${missing.join(", ") || "无"}`,
        `归档目录：data/deleted/；分片恢复点：APP_DATA_DIR/backups/`,
      ].join("\n"),
      { dryRun: true, planned: found.map((f) => ({ id: f.id, agent: f.agent })), missing },
    );
  }

  // ── 4. 按 agent 分组 ──
  const byAgent = new Map();
  for (const f of found) {
    if (!byAgent.has(f.agent)) byAgent.set(f.agent, []);
    byAgent.get(f.agent).push(f);
  }

  try {
    assertInsideDataDir(DATA_DIR);
    if (!fs.existsSync(DELETED_DIR)) fs.mkdirSync(DELETED_DIR, { recursive: true });
  } catch (err) {
    return deny("ARCHIVE_DIR_UNAVAILABLE", `错误：归档目录不可用，已中止删除（未删除任何卡片）：${err.message}`);
  }

  const deletedAt = nowIso();
  const stamp = deletedAt.replace(/[:.]/g, "-");
  const deletedBy = toolCtx?.agentId || toolCtx?.agent || "unknown";

  // ── 5. 归档 + 备份 + 删除同处一个全局写队列 / data-lock 临界区 ──
  let tx;
  try {
    tx = await enqueueDataWrite(() => {
      const state = {
        removedCount: 0,
        committedAgents: [],
        committedShards: [],
        preparedArchives: [],
        lockReleaseWarnings:[],
        backups: [],
        failures: [],
      };
      for (const [agent, items] of byAgent) {
        const idsToRemove = new Set(items.map((it) => it.id));
        const filePath = getJsonlPath(agent);
        const agentState = { archivePath: null, archiveWritten: false, archiveVerified: false, backupPath: null, removed: 0 };
        try {
          assertInsideDataDir(filePath);
          const r = withDataLock(() => {
            const lines = readAllLines(filePath);
            const kept = [];
            const removed = [];
            for (const line of lines) {
              let card;
              try { card = JSON.parse(line); } catch { kept.push(line); continue; }
              if (card && idsToRemove.has(card.id)) removed.push({ line, card });
              else kept.push(line);
            }
            if (removed.length === 0) {
              if (guarded) { const e = new Error('目标卡片已被移除，请重新读取'); e.code = 'TARGET_MISSING'; throw e; }
              return { removed: 0 };
            }

            const counts = new Map();
            for (const { card } of removed) counts.set(card.id, (counts.get(card.id) || 0) + 1);
            const dup = [...counts.entries()].find(([, n]) => n > 1);
            if (dup) {
              const err = new Error(`分片 ${agent} 内 id=${dup[0]} 存在 ${dup[1]} 条记录，拒绝歧义删除`);
              err.code = "TARGET_AMBIGUOUS";
              throw err;
            }

            if (guarded) {
              const [repository, lifecycle] = guardModules;
              const life = lifecycle.readLifecycle();
              const rejectGuard = (code, message) => { const e = new Error(message); e.code = code; throw e; };
              if (!life.ok || !life.complete) rejectGuard('LIFECYCLE_UNAVAILABLE', '生命周期侧车不可读，未删除');
              if (life.revision !== input.expectedLifecycleRevision) rejectGuard('REVISION_CONFLICT', '生命周期记录已被其它操作更新，请重新读取目标');
              if (removed.length !== 1 || repository.cardDigest(removed[0].card) !== input.expectedDigest) rejectGuard('DIGEST_MISMATCH', '目标内容已变化，请重新预览后决定');
              const identity = `${agent}::${items[0].id}`;
              const references = Object.entries(life.entries).filter(([key, entry]) => key !== identity && entry.supersededBy === identity).map(([key]) => key);
              if (references.length) rejectGuard('TARGET_REFERENCED', `此卡是 ${references.length} 张旧卡的替代目标，请先调整替代关系或使用归档`);
              const snapshot = repository.readRepository({ includeInactive: true });
              if (!snapshot.ok || !snapshot.complete) rejectGuard('MANAGEMENT_UNAVAILABLE', '正式库不完整，暂停删除');
            }

            // 覆盖既有分片前先留恢复点
            const backup = backupShardExclusive(filePath, { reason: `delete:${reason}` });
            agentState.backupPath = backup?.path || null;
            const uniq = String(nextArchiveSeq()).padStart(3, "0");
            const archivePath = path.join(DELETED_DIR, `${agent}-${stamp}-${uniq}.jsonl`);
            agentState.archivePath = archivePath;
            assertInsideDataDir(archivePath);
            const archiveLines = removed.map(({ card }) => JSON.stringify({
              ...card, deletedAt, reason, deletedBy, deletedFrom: agent,
            }));
            const archiveText = archiveLines.join("\n") + "\n";
            try {
              writeArchiveExclusive(archivePath, archiveText);
            } catch (e) {
              if (e.code !== "EEXIST" && !String(e.code || "").startsWith("ARCHIVE_")) {
                e.code = "ARCHIVE_WRITE_FAILED";
              }
              throw e;
            }
            agentState.archiveWritten = true;
            const readBack = fs.readFileSync(archivePath, "utf-8");
            if (readBack !== archiveText) {
              const err = new Error(
                `归档完整性校验失败：读回内容与被删数据不一致（归档 ${Buffer.byteLength(archiveText, "utf-8")} 字节，读回 ${Buffer.byteLength(readBack, "utf-8")} 字节）`,
              );
              err.code = "ARCHIVE_VERIFY_FAILED";
              err.archivePath = archivePath;
              err.backupPath = agentState.backupPath;
              throw err;
            }
            agentState.archiveVerified = true;
            try {
              writeAllLines(filePath, kept);
            } catch (e) {
              e.archivePath = archivePath;
              e.backupPath = agentState.backupPath;
              e.archiveVerified = true;
              throw e;
            }
            agentState.removed = removed.length;
            return { removed: removed.length, archivePath, backupPath: backup?.path || null };
          });
          if(r.lockReleaseWarning)state.lockReleaseWarnings.push({agent,...r.lockReleaseWarning});
          if (r.removed > 0) {
            state.removedCount += r.removed;
            state.committedAgents.push(agent);
            state.preparedArchives.push({ agent, path: r.archivePath, verified: true, committed: true });
            if (r.backupPath) state.backups.push({ agent, path: r.backupPath });
          }
        } catch (err) {
          const archivePath = err?.archivePath || (agentState.archiveWritten ? agentState.archivePath : null);
          const verified = err?.archiveVerified === true || agentState.archiveVerified === true;
          if (archivePath) state.preparedArchives.push({ agent, path: archivePath, verified, committed: false });
          const backupPath = err?.backupPath || agentState.backupPath;
          if (backupPath) state.backups.push({ agent, path: backupPath });
          const rawCode = err?.code || "DELETE_FAILED";
          const code = rawCode === "E_LOCKED" ? "LOCKED" : rawCode === "E_LOCK_UNSUPPORTED" ? "LOCK_UNSUPPORTED" : rawCode;
          const stage = code === "BACKUP_FAILED" || code === "BACKUP_REFUSED" || code === "BACKUP_VERIFY_FAILED"
            ? "backup"
            : String(code).startsWith("ARCHIVE_") ? "archive" : "shard";
          state.failures.push({
            agent,
            stage,
            code,
            error: err?.message || String(err),
            archivePath: archivePath || null,
            backupPath: backupPath || null,
            ...(err?.lock ? { lock: err.lock } : {}),
          });
          break; // 首个分片失败即停止后续分片，限制部分提交范围
        }
      }
      state.committedShards = [...state.committedAgents];
      return state;
    });
  } catch (err) {
    return deny("DELETE_FAILED", `错误：删除事务未执行：${err.message}`);
  }

  // ── 6. 索引刷新（锁外、全局串行）──
  let totalCards = null;
  let indexError = null;
  try {
    totalCards = await rebuildIndexSerialized();
  } catch (e) {
    indexError = e.message;
  }

  if (tx.failures.length > 0) {
    const partial = tx.committedAgents.length > 0;
    const code = partial
      ? "PARTIAL_COMMIT"
      : (tx.failures.length === 1 ? tx.failures[0].code : "DELETE_FAILED");
    const text = [
      partial
        ? `错误：删除仅部分完成（跨分片不是原子事务）：已删除 ${tx.removedCount} 张，已提交分片：${tx.committedShards.join(", ")}。`
        : "错误：删除失败（未提交任何分片）。",
      ...tx.failures.map((f) => `- ${f.agent}: [${f.stage}/${f.code}] ${f.error}`),
      `已准备归档：${tx.preparedArchives.length}（未提交 ${tx.preparedArchives.filter((a) => !a.committed).length}）；分片备份：${tx.backups.length}。`,
      "恢复前先对照 committedShards：只恢复已提交分片；未提交归档若直接插回，会与仍在库的卡形成双行。",
      indexError ? `索引重建失败：${indexError}` : "索引已刷新。",
    ].join("\n");
    return result(text, {
      code,
      removedCount: tx.removedCount,
      committedAgents: tx.committedAgents,
      committedShards: tx.committedShards,
      preparedArchives: tx.preparedArchives,
      backups: tx.backups,
      failures: tx.failures,
      lockReleaseWarnings:tx.lockReleaseWarnings,
      missing,
      totalCards,
      indexError,
    }, true);
  }

  // ── 7. 归档保留策略：无 confirmPrune 绝不清理 ──
  let pruned = 0;
  let pruneSkipped = false;
  if (Number.isInteger(archiveRetention) && archiveRetention > 0) {
    if (confirmPrune) pruned = pruneArchives(archiveRetention);
    else pruneSkipped = true;
  }

  const out = [
    `✅ 已删除 ${tx.removedCount} 张知识卡片（未命中跳过：${missing.join(", ") || "无"}）。`,
    `归档分片：${tx.committedAgents.join(", ")}（位于 data/deleted/）`,
    `分片恢复点：${tx.backups.length} 个（APP_DATA_DIR/backups/，默认不自动清理）`,
    totalCards === null ? `索引重建失败：${indexError}` : `当前知识库共 ${totalCards} 张卡片。`,
    `如需恢复，可从 data/deleted/ 或 backups/ 取回原文。`,
  ];
  if(tx.lockReleaseWarnings.length)out.push('事务已提交，但数据锁释放有异常；详见details.lockReleaseWarnings，不要按未删除恢复卡片。');
  if (pruneSkipped) out.push(`archiveRetention=${archiveRetention} 未执行：需要显式 confirmPrune: true。`);
  if (pruned > 0) out.push(`已按保留策略清理 ${pruned} 个较早的归档文件（恢复点备份不受影响）。`);

  return result(out.join("\n"), {
    removedCount: tx.removedCount,
    committedAgents: tx.committedAgents,
    committedShards: tx.committedShards,
    preparedArchives: tx.preparedArchives,
    backups: tx.backups,
    failures: [],
    missing,
    lockReleaseWarnings:tx.lockReleaseWarnings,
    pruned,
    pruneSkipped,
    totalCards,
    indexError,
  });
}
