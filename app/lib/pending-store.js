// pending 队列自持层（v3.0.0 新增；v3.0.1 加固）
//
// 【为什么要有它】
// 原实现把两类完全不同的东西塞进同一个 `pendingKCs` 数组，且该数组寄居在
// hana-superpowers 的状态文件（旧布局 plugin-data/hana-superpowers/sessions/state.json）：
//   （a）待安装 KC：由 hana-superpowers 的 sp-workflow / sp-debug-archive 持续写入，
//         并被 superpowers-gate.js 读取 → 这是一条**活的跨插件契约**，不能单方面切断。
//   （b）待人工核验的知识卡：安全域卡片 / 校验失败 / 归档失败时挂起。
//         它此前**没有任何出口**（自动归档对安全卡永不发生；sp-workflow install-kc 对它是语义错配），
//         且 markKcAsPending 写失败时直接 return false、调用方不检查 → 静默丢失。
//
// 【本模块的做法】按 kind 分工，不切断任何活契约：
//   kind=install → v2 生产模式经 publicData 投影读取（不再直读）；夹具/旧布局读 SP 的 state.json（**只读**）
//   kind=review  → 写入本插件私有数据根（APP_DATA_DIR）下的 pending.json
//
// 【失败语义】所有写操作返回 {ok, error}，绝不静默吞掉；调用方必须检查。
// 读取时：文件不存在 = 正常空队列；**文件存在但解析失败或结构非法 = 显式错误（fail-closed）**。
// ⚠️ 注意：fail-closed 的**作用域**只能覆盖「本来就会被拦的动作」——
//    调用方（kc-enforce）必须加 isHighRisk 守卫，否则会把 read / kc-verify / 修复状态文件
//    所需的 write 一并锁死，而修复目标又在受保护路径内 → agent 侧无自救通道。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { HANA_HOME, APP_DATA_DIR, atomicWriteFile } from './jsonl-io.js';
import { hasAppRoot } from './io-root.js'; // 单一真源（B10）+ 共享原子写原语（F5a）

export const PLUGIN_ID = 'kc-system';
export const KINDS = ['install', 'review'];

const REVIEW_FILE = path.join(APP_DATA_DIR, 'pending.json');
// B9：队列「由有到无」的指纹（侧车文件）。记录上次读到/写入的条目数，
// 用于把「被删除」与「本来就没有」区分开（前者是异常，不能静默当空队列）。
const REVIEW_SIDECAR = REVIEW_FILE + '.seen';
function readSidecar() {
  try {
    const st=fs.lstatSync(REVIEW_SIDECAR);
    if(!st.isFile()||st.isSymbolicLink()||st.size>4096)throw new Error('sidecar size/type invalid');
    const value=JSON.parse(fs.readFileSync(REVIEW_SIDECAR, 'utf-8'));
    if(!value||!Number.isSafeInteger(value.count)||value.count<0)throw new Error('sidecar count invalid');
    return value;
  } catch (err) {
    if(err?.code==='ENOENT')return null;
    return {invalid:true,error:'pending.json.seen指纹不可读：'+String(err?.code||err?.message||err).slice(0,200)};
  }
}
function writeSidecar(count) {
  try {
    const old = readSidecar();
    if (old && old.count === count) return;
    fs.writeFileSync(REVIEW_SIDECAR, JSON.stringify({ count, at: new Date().toISOString() }), 'utf-8');
  } catch (err) {
    // 不静默：指纹写失败会削弱 F2/B9 检测（能写 pending.json 者本就能写/删它，非新增绕过面）
    console.warn(`[kc-pending] 指纹写入失败（F2/B9 检测可能失效）：${err && err.message}`);
  }
}
// Cross-App state is a schema-checked public projection, not another App's private file.
let installQueueView = { ok: true, items: [], fileExists: false };
export function setInstallQueueView(snapshot) {
  if (!snapshot || snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.data?.items) || snapshot.data?.ok === false) {
    installQueueView = { ok: false, items: [], fileExists: false, error: 'SP 待决状态不可用或schema不支持' }; return;
  }
  installQueueView = { ok: true, items: snapshot.data.items.map(x => ({...x})), fileExists: true };
}
const SUPERPOWERS_STATE = hasAppRoot() ? null : path.join(HANA_HOME, 'plugin-data', 'hana-superpowers', 'sessions', 'state.json');
// 生产模式（hasAppRoot）下为 null：跨应用经 publicData 投影读取，不直读 SP 私有目录。

