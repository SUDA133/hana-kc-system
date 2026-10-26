// proposal-parser.js — KC5 文本提案解析（KNOWLEDGE_STORE 成对闭合区块 → 候选文本）
//
// 边界（与 CONTEXT/design 一致）：
//  - 只解析，不写库。
//  - 一个 [KNOWLEDGE_STORE]...[/KNOWLEDGE_STORE] 区块 = 一条提案；畸形区块只产出诊断。
//  - 「索引：」行可在区块内任意位置，也兼容任务契约的「紧随闭合标记之后一行」形态。
//  - 无新知识明确声明 → 跳过（no_new_knowledge，不算畸形）。
//  - 上限：单块 8000 字符、总输入 65536 字符、最多 20 条提案；触发任一上限即 truncated=true，
//    截断必须可见（诊断 + 标志），不静默吞内容。
//  - 解析结果仍是「提议文本」，是否合法由 candidate-store.validateProposed 再判；
//    这里只保结构，不做卡片尺寸/关键词的最终裁决（避免两套规则漂移）。

import { isValidAgent, agentRejectionReason } from './jsonl-io.js';

export const SEDIMENT_BLOCK_OPEN = '[KNOWLEDGE_STORE]';
export const SEDIMENT_BLOCK_CLOSE = '[/KNOWLEDGE_STORE]';
export const MAX_BLOCK_CHARS = 8000;
export const MAX_TOTAL_CHARS = 65536;
export const MAX_PROPOSALS = 20;
export const MAX_DIAGNOSTICS = 40;
const MAX_SNIPPET = 200;

/** 需要调用方显式登记的畸形类型（无新知识/空区块不入列，避免诊断噪音） */
const ACTIONABLE_KINDS = new Set([
  'missing_index',
  'bad_index_line',
  'multiple_cards_unseparated',
  'incomplete_card',
  'unclosed_block',
]);

export function isActionableDiagnostic(kind) {
  return ACTIONABLE_KINDS.has(String(kind));
}

/** 兼容单/双连字符：kc--{agent}-note--{id} 与 kc--{agent}--note--{id} 都是历史合法写法 */
const INDEX_LINE_RE = /^索引[:：]\s*kc--([\w-]+?)-+note-+([\w-]+)\s*\|\s*(.*?)\s*\|\s*(.+)$/i;
/** 区块内显式声明的卡片 id（优先于索引行推断） */
const CARD_ID_LINE_RE = /^卡\s*id\s*[:：]\s*([\w-]+)\s*$/i;
/** 可选 related/相关 行（旧格式没有，解析后由 candidate-store 校验） */
const RELATED_LINE_RE = /^(?:related|相关)\s*[:：]\s*(.*)$/i;
const INDEX_PREFIX_RE = /^索引[:：]/;
/** 明确「无新知识」声明：正常略过，不算畸形 */
const NO_NEW_KNOWLEDGE_RE = /无\s*(?:新增|新)\s*知识|无新增知识|no\s+new\s+knowledge/i;
const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function snippet(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > MAX_SNIPPET ? s.slice(0, MAX_SNIPPET) : s;
}

