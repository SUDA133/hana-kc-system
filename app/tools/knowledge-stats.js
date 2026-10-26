// knowledge-stats — 知识卡片检索热度统计（只读）
// v1.4.0: 新增。检索统计从卡片内容中剥离后（queryCount/lastQueried 不再写进 *.notes.jsonl），
//         热度信息改由此工具按需读取。它不修改任何文件，也不影响检索结果的字节稳定性。
// v4.0.1: 尾行「数据目录」改为动态解析实际路径（resolveDataDir），不再硬写旧布局字面量。

import fs from "node:fs";
import {
  isValidAgent,
  agentRejectionReason,
  STATS_FILE,
  loadIndex,
  loadStats,
  resolveDataDir,
} from "../lib/jsonl-io.js";

export const name = "knowledge-stats";
export const description =
  "读取知识卡片的检索热度统计（queryCount / lastQueried）。只读，不修改任何文件。数据来自 data/stats.json；该文件由 knowledge-query 在检索时按需更新。可用于人工判断哪些卡片长期无人检索（休眠候选）。";

export const parameters = {
  type: "object",
  properties: {
    agent: {
      type: "string",
      description: "只统计某归属 Agent 的卡片（可选，默认 all）；取值为库内实际出现的分片名",
    },
    limit: {
      type: "number",
      description: "返回条数（默认 20，范围 1–100；按 queryCount 升序，便于优先看到休眠卡）",
    },
    order: {
      type: "string",
      enum: ["coldest", "hottest"],
      description: "排序方向：coldest（默认，检索次数少→多）/ hottest（多→少）",
    },
    includeNever: {
      type: "boolean",
      description: "是否包含从未被检索过的卡片（默认 true）",
    },
  },
  required: [],
};

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export async function execute(input, toolCtx) {
  const agentFilter = input?.agent || "all";
  if (agentFilter !== "all" && !isValidAgent(agentFilter)) {
    return `错误：agent 非法（${agentRejectionReason(agentFilter)}）。`;
  }
  const rawLimit = input?.limit;
  let limit = DEFAULT_LIMIT;
  if (rawLimit !== undefined && rawLimit !== null && rawLimit !== "") {
    const n = typeof rawLimit === "number" ? rawLimit : Number(rawLimit);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
      return "错误：limit 必须是 ≥ 1 的整数。";
    }
    limit = Math.min(n, MAX_LIMIT);
  }
  const order = input?.order === "hottest" ? "hottest" : "coldest";
  const includeNever = input?.includeNever !== false;

  if (!fs.existsSync(STATS_FILE)) {
    return `尚无检索统计文件（data/stats.json）。说明本库自统计剥离以来还没有被检索过——所有现行卡片都处于「零检索」状态。`;
  }

  const index = loadIndex();
  // 【为何要分开报】旧实现用 `index?.allCards || {}`，于是「索引缺失/损坏」会一路走到
  // rows.length===0，再被读成「没有符合条件的卡片」——把「索引坏了」误报成「筛选后无数据」。
  if (!index || !index.allCards) {
    return "错误：检索索引不可用（index.json 缺失或损坏）。请先调用 knowledge-reindex 重建索引。";
  }
  const allCards = index.allCards;
  const stats = loadStats();
  // Task3-1：结构非法/损坏 → 只读工具**显式报告坏结构**，不静默当空库（否则把「统计坏了」误报成「全部零检索」）。
  if (stats.invalid) {
    return `错误：统计文件结构非法或已损坏（${stats.error}）。原始文件未改动；检索仍可用，仅热度不可读。请人工核查 data/stats.json（可修复其结构，或删除后由检索重建）。`;
  }
  // 索引键为复合键 agent::id；stats.json 同样按该键存放
  const known = new Map(Object.entries(stats.cards || {}));

  const rows = [];
  for (const [key, meta] of Object.entries(allCards)) {
    if (agentFilter !== "all" && meta.agent !== agentFilter) continue;
    const hit = known.get(key);
    if (!hit && !includeNever) continue;
    const i = key.indexOf("::");
    const idPart = i >= 0 ? key.slice(i + 2) : key;
    rows.push({
      id: idPart,
      agent: meta.agent,
      queryCount: hit ? hit.queryCount || 0 : 0,
      lastQueried: hit ? hit.lastQueried || "" : "",
      summary: meta.summary || "",
    });
  }
  if (rows.length === 0) {
    return `没有符合条件的卡片（agent=${agentFilter}，includeNever=${includeNever}）。`;
  }

  rows.sort((a, b) => {
    const d = order === "hottest" ? b.queryCount - a.queryCount : a.queryCount - b.queryCount;
    if (d !== 0) return d;
    const au = a.lastQueried || "";
    const bu = b.lastQueried || "";
    if (au !== bu) return au < bu ? -1 : 1;
    return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
  });

  const top = rows.slice(0, limit);
  const totalQueries = rows.reduce((acc, r) => acc + r.queryCount, 0);
  const neverQueried = rows.filter((r) => r.queryCount === 0).length;

  const lines = [
    `检索热度统计（只读）｜统计文件：data/stats.json`,
    `符合条件卡片 ${rows.length} 张，其中从未被检索 ${neverQueried} 张；累计检索 ${totalQueries} 次。`,
    "",
  ];
  top.forEach((r, i) => {
    lines.push(
      `${i + 1}. **${r.id}** (归属: ${r.agent}, 检索 ${r.queryCount} 次, 最近: ${r.lastQueried || "从未"})`
    );
  });
  if (rows.length > limit) {
    lines.push(`（还有 ${rows.length - limit} 张未列出，可用 limit 调整）`);
  }
  lines.push("", `数据目录：${resolveDataDir()}（由宿主 sdk.dataDir 分配）`);
  return lines.join("\n");
}