/**
 * 卡名的规范形：**只统一分隔符为单连字符，不改 id 本体**。
 *
 * 历史上有 `kc--agent--note--id`（双连字符）与 `kc--agent-note--id` 两种合法写法。
 * 若登记侧保留原形、清除侧却按单连字符重建，就会出现「能进不能自动出」的滞留项
 * （条目留在队列里，门禁持续拦高风险操作，只能人工清）。因此登记与清除必须共用本函数。
 *
 * @returns {string|null} 无法识别时返回 null
 */
export function normalizeKcName(raw) {
  if (typeof raw !== 'string') return null;
  const m = raw.trim().match(/^kc--([A-Za-z0-9_]+)-+note-+([A-Za-z0-9_.\-]+)$/);
  if (!m) return null;
  return `kc--${m[1].toLowerCase()}-note--${m[2]}`;
}

/**
 * 卡名合法性。字符集与**解析侧**对齐（归档解析器允许 id 含下划线/点/连字符）。
 *
 * 【为何放宽】旧实现把 id 段限成 `[a-z0-9-]+`，而解析侧与 validateKcParams 的拒绝面更宽，
 * 于是一张「本来就没通过校验」的卡正需要进 review 队列时，反而因名字格式被拒 →
 * 既不入库也不进队列，静默丢失。宁可先收进来让人工看到，也不要无声丢掉。
 */
const KC_NAME_RE = /^kc--[A-Za-z0-9_]+-+note-+[A-Za-z0-9_.\-]+$/;

export function isValidKcName(name) {
  return typeof name === 'string' && KC_NAME_RE.test(name);
}

// ── kind=review：本插件自持 ──────────────────────────────

/**
 * @returns {{ok:boolean, items:Array, error?:string}}
 */
export function readReviewQueue() {
  const fingerprint=readSidecar();
  if(fingerprint?.invalid)return{ok:false,items:[],error:fingerprint.error};
  if (!fs.existsSync(REVIEW_FILE)) {
    // KC5 readers are pure: preserve fingerprints and keep missing-data diagnostics visible.
    const seen = readSidecar();
    if (seen && seen.count > 0) return {ok:false,items:[],error:`pending.json 丢失（上次非空：${seen.count} 条）；指纹未改，普通工具不受影响`};
    return { ok: true, items: [] };
  }
  let parsed;
  try {
    const stat=fs.lstatSync(REVIEW_FILE);
    if(stat.isSymbolicLink()||!stat.isFile())return {ok:false,items:[],error:'pending.json 非普通文件'};
    if(stat.size>2*1024*1024)return {ok:false,items:[],error:'pending.json size超过2MiB读取上限'};
    parsed = JSON.parse(fs.readFileSync(REVIEW_FILE, 'utf-8'));
  } catch (err) {
    return { ok: false, items: [], error: `pending.json 解析失败：${err.message}` };
  }
  // 【为何严格】旧实现用 `Array.isArray(parsed?.items) ? parsed.items : []`，
  // 于是「能解析但结构错」的文件（如 `{}`、items 不是数组）被当成**空队列** →
  // 写一个 `{}` 进 pending.json 就等于静默清空待核验队列，并解除 review 门禁。
  if (!parsed || !Array.isArray(parsed.items)) {
    return {
      ok: false,
      items: [],
      error: 'pending.json 结构非法（缺少 items 数组）——可能被外部修改或损坏',
    };
  }
  if (parsed.version !== undefined && parsed.version !== 1) {
    return { ok: false, items: [], error: `pending.json 版本不受支持：${parsed.version}` };
  }
  // v3.0.6：条目级 schema 校验——丢弃非法条目（缺 name / 名字格式非法）。
  // 旧实现只校到 items 数组层，`{"items":[{}]}` 可解析通过，且该条目无法被 confirm/reject 清除 →
  // 队列永久非空、门禁持续拦截，而修复手段（写 pending.json）本身又在受保护路径内 → agent 侧死锁。
  const items = [];
  let dropped = 0;
  for (const it of parsed.items) {
    // 归一化到规范形（与 clearReview 同源）：否则双连字符历史条目会「能进不能出」，
    // 变成不可清除的滞留项。
    const canon = it && typeof it === 'object' ? normalizeKcName(it.name) : null;
    if (canon) items.push({ ...it, name: canon });
    else dropped++;
  }
  if (dropped > 0) return {ok:false,items,error:`pending.json 含${dropped}项非法记录；未重写原文件`};
  if(items.length>5000)return{ok:false,items:items.slice(0,5000),error:'pending.json items超过5000读取上限'};
  // F2：由非空到空——文件被覆写成合法空队列（绕过 addReview / clearReview 的正常写入）。
  // 正常清空会经 clearReview 写 sidecar(count=0)，故此处只在「当前空 且 上次非空」时报。
  // 与 B9（文件丢失）对称：一次性上报后清指纹，避免形成无法自救的死锁。
  if (items.length === 0) {
    const seen = readSidecar();
    if (seen && seen.count > 0) {
      return {ok:false,items:[],error:`pending.json 由非空变为空（上次${seen.count}条）；指纹未改，普通工具不受影响`};
    }
  }
  return { ok: true, items };
}