function splitList(text) {
  return String(text || '')
    .split(/[,，、;；]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * 解析代理回复文本中的 KNOWLEDGE_STORE 区块。
 * @param {unknown} text
 * @returns {{proposals: object[], diagnostics: object[], truncated: boolean}}
 */
export function parseProposals(text) {
  const proposals = [];
  const diagnostics = [];
  let truncated = false;
  let diagnosticsFull = false;

  const pushDiag = (diag) => {
    if (diagnostics.length >= MAX_DIAGNOSTICS) {
      if (!diagnosticsFull) {
        diagnosticsFull = true;
        diagnostics.push({ kind: 'diagnostics_truncated', message: `诊断超过 ${MAX_DIAGNOSTICS} 条，后续只统计不记录` });
        truncated = true;
      }
      return;
    }
    diagnostics.push(diag);
  };

  if (typeof text !== 'string') {
    if (text !== undefined && text !== null) pushDiag({ kind: 'invalid_input', message: '解析输入必须是文本' });
    return { proposals, diagnostics, truncated };
  }
  if (!text) return { proposals, diagnostics, truncated };

  let scan = text;
  if (scan.length > MAX_TOTAL_CHARS) {
    scan = scan.slice(0, MAX_TOTAL_CHARS);
    truncated = true;
    pushDiag({
      kind: 'input_truncated',
      message: `输入超过 ${MAX_TOTAL_CHARS} 字符，只解析前缀；截断内容不进入候选`,
      limit: MAX_TOTAL_CHARS,
    });
  }

  let cursor = 0;
  let blockNo = 0;
  while (cursor < scan.length) {
    const openAt = scan.indexOf(SEDIMENT_BLOCK_OPEN, cursor);
    if (openAt < 0) break;
    const closeAt = scan.indexOf(SEDIMENT_BLOCK_CLOSE, openAt + SEDIMENT_BLOCK_OPEN.length);
    if (closeAt < 0) {
      blockNo++;
      pushDiag({
        kind: 'unclosed_block',
        block: blockNo,
        message: '区块缺少 [/KNOWLEDGE_STORE] 闭合标记，整块丢弃',
        snippet: snippet(scan.slice(openAt + SEDIMENT_BLOCK_OPEN.length, openAt + SEDIMENT_BLOCK_OPEN.length + 400)),
      });
      break;
    }
    const nestedAt = scan.indexOf(SEDIMENT_BLOCK_OPEN, openAt + SEDIMENT_BLOCK_OPEN.length);
    if (nestedAt >= 0 && nestedAt < closeAt) {
      blockNo++;
      pushDiag({
        kind: 'unclosed_block',
        block: blockNo,
        message: '上一个区块未闭合就出现新的开标记，按新开标记重新起块',
        snippet: snippet(scan.slice(openAt + SEDIMENT_BLOCK_OPEN.length, nestedAt)),
      });
      cursor = nestedAt;
      continue;
    }

    blockNo++;
    const body = scan.slice(openAt + SEDIMENT_BLOCK_OPEN.length, closeAt);
    const afterClose = closeAt + SEDIMENT_BLOCK_CLOSE.length;

    // 任务契约常见形态：索引行写在闭合标记的下一行。只认「同一行剩余」或「紧接着的下一行」。
    let outsideIndexLine = '';
    let nextCursor = afterClose;
    const sameLineEnd = scan.indexOf('\n', afterClose);
    const sameLine = scan.slice(afterClose, sameLineEnd < 0 ? scan.length : sameLineEnd).replace(/\r$/, '').trim();
    if (INDEX_PREFIX_RE.test(sameLine)) {
      outsideIndexLine = sameLine;
      nextCursor = sameLineEnd < 0 ? scan.length : sameLineEnd + 1;
    } else if (sameLine === '') {
      let lineStart = afterClose;
      if (scan.startsWith('\r\n', lineStart)) lineStart += 2;
      else if (scan[lineStart] === '\n') lineStart += 1;
      else lineStart = -1;
      if (lineStart >= 0) {
        const lineEnd = scan.indexOf('\n', lineStart);
        const nextLine = scan.slice(lineStart, lineEnd < 0 ? scan.length : lineEnd).replace(/\r$/, '').trim();
        if (INDEX_PREFIX_RE.test(nextLine)) {
          outsideIndexLine = nextLine;
          nextCursor = lineEnd < 0 ? scan.length : lineEnd + 1;
        }
      }
    }
    cursor = nextCursor;

    if (body.length > MAX_BLOCK_CHARS) {
      truncated = true;
      pushDiag({
        kind: 'oversized_block',
        block: blockNo,
        message: `单块正文超过 ${MAX_BLOCK_CHARS} 字符，整块丢弃而不截断正文`,
        snippet: snippet(body),
      });
      continue;
    }

    const lines = body.split(/\r?\n/);
    const indexLines = lines.filter((l) => INDEX_PREFIX_RE.test(l.trim()));
    if (outsideIndexLine && indexLines.length === 0) indexLines.push(outsideIndexLine);

    const idLine = lines.map((l) => l.trim()).find((l) => CARD_ID_LINE_RE.test(l));
    const relatedLine = lines.map((l) => l.trim()).find((l) => RELATED_LINE_RE.test(l));

    if (!body.trim() && !indexLines.length) {
      pushDiag({ kind: 'empty_block', block: blockNo, message: 'KNOWLEDGE_STORE 区块为空，已跳过' });
      continue;
    }
    if (!indexLines.length && NO_NEW_KNOWLEDGE_RE.test(body)) {
      pushDiag({ kind: 'no_new_knowledge', block: blockNo, message: '区块声明无新知识，已跳过' });
      continue;
    }
    if (!indexLines.length) {
      pushDiag({
        kind: 'missing_index',
        block: blockNo,
        message: '区块缺少「索引：」行，无法生成候选',
        snippet: snippet(body),
      });
      continue;
    }
    if (indexLines.length > 1) {
      pushDiag({
        kind: 'multiple_cards_unseparated',
        block: blockNo,
        message: `区块含 ${indexLines.length} 个索引行且无分隔，拒绝合并为一条候选`,
        snippet: snippet(body),
      });
      continue;
    }

    const idxMatch = indexLines[0].match(INDEX_LINE_RE);
    if (!idxMatch) {
      pushDiag({
        kind: 'bad_index_line',
        block: blockNo,
        message: '索引行格式不匹配（应为 索引：kc--agent-note--id | 关键词 | 摘要）',
        snippet: snippet(indexLines[0]),
      });
      continue;
    }

    const agent = idxMatch[1].toLowerCase();
    const idFromIndex = idxMatch[2].toLowerCase();
    const keywords = splitList(idxMatch[3]);
    const summary = idxMatch[4].trim();
    const id = idLine ? idLine.match(CARD_ID_LINE_RE)[1].trim().toLowerCase() : idFromIndex;
    const related = relatedLine ? splitList(relatedLine.match(RELATED_LINE_RE)[1]) : [];

    const content = lines
      .filter((l) => {
        const t = l.trim();
        if (!t) return true; // 空行保留，稍后统一收边
        if (INDEX_PREFIX_RE.test(t)) return false;
        if (CARD_ID_LINE_RE.test(t)) return false;
        if (RELATED_LINE_RE.test(t)) return false;
        return true;
      })
      .map((l) => l.replace(/\s+$/, ''))
      .join('\n')
      .replace(/^\n+/, '')
      .replace(/\n+$/, '');

    if (!isValidAgent(agent)) {
      pushDiag({
        kind: 'incomplete_card',
        block: blockNo,
        message: `索引行 agent 不是合法的受限 kebab-case 名称（${agent ? agentRejectionReason(agent) : '空'}）：${agent || '(空)'}`,
        snippet: snippet(indexLines[0]),
      });
      continue;
    }
    if (!ID_RE.test(id)) {
      pushDiag({
        kind: 'incomplete_card',
        block: blockNo,
        message: '卡片 id 不是 kebab-case，无法生成候选',
        snippet: snippet(indexLines[0]),
      });
      continue;
    }
    if (!keywords.length) {
      pushDiag({ kind: 'incomplete_card', block: blockNo, message: '索引行关键词为空', snippet: snippet(indexLines[0]) });
      continue;
    }
    if (!summary) {
      pushDiag({ kind: 'incomplete_card', block: blockNo, message: '索引行摘要为空', snippet: snippet(indexLines[0]) });
      continue;
    }
    if (!content) {
      pushDiag({ kind: 'incomplete_card', block: blockNo, message: '区块没有正文内容', snippet: snippet(indexLines[0]) });
      continue;
    }

    if (proposals.length >= MAX_PROPOSALS) {
      truncated = true;
      pushDiag({
        kind: 'too_many_blocks',
        block: blockNo,
        message: `提案超过 ${MAX_PROPOSALS} 条上限，其余区块不再解析`,
        limit: MAX_PROPOSALS,
      });
      break;
    }

    proposals.push({ agent, id, keywords, summary, content, related });
  }

  return { proposals, diagnostics, truncated };
}
