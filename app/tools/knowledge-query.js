import {
  enqueueDataWrite,
  bumpStats,
  flushStats,
  statsAreDirty,
  loadStats,
} from "../lib/jsonl-io.js";
import { withDataLock } from "../lib/data-lock.js";
import {
  searchKnowledge,
  normalizeLimit,
  exactIdentity,
  parseKeywordInput,
  scoreKnowledgeCard,
} from "../lib/retrieval.js";

export const name = "knowledge-query";
export const description = "在全量知识卡片库中检索与关键词匹配的卡片，返回相关度排序的结果。v5 与 kc_check 共用同一引擎：关键词/摘要命中、生命周期过滤与 scope 提示一致；legacy score 不再当相关度。支持 mode=summary（默认）和 mode=detail。";

export const parameters = {
  type: "object",
  properties: {
    id: { type: "string", description: "精确读取：agent::id、kc--agent-note--id，或 bare id + agent。不转为模糊查询。" },
    keywords: {
      type: "string",
      description: "检索关键词，逗号分隔。例如：'PowerShell, $null, 变量展开'"
    },
    agent: {
      type: "string",
      pattern: "^[a-z0-9]+(-[a-z0-9]+)*$",
      maxLength: 64,
      description: "按Agent过滤（可选，默认 all）；取值为库内实际存在的分片名"
    },
    limit: {
      type: "number",
      description: "最多返回条数（默认 8；有效范围 1–50。limit=0 表示「尽量取全部」，仍以 50 张封顶）"
    },
    mode: {
      type: "string",
      enum: ["summary", "detail"],
      description: "返回模式：summary（仅摘要，默认），detail（含完整content）"
    },
    includeInactive: {
      type: "boolean",
      description: "审计用：true 时包含 deprecated/superseded/archived/已过期卡片（默认 false）"
    },
    project: { type: "string", description: "可选 project 过滤；scope.project 明确不符时排除，缺失时标 requiresReview" },
    version: { type: "string", description: "可选版本提示；versionRange 只做文本提示，不解析 semver" }
  },
  anyOf: [{ required: ["keywords"] }, { required: ["id"] }]
};

// 旧导出保留为适配层；实际检索统一走 lib/retrieval.js。
export { normalizeLimit, exactIdentity };

/** 旧签名适配：返回新引擎的相关度（legacy score 不计入）。 */
export function computeScore(card, kwList) {
  const parsed = parseKeywordInput(Array.isArray(kwList) ? kwList.map(String) : String(kwList));
  if (!parsed.ok) return 0;
  return scoreKnowledgeCard(card, parsed.terms).score;
}

/** 旧排序适配：优先新相关度，其次 legacy 字段，最后复合身份。 */
export function compareCards(a, b) {
  const ar = typeof a?.relevance === "number" ? a.relevance : (typeof a?.score === "number" ? a.score : 0);
  const br = typeof b?.relevance === "number" ? b.relevance : (typeof b?.score === "number" ? b.score : 0);
  if (ar !== br) return br - ar;
  const ak = a?.identity || a?.card?.identity || `${a?.card?.agent}::${a?.card?.id}`;
  const bk = b?.identity || b?.card?.identity || `${b?.card?.agent}::${b?.card?.id}`;
  return ak < bk ? -1 : ak > bk ? 1 : 0;
}

/** 旧精确读取适配：返回文本（内部仍走统一引擎，含生命周期警告）。 */
export async function readExact(input = {}) {
  const r = await searchKnowledge({ id: input.id, agent: input.agent, mode: input.mode });
  return r.content.map((p) => p.text).join("\n");
}

/** 旧 heat 统计是独立旁路：只 bump top 结果，不改正文/排序；短队列+data-lock 内读改写。 */
async function recordHeat(details) {
  const cards = Array.isArray(details?.cards) ? details.cards : [];
  try {
    return await enqueueDataWrite(() => withDataLock(() => {
      const stats = loadStats();
      let updated = 0;
      let error = stats.invalid ? (stats.error || 'stats unavailable') : null;
      const seen = new Set();
      const day = new Date().toISOString().slice(0, 10);
      for (const card of cards) {
        if (!card || typeof card.agent !== 'string' || typeof card.id !== 'string') continue;
        const key = `${card.agent}::${card.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (bumpStats(card.agent, card.id, day)) updated++;
      }
      let flushed = false;
      try { if (statsAreDirty()) flushed = flushStats(); }
      catch (e) { error = e.message; }
      return { updated, flushed, ...(error ? { error } : {}) };
    }));
  } catch (e) {
    return { updated: 0, flushed: false, error: e.message };
  }
}

async function attachHeat(result) {
  if (result && result.details) result.details.stats = await recordHeat(result.details);
  return result;
}

export async function execute(input) {
  if (input?.id !== undefined) {
    return attachHeat(await searchKnowledge({
      id: input.id,
      agent: input.agent,
      mode: input.mode,
    }));
  }
  return attachHeat(await searchKnowledge({
    keywords: input?.keywords,
    agent: input?.agent,
    limit: input?.limit,
    mode: input?.mode,
    includeInactive: input?.includeInactive,
    project: input?.project,
    version: input?.version,
  }));
}