/**
 * 登记一张待人工核验的卡片。重复登记同名卡视为成功（幂等），不重复追加。
 * 名字会被规范化为单连字符形（见 normalizeKcName）。
 * @returns {{ok:boolean, added:boolean, error?:string}}
 */
function mergeOrigins(prior, incoming) {
  const map = new Map();
  for (const raw of [...(Array.isArray(prior) ? prior : []), ...(Array.isArray(incoming) ? incoming : [])]) {
    if (!raw || typeof raw !== 'object') continue;
    const field = (value, max) => typeof value === 'string' ? value.slice(0, max) : null;
    const origin = { taskId: field(raw.taskId, 200), sessionPath: field(raw.sessionPath, 1000), snippet: field(raw.snippet, 200) };
    const key = JSON.stringify(origin);
    map.delete(key); map.set(key, origin);
  }
  return [...map.values()].slice(-5);
}

export function addReview({ name, cardId, agent, reason, source, detail, origins }) {
  const canon = normalizeKcName(name);
  if (!canon) {
    return { ok: false, added: false, error: `卡片名格式非法：${String(name)}` };
  }
  const cur = readReviewQueue();
  if (!cur.ok) {
    // 已有文件但损坏或结构非法：不覆盖，避免把可能存在的内容写没
    return { ok: false, added: false, error: cur.error };
  }
  const existing = cur.items.find((it) => it.name === canon);
  if (existing) {
    const upgrade = existing.reason === 'awaiting_archive' && reason && reason !== 'awaiting_archive';
    if (upgrade || (Array.isArray(origins) && origins.length)) {
      const prior = Array.isArray(existing.origins) ? existing.origins : [];
      const merged = mergeOrigins(prior, origins);
      if (!upgrade && JSON.stringify(prior) === JSON.stringify(merged)) return { ok: true, added: false };
      const next = cur.items.map((it) => it.name === canon ? { ...it, origins: merged, ...(upgrade ? { reason, detail: detail || it.detail, source: source || it.source } : {}) } : it);
      try { atomicWriteFile(REVIEW_FILE, JSON.stringify({ version: 1, items: next }, null, 2) + '\n'); writeSidecar(next.length); return { ok: true, added: false, merged: true }; }
      catch (err) { return { ok: false, added: false, error: `更新 pending.json 失败：${err.message}` }; }
    }
    return { ok: true, added: false };
  }
  const next = cur.items.concat([
    {
      name: canon,
      cardId: cardId || null,
      agent: agent || null,
      reason: reason || 'needs_review',
      detail: detail || null,
      source: source || 'unknown',
      addedAt: new Date().toISOString(),
      origins: mergeOrigins([], origins),
    },
  ]);
  try {
    atomicWriteFile(REVIEW_FILE, JSON.stringify({ version: 1, items: next }, null, 2) + '\n');
    writeSidecar(next.length);
    return { ok: true, added: true };
  } catch (err) {
    return { ok: false, added: false, error: `写入 pending.json 失败：${err.message}` };
  }
}

/**
 * 清除一张待核验卡（确认入库 / 显式驳回后调用）。
 * 入参会与登记时使用同一套规范化，保证「登记得进、也清得掉」。
 * @returns {{ok:boolean, removed:boolean, error?:string}}
 */
export function clearReview(name, options = {}) {
  const target = normalizeKcName(name) || name;
  const cur = readReviewQueue();
  if (!cur.ok) return { ok: false, removed: false, error: cur.error };
  const next = cur.items.filter((it) => it.name !== target || (options.reason !== undefined && it.reason !== options.reason));
  if (next.length === cur.items.length) {
    return { ok: true, removed: false };
  }
  try {
    atomicWriteFile(REVIEW_FILE, JSON.stringify({ version: 1, items: next }, null, 2) + '\n');
    writeSidecar(next.length);
    return { ok: true, removed: true };
  } catch (err) {
    return { ok: false, removed: false, error: `写入 pending.json 失败：${err.message}` };
  }
}

