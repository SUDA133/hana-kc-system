import { searchKnowledge } from "../lib/retrieval.js";

export const name = "check-kc";
export const description = "检索知识卡片（KC）摘要，返回与当前任务相关的 KC。v5 与 kc_query 共用同一检索/生命周期引擎；不再作为全局流程门禁。需要全文时用 `kc_query mode=detail`。";

export const parameters = {
  type: "object",
  properties: {
    keywords: {
      type: "string",
      description: "与当前任务相关的关键词，用逗号分隔。例如：'install_skill, 截断, 大文件' 或 '圆桌会议, 派发, 审查'",
    },
  },
  required: ["keywords"],
};

/** kc_check 是 kc_query 的摘要别名（默认 8 条、summary），共享同一排序与生命周期过滤。 */
export async function execute(input) {
  return searchKnowledge({
    keywords: input?.keywords,
    limit: 8,
    mode: "summary",
  });
}
