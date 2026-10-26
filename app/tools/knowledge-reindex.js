// knowledge-reindex — 重建知识卡片检索索引
// KC5：默认只 rebuild index，绝不改写旧卡统计；
//      normalize 迁移仅在 input.normalize === true 且 input.confirm === true 时执行，
//      迁移在 data-lock + 全库写队列内完成，并在覆盖分片前写恢复点。
import {
  INDEX_FILE,
  assertInsideDataDir,
  rebuildIndexSerialized,
  normalizeStores,
  enqueueDataWrite,
} from "../lib/jsonl-io.js";
import { withDataLock } from "../lib/data-lock.js";

export const name = "knowledge-reindex";
export const description =
  "重建知识卡片检索索引（index.json）。默认只读各 agent 的 jsonl 并重写索引，不迁移、不改写卡片统计；数据未变化时索引逐字节稳定。仅当显式 normalize=true 且 confirm=true 时，才把历史 queryCount/lastQueried 迁移到 stats.json 并从分片剥离（迁移前留分片备份）。";

export const parameters = {
  type: "object",
  properties: {
    normalize: {
      type: "boolean",
      description: "显式请求数据归一化（把历史 queryCount/lastQueried 迁移到 stats.json）；默认 false，只重建索引",
    },
    confirm: {
      type: "boolean",
      description: "normalize=true 时必须同时传 confirm=true 才执行迁移；默认 false",
    },
  },
  required: [],
};

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

export async function execute(input = {}) {
  const normalize = input?.normalize === true;
  const confirm = input?.confirm === true;
  if (normalize && !confirm) {
    return deny(
      "NORMALIZE_CONFIRM_REQUIRED",
      "错误：normalize=true 会改写分片（迁移统计字段），必须同时传 confirm=true；本次未做任何改动。",
    );
  }

  try {
    assertInsideDataDir(INDEX_FILE);
  } catch (err) {
    return deny("INDEX_UNAVAILABLE", `错误：索引路径不可用：${err.message}`);
  }

  let norm = null;
  if (normalize) {
    try {
      // normalizeStores 是同步的；锁内完成当前快照的读改写，索引重建留在锁外。
      norm = await enqueueDataWrite(() => withDataLock(() => normalizeStores()));
    } catch (err) {
      return deny(
        err?.code === 'E_LOCKED' ? 'LOCKED' : 'NORMALIZE_FAILED',
        `错误：数据归一化未执行（分片与 stats.json 保持原样）：${err.message}`,
        { lock: err?.lock || null },
      );
    }
  }

  let total;
  try {
    total = await rebuildIndexSerialized();
  } catch (err) {
    return deny(
      "INDEX_REBUILD_FAILED",
      `错误：索引重建失败：${err.message}`,
      { normalize: normalize ? { attempted: true, error: norm?.error || null } : null },
    );
  }

  if (norm?.error) {
    const lines = [
      `⚠️ 索引已重建（共收录 ${total} 张知识卡片），但数据归一化未完整完成：`,
      `   ${norm.error}`,
    ];
    if (norm.statsCommitted) {
      lines.push(`   stats.json 已提交（${norm.migratedStats} 条统计记录）。`);
    } else {
      lines.push("   stats.json 未提交；分片未改写（原文件保持原样）。");
    }
    if (norm.committedShards?.length) {
      lines.push(`   已重写分片：${norm.committedShards.join(", ")}（备份 ${norm.backups?.length || 0} 份）。`);
    } else {
      lines.push("   没有分片被重写。");
    }
    if (norm.failures?.length) {
      lines.push(`   失败：${norm.failures.map((f) => `${f.agent}[${f.stage}:${f.code}] ${f.error}`).join("；")}`);
    }
    lines.push("   请按 details.normalize 的 committedShards/backups/failures 核对后重试。");
    return deny("NORMALIZE_FAILED", lines.join("\n"), { totalCards: total, normalize: norm });
  }

  const lines = [`✅ 索引已重建，共收录 ${total} 张知识卡片。`];
  if(norm?.lockReleaseWarning)lines.push('归一化事务结果仍有效，但数据锁释放异常；详见details.normalize.lockReleaseWarning。');
  if (!normalize) {
    lines.push("数据归一化：未请求（默认只重建索引，不重写旧卡统计）。");
  } else if (!norm?.changed) {
    lines.push("数据归一化：无需改动（卡片文件已是纯内容形态）。");
  } else {
    lines.push(
      `数据归一化：迁移统计 ${norm.migratedStats} 条` +
        (norm.committedShards.length > 0 ? `；重写分片 ${norm.committedShards.join(", ")}` : "") +
        `；stats ${norm.statsCommitted ? "已提交" : "未提交"}` +
        (norm.backups.length > 0 ? `；备份 ${norm.backups.length} 份` : ""),
    );
  }
  return result(lines.join("\n"), { totalCards: total, normalize: norm });
}