// ── kind=install：读 hana-superpowers 的活契约（只读） ────

/**
 * 读取 hana-superpowers 的待安装 KC 队列。
 *
 * 该校验强度与 superpowers-gate.js 对齐（**存在** checksum 则校验，不匹配即视为损坏）。
 * 「无 checksum 即接受」是刻意保留的兼容取舍——该文件有其它写入方，不能单方面要求它带 checksum。
 * 但**结构**仍严格校验：pendingKCs 存在且不是数组即视为损坏。
 *
 * 与旧实现的关键差别：**不再静默返回空**——文件存在但不可信时返回 ok:false，
 * 由调用方按 fail-closed（且限定在 isHighRisk 作用域内）处理。
 *
 * @returns {{ok:boolean, items:Array, error?:string, fileExists:boolean}}
 */
export function readInstallQueue() {
  if (hasAppRoot()) return installQueueView;
  if (!fs.existsSync(SUPERPOWERS_STATE)) {
    return { ok: true, items: [], fileExists: false };
  }
  let state;
  try {
    state = JSON.parse(fs.readFileSync(SUPERPOWERS_STATE, 'utf-8'));
  } catch (err) {
    return { ok: false, items: [], fileExists: true, error: `state.json 解析失败：${err.message}` };
  }
  if (!state || typeof state !== 'object') {
    return { ok: false, items: [], fileExists: true, error: 'state.json 顶层不是对象' };
  }
  if (state.checksum) {
    // 注意：本处「无 checksum 即接受」与 hana-superpowers 的 lib/state.js（缺摘要即拒，fail-closed）
    // **有意不对称** —— 我们只是别人文件的只读消费者，不能对别人的写入方提要求。
    // 两侧都是刻意的，不要当成不一致去「修平」。
    const { checksum, ...rest } = state;
    // 摘要口径是**跨插件契约**：hana-superpowers v2.3.0 起写「稳定口径（键排序）」，
    // 旧版与历史文件是「原键序」。两侧都必须接受两种——
    // 否则一侧升级口径就会把另一侧误判为「文件被外部修改」→ fail-closed 全锁。
    // （这个坑 2026-09-21 真实踩到：升级口径当场被封。）
    const legacy = crypto.createHash('md5').update(JSON.stringify(rest)).digest('hex');
    const ordered = {};
    for (const k of Object.keys(rest).sort()) ordered[k] = rest[k];
    const stable = crypto.createHash('md5').update(JSON.stringify(ordered)).digest('hex');
    if (checksum !== legacy && checksum !== stable) {
      return {
        ok: false,
        items: [],
        fileExists: true,
        error: 'state.json checksum 不匹配（文件被外部修改或损坏）',
      };
    }
  }
  if (state.pendingKCs !== undefined && !Array.isArray(state.pendingKCs)) {
    return {
      ok: false,
      items: [],
      fileExists: true,
      error: 'state.json 的 pendingKCs 不是数组（结构非法）',
    };
  }
  const items = Array.isArray(state.pendingKCs) ? state.pendingKCs : [];
  return { ok: true, items, fileExists: true };
}

// ── 汇总 ────────────────────────────────────────────────

/** Legacy diagnostic field only. No current write, delete or workflow decision uses it. */
export function readUserBypass() {
  const v = String(process.env.KC_USER_BYPASS || '').trim().toLowerCase();
  return { active: v === '1' || v === 'true' || v === 'yes' || v === 'on', source: 'env' };
}

/**
 * 列出全部待决项。任一侧读取失败都在返回值里显式暴露，不吞。
 * @returns {{ok:boolean, install:Array, review:Array, errors:string[], userBypass:boolean}}
 */
export function listPending() {
  const errors = [];
  const install = readInstallQueue();
  const review = readReviewQueue();
  if (!install.ok) errors.push('install: ' + install.error);
  if (!review.ok) errors.push('review: ' + review.error);
  return {
    ok: errors.length === 0,
    install: install.items,
    review: review.items,
    errors,
    userBypass: readUserBypass().active,
  };
}

export const paths = {
  review: REVIEW_FILE,
  superpowersState: SUPERPOWERS_STATE,
};
