// kc-system 共享 IO 层（原 knowledge-nexus 的 IO 层）
// （本节 since v1.4.0，缓存友好版）
//   - 生产数据目录固定采用宿主 sdk.dataDir；KC_DATA_DIR 仅供显式旧测试夹具隔离。
//          默认目录：v2 应用为私有数据根（sdk.dataDir）下的 data/；
//          旧插件时代为 HANA_HOME/plugin-data/kc-system/data（夹具模式沿用后者）
//   - 【新】卡片数据与检索统计分离：queryCount / lastQueried 不再写进 *.notes.jsonl，
//          改存 data/stats.json。卡片文件因此成为「纯内容」，检索不再修改被检索的数据。
//   - 【新】索引字节稳定性：index.json 顶层不再含 lastUpdated；仅当卡片内容真正变化时才更新
//          dataUpdatedAt 与 contentHash。数据不变 → 重复 rebuild 产出逐字节相同的文件。
//   - 【新】归一化写入：写回时剥离统计字段，保证「读取 → 写回」不引入字段漂移。
//   - 【新】索引带 contentHash，便于下游判断「库是否真的变了」而无需依赖时间戳。
// v1.2.0 保留：
//   - writeAllLines / rebuildIndex 原子写（同目录 tmp + fsync + rename）
//   - rebuildIndexSerialized()：索引重建走全局串行队列，避免跨 agent 交错覆盖
//   - realpath 判定 fail-closed（不回退为字面前缀比较）
//   - enqueueWrite 显式 prev.catch(...).then(fn)，避免上游失败时把错误对象喂给 writeFn
// 设计要点：
//   - 路径只由「通过 isValidAgent 校验的 agent 名」+ 常量目录拼装；任何含分隔符、
//     点段、绝对路径前缀的名字在校验层就被拒绝，用户输入永不直接进入 path.join
//   - 队列语义：writeFn 回调内应完成完整的「读-改-写」，否则读快照会落在临界区之外

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { dataRoot, hasAppRoot } from './io-root.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ID = "kc-system";
export const PLUGIN_ROOT = path.resolve(__dirname, "..");

/**
 * 插件持久目录：`HANA_HOME/plugin-data/<pluginId>`。
 *
 * 【为什么不能用 PLUGIN_ROOT/data】宿主安装/更新插件时会对目标插件目录执行整树删除
 * （`bundle/index.js:92736` 的 `gH()`：`rot()` 备份 → `rmSync(h,{recursive,force})` → `renameSync`），
 * 备份仅保留最近 3 份。因此卡库放在插件树内 = 每次更新必丢。
 * 官方 SDK 亦明确：`ctx.dataDir` 与打包的 `assets/` 才是插件自有存储。
 */
export const APP_DATA_DIR = dataRoot(PLUGIN_ID);
// HANA_HOME is an old-suite fixture only, never an application production path.
export const HANA_HOME = process.env.HANA_HOME || '';
export const DEFAULT_DATA_DIR = path.join(APP_DATA_DIR, 'data');

/** 数据目录解析：KC_DATA_DIR 环境变量覆盖优先，其次插件持久目录。返回绝对路径（不做存在性要求，便于首写创建） */
export function resolveDataDir() {
  const override = hasAppRoot() ? null : process.env.KC_DATA_DIR;
  if (typeof override === "string" && override.trim()) {
    return path.resolve(override.trim());
  }
  return DEFAULT_DATA_DIR;
}

export const DATA_DIR = resolveDataDir();
export const INDEX_FILE = path.join(resolveDataDir(), "index.json");
export const STATS_FILE = path.join(resolveDataDir(), "stats.json");
export const DELETED_DIR = path.join(resolveDataDir(), "deleted");
/** 覆盖写前的恢复点目录（APP_DATA_DIR/backups，与正式分片分离，默认不自动清理） */
export const BACKUP_DIR = path.join(APP_DATA_DIR, 'backups');
/** 单个分片有界读取上限：超过即拒读，避免把整库拖进内存 */
export const MAX_SHARD_BYTES = 16 * 1024 * 1024;

// ── Agent 身份：形状校验 + 动态分片发现 ────────────────────
// 公开副本不再内置任何团队名单。agent 是「受限 kebab-case 名称」，其合法性由形状规则决定，
// 而不是由一份枚举决定；库里实际有哪些分片，由数据目录本身回答（discoverShards）。
// 这样新增一个从未出现过的合法 agent 既能写入，也能在写完后被跨分片读取看见。

/** 分片后缀：dataDir 下唯一的正式卡真源形态 */
export const SHARD_SUFFIX = '.notes.jsonl';
/** agent 名长度上限（同时约束分片文件名长度） */
export const MAX_AGENT_LENGTH = 64;
/** 单次发现允许扫描的分片文件数上限（有界扫描，防超大目录） */
export const MAX_SHARD_FILES = 256;
/**
 * 通用默认 agent：仅在库为空（尚无任何分片）时提供两个中性落点，
 * 让首次写入有地方可去。它们不是白名单，不代表任何团队或用户。
 */
export const DEFAULT_AGENTS = Object.freeze(['hanako', 'cross']);
/** 保留名：`all` 在筛选语义里表示「不筛选」，不能作为物理分片身份 */
export const RESERVED_AGENT_NAMES = Object.freeze(['all']);

/** 检索统计字段：不进 *.notes.jsonl，只进 stats.json */
export const STATS_FIELDS = ["queryCount", "lastQueried"];

const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** 受限 kebab-case：小写字母/数字分段，单连字符分隔；不含点、斜杠、反斜杠、冒号、空格 */
const AGENT_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Windows 保留设备名：即便形状合法也不能作为文件主名（CON / NUL / COM1 …） */
const WINDOWS_DEVICE_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

/** 卡片内容的规范化字段顺序（保证同一内容序列化结果稳定） */
const CARD_FIELD_ORDER = [
  "id",
  "agent",
  "source",
  "keywords",
  "score",
  "summary",
  "content",
  "created",
  "lastUpdated",
  "related",
];

/**
 * agent 名合法性（纯形状判断，与库内容无关）。
 * 拒绝：非字符串 / 空 / 超长 / 保留名 all / Windows 设备名 /
 *      任何含 `.`、`/`、`\\`、`:`、空白、大写或点段的写法（绝对路径与父目录穿越因此进不来）。
 */
export function isValidAgent(agent) {
  if (typeof agent !== 'string') return false;
  if (agent.length === 0 || agent.length > MAX_AGENT_LENGTH) return false;
  if (RESERVED_AGENT_NAMES.includes(agent)) return false;
  if (WINDOWS_DEVICE_RE.test(agent)) return false;
  return AGENT_RE.test(agent);
}

/** 拒绝原因（供错误信息与诊断使用，不参与放行判断） */
export function agentRejectionReason(agent) {
  if (typeof agent !== 'string') return '不是字符串';
  if (!agent) return '空名称';
  if (agent.length > MAX_AGENT_LENGTH) return `超过 ${MAX_AGENT_LENGTH} 字符`;
  if (RESERVED_AGENT_NAMES.includes(agent)) return `保留名 ${agent}`;
  if (WINDOWS_DEVICE_RE.test(agent)) return 'Windows 保留设备名';
  if (!AGENT_RE.test(agent)) return '不是受限 kebab-case（小写字母/数字，单连字符分段）';
  return '未知原因';
}

/**
 * 发现数据目录中的正式分片：只认目录内**正规非符号链接**的 `*.notes.jsonl`，
 * 文件名主名必须通过 isValidAgent。不递归、不跟随链接、有界扫描。
 * 没有任何合法分片（包括目录尚未创建）= 全新安装，此时才给出通用默认 agent；
 * 库中已有分片时，返回的列表完全由实际文件决定。
 *
 * ignored 每项带 code，供调用方判断能否继续：
 *  - `invalid-name`：文件名主名不是合法 agent。它不可能对应一个可被寻址的合法身份，只做告知。
 *  - `symlink` / `not-a-file` / `unreadable`：这条目里可能躺着真实卡片而本函数没读到。
 *     任何「按身份定位」或「报告全量」的调用方都必须当成不安全（见 unsafeIgnoredEntries）。
 * @returns {{ok:true,dir:string,agents:string[],ignored:{name:string,code:string,reason:string}[],truncated:boolean}
 *          |{ok:false,dir:string,agents:string[],ignored:any[],error:string,truncated:boolean}}
 */
export function discoverShards() {
  const dir = resolveDataDir();
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      return { ok: true, dir, agents: [...DEFAULT_AGENTS].sort(), ignored: [], truncated: false };
    }
    // 目录不可读绝不伪装成空库：交给调用方按「不完整」上报
    return { ok: false, dir, agents: [], ignored: [], truncated: false, error: `数据目录不可读（${e?.code || e?.message || e}）` };
  }
  const found = new Set();
  const ignored = [];
  let truncated = false;
  let scanned = 0;
  for (const name of names) {
    if (typeof name !== 'string' || !name.endsWith(SHARD_SUFFIX)) continue;
    if (scanned >= MAX_SHARD_FILES) { truncated = true; break; }
    scanned++;
    const stem = name.slice(0, -SHARD_SUFFIX.length);
    if (!isValidAgent(stem)) {
      ignored.push({ name, code: 'invalid-name', reason: agentRejectionReason(stem) });
      continue;
    }
    let stat;
    try {
      stat = fs.lstatSync(path.join(dir, name));
    } catch (e) {
      ignored.push({ name, code: 'unreadable', reason: `条目不可读（${e?.code || e?.message || e}）` });
      continue;
    }
    if (stat.isSymbolicLink()) { ignored.push({ name, code: 'symlink', reason: '符号链接分片' }); continue; }
    if (!stat.isFile()) { ignored.push({ name, code: 'not-a-file', reason: '不是普通文件' }); continue; }
    found.add(stem);
  }
  // 只有「目录里没有任何合法分片」时才给出通用默认落点。
  // 一旦库有了自己的分片，列表就完全由实际数据决定，不再叠上两个默认名。
  const agents = found.size === 0 ? new Set(DEFAULT_AGENTS) : found;
  return { ok: true, dir, agents: [...agents].sort(), ignored, truncated };
}

/** 会隐藏真实卡片的 ignored 分类：调用方必须当成「本库不完整」处理 */
export const UNSAFE_IGNORED_CODES = Object.freeze(['symlink', 'not-a-file', 'unreadable']);

/** 从发现结果中挑出「可能藏着未读卡片」的条目 */
export function unsafeIgnoredEntries(discovery) {
  const list = Array.isArray(discovery?.ignored) ? discovery.ignored : [];
  return list.filter((x) => x && UNSAFE_IGNORED_CODES.includes(x.code));
}

/**
 * 发现失败即抛错（写路径与索引重建需要「读不到就停」而不是静默空库）。
 * 扫描被截断也抛错：分片数超过上限时，已看到的那部分是**部分库**，
 * 任何把它当完整库的行为（写索引、迁移、删除定位）都会把未扫描数据误报为不存在。
 */
export function listShardAgents() {
  const found = discoverShards();
  if (!found.ok) {
    const err = new Error(found.error);
    err.code = 'DATA_DIR_UNREADABLE';
    throw err;
  }
  if (found.truncated) {
    const err = new Error(
      `分片目录条目超过扫描上限（${MAX_SHARD_FILES}），无法确认全部分片；已中止以免把部分库当作完整库`,
    );
    err.code = 'SHARD_DISCOVERY_TRUNCATED';
    throw err;
  }
  return found.agents;
}

export function validateId(id) {
  return typeof id === "string" && ID_RE.test(id);
}

/** 只接受形状合法的 agent，返回数据目录内的 jsonl 绝对路径；非法 agent 抛错 */
export function getJsonlPath(agent) {
  if (!isValidAgent(agent)) {
    throw new Error(`非法的 agent 名：${String(agent)}（${agentRejectionReason(agent)}）`);
  }
  const file = path.join(resolveDataDir(), `${agent}${SHARD_SUFFIX}`);
  // 纵深防御：形状校验已排除分隔符，这里再断言一次文件名未被重解释。
  if (path.basename(file) !== `${agent}${SHARD_SUFFIX}`) {
    throw new Error(`非法的 agent 名：${String(agent)}`);
  }
  return file;
}

/**
 * 归一化卡片对象为「纯内容」形态：固定字段顺序，剥离统计字段。
 * 目的：让同内容卡片在任何写入路径下产生逐字节相同的 JSON 行。
 */
export function normalizeCard(card) {
  const out = {};
  for (const key of CARD_FIELD_ORDER) {
    if (card[key] === undefined) continue;
    out[key] = card[key];
  }
  // 保留未知的扩展字段（排序后附加），避免静默丢数据
  const extraKeys = Object.keys(card)
    .filter((k) => !CARD_FIELD_ORDER.includes(k) && !STATS_FIELDS.includes(k))
    .sort();
  for (const key of extraKeys) {
    out[key] = card[key];
  }
  return out;
}

/** 稳定序列化：键序确定的 JSON（用于哈希与落盘比对） */
export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

export function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf-8").digest("hex");
}

/**
 * 生成原子写的临时文件名：同目录、含 pid + 时间 + 随机分量。
 * 随机分量避免「同进程同毫秒多次调用」撞车（与 pending-store 的副本同口径）。
 */
export function makeTmpPath(filePath) {
  return `${filePath}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * 原子写：同目录临时文件写入 + rename 覆盖。
 * 同卷 rename 在 Windows/POSIX 均为原子替换，避免 truncate+write 中途崩溃导致整文件损坏。
 *
 * 沙箱感知（真机事故 2026-10-11）：Permission Model 下 fsync API 被宿主禁用
 *（报 "fsync API is disabled when Permission Model is enabled."）。此时降级为
 * **rename-only 原子写**（不 fsync，仅提示一次）；其它 fsync 错误（如 EIO）照旧抛错，不掩盖真故障。
 * @param {{fsync?: boolean}} [opts] fsync=false 用于高频、可重建的附属文件（如 stats.json）
 */
let _fsyncDisabledWarned = false;
function isFsyncCapabilityDisabled(err) {
  const m = String((err && (err.message || err)) || '').toLowerCase();
  return m.includes('fsync') && (m.includes('disabled') || m.includes('not permitted') || m.includes('eperm'));
}
export function atomicWriteFile(filePath, content, opts = {}) {
  const doFsync = opts.fsync !== false;
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmp = makeTmpPath(filePath);
  let fd;
  try {
    fd = fs.openSync(tmp, "w");
    fs.writeFileSync(fd, content, "utf-8");
    if (doFsync) {
      try {
        fs.fsyncSync(fd);
      } catch (e) {
        if (isFsyncCapabilityDisabled(e)) {
          if (!_fsyncDisabledWarned) {
            _fsyncDisabledWarned = true;
            console.warn('[kc-system] fsync 在此运行环境被禁用（Permission Model）——已降级为 rename-only 原子写（数据写仍为原子替换，仅少一次落盘确认）。此提示只出现一次。');
          }
        } else {
          throw e;
        }
      }
    }
    fs.closeSync(fd);
    fd = undefined;
    // Windows sharing violations can briefly outlive an otherwise complete read.
    // Retry only the same atomic replacement; never unlink the target or relax ACLs.
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(tmp, filePath); break; }
      catch (e) {
        if (process.platform !== 'win32' || !['EPERM','EACCES','EBUSY'].includes(e?.code) || attempt >= 5) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (attempt + 1));
      }
    }
  } catch (err) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

/**
 * 覆盖既有正式分片前，把原文独占写入 APP_DATA_DIR/backups 并逐字节读回校验。
 * - `wx` 保证同名恢复点不被覆盖；默认永不自动清理。
 * - 备份失败（含 fsync 非能力禁用错误）→ 抛错，调用方必须拒绝改动分片。
 * - 分片不存在 → 返回 null（纯新建无需恢复点）。
 * @returns {{path:string,bytes:number,digest:string}|null}
 */
let _backupFsyncWarned = false;
export function backupShardExclusive(filePath, opts = {}) {
  if (!fs.existsSync(filePath)) return null;
  const st = fs.lstatSync(filePath);
  if (st.isSymbolicLink()) {
    const err = new Error(`拒绝备份符号链接分片：${filePath}`);
    err.code = 'BACKUP_REFUSED';
    throw err;
  }
  if (!st.isFile()) {
    const err = new Error(`备份目标不是普通文件：${filePath}`);
    err.code = 'BACKUP_REFUSED';
    throw err;
  }
  const buf = fs.readFileSync(filePath);
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const base = path.basename(filePath).replace(/\.notes\.jsonl$/i, '') || 'shard';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = crypto.randomBytes(4).toString('hex');
  const target = path.join(BACKUP_DIR, `${base}.${stamp}.${rand}.bak`);
  let fd;
  let created = false;
  try {
    fd = fs.openSync(target, 'wx');
    created = true;
    fs.writeFileSync(fd, buf);
    try {
      fs.fsyncSync(fd);
    } catch (e) {
      if (isFsyncCapabilityDisabled(e)) {
        if (!_backupFsyncWarned) {
          _backupFsyncWarned = true;
          console.warn('[kc-system] fsync 在此运行环境被禁用（Permission Model）——分片备份已降级为不 fsync；读回逐字节校验仍在。此提示只出现一次。');
        }
      } else {
        throw e;
      }
    }
    fs.closeSync(fd);
    fd = undefined;
    const readBack = fs.readFileSync(target);
    if (Buffer.compare(readBack, buf) !== 0) {
      const err = new Error(`备份读回不一致（${buf.length} 字节）：${target}`);
      err.code = 'BACKUP_VERIFY_FAILED';
      throw err;
    }
  } catch (err) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    if (created) { try { if (fs.existsSync(target)) fs.unlinkSync(target); } catch {} }
    if (!err.code) err.code = 'BACKUP_FAILED';
    throw err;
  }
  return { path: target, bytes: buf.length, digest: sha256(buf), reason: typeof opts.reason === 'string' ? opts.reason : '' };
}

/**
 * 路径安全断言：目标必须落在数据目录内（realpath 包含性判断，fail-closed）。
 * 对尚不存在的路径，向上寻找最近的已存在祖先做 realpath 判断；
 * 基准目录不存在、realpath 失败、目标为符号链接，一律抛错。
 */
export function assertInsideDataDir(targetPath) {
  const base = path.resolve(resolveDataDir());
  // base 完全由 resolveDataDir() 推导（用户输入不进路径），全新安装时它尚不存在。
  // 此处主动创建，避免「首次运行必失败」；创建后再走 realpath 包含性判断，安全性不变。
  if (!fs.existsSync(base)) {
    fs.mkdirSync(base, { recursive: true });
  }
  const realBase = fs.realpathSync(base);

  const target = path.resolve(targetPath);
  if (!path.isAbsolute(target)) {
    throw new Error(`路径不是绝对路径：${target}`);
  }

  let probe = target;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) {
      throw new Error(`无法校验路径归属：${target}`);
    }
    probe = parent;
  }
  const realProbe = fs.realpathSync(probe);
  if (realProbe !== realBase && !realProbe.startsWith(realBase + path.sep)) {
    throw new Error(`路径越界（realpath 不在数据目录内）：${target}`);
  }
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
    throw new Error(`拒绝对符号链接操作：${target}`);
  }
  return target;
}

export function readAllLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  // 拒绝对符号链接的读：避免 lstat→open 之间的替换把读取导向库外文件（缩小 TOCTOU 面）
  const st = fs.lstatSync(filePath);
  if (st.isSymbolicLink()) {
    throw new Error(`拒绝读取符号链接文件：${filePath}`);
  }
  if (st.isFile() && st.size > MAX_SHARD_BYTES) {
    const err = new Error(`分片超过有界读取上限（${MAX_SHARD_BYTES} 字节）：${filePath}`);
    err.code = 'SHARD_TOO_LARGE';
    throw err;
  }
  const content = fs.readFileSync(filePath, "utf-8");
  return content.split("\n").filter(Boolean);
}

export function writeAllLines(filePath, lines) {
  const text=lines.join("\n")+(lines.length>0?"\n":"");
  if(Buffer.byteLength(text,'utf8')>MAX_SHARD_BYTES){
    const error=new Error(`写入结果将超过分片读取上限${MAX_SHARD_BYTES}字节；原分片未改，请分流知识归属或先归档。`);
    error.code='SHARD_OVER_LIMIT';throw error;
  }
  atomicWriteFile(filePath,text);
}

/**
 * 解析单个 JSONL 文件为卡片数组（跳过无法解析的行，并报告数量）。
 * @returns {{cards: object[], badLines: number[]}}
 */
export function parseCardsFromFile(filePath) {
  const cards = [];
  const badLines = [];
  const lines = readAllLines(filePath);
  for (let i = 0; i < lines.length; i++) {
    try {
      const card = JSON.parse(lines[i]);
      if (card && typeof card === "object" && card.id) cards.push(card);
    } catch {
      badLines.push(i + 1);
    }
  }
  return { cards, badLines };
}

// ── 检索统计旁路（stats.json） ──────────────────────────────
// 设计：统计是「带外」数据，绝不写回卡片内容；内存合并 + 显式/延迟落盘，
// 从而消除「检索一次就重写整个分片」的写放大与字节漂移。

let _statsCache = null;
function statsDiskSignature() {
  try {
    const st = fs.statSync(STATS_FILE);
    return `${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
  } catch (error) {
    return error?.code === 'ENOENT' ? 'missing' : `error:${error?.code || error?.message}`;
  }
}

/**
 * 严格校验 stats.json 结构。**load / bump / flush / normalize 共用此单一入口**，
 * 避免各处 schema 松紧不一：某处把 cards 数组当映射读 → 空库视图 → flush 时用空库覆盖原文件。
 * - 顶层必须是对象（非 null / 非数组 / 非标量）
 * - cards 若存在必须为「对象映射」（非 null / 非数组）
 * - 每个 entry 必须是对象；queryCount（若有）为数字；lastQueried（若有）为字符串
 * @returns {{ok:true, cards:object}|{ok:false, error:string}}
 */
export function validateStatsShape(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "stats.json 顶层结构非法（不是对象）" };
  }
  const rawCards = value.cards;
  if (rawCards === undefined) return { ok: true, cards: {} };
  if (rawCards === null || typeof rawCards !== "object" || Array.isArray(rawCards)) {
    return { ok: false, error: "stats.json 的 cards 结构非法（不是对象）" };
  }
  for (const [key, entry] of Object.entries(rawCards)) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, error: `stats.json 的条目「${key}」结构非法（不是对象）` };
    }
    if (entry.queryCount !== undefined && typeof entry.queryCount !== "number") {
      return { ok: false, error: `stats.json 的条目「${key}」queryCount 非数字` };
    }
    if (entry.lastQueried !== undefined && typeof entry.lastQueried !== "string") {
      return { ok: false, error: `stats.json 的条目「${key}」lastQueried 非字符串` };
    }
  }
  return { ok: true, cards: rawCards };
}

export function loadStats() {
  const signature = statsDiskSignature();
  if (_statsCache && _statsCache.signature === signature) return _statsCache;
  let disk = {};
  let error = null;
  try {
    if (fs.existsSync(STATS_FILE)) {
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(STATS_FILE, "utf-8"));
      } catch (e) {
        error = `stats.json 已损坏（无法解析）：${e.message}`;
      }
      if (error === null) {
        const v = validateStatsShape(parsed);
        if (v.ok) disk = v.cards;
        else error = v.error;
      }
    }
  } catch (e) {
    error = `stats.json 读取失败：${e.message}`;
  }
  // invalid=true 表示磁盘结构非法：以**只读空视图**继续（检索仍可用），但 flush 必须拒绝落盘 ——
  // 否则会用空库覆盖其中可能存在的原始字节。
  _statsCache = { cards: disk, dirty: false, invalid: Boolean(error), error, signature };
  if (error) {
    console.warn(`[kc-io] ${error}；统计以只读空视图继续，落盘被拒绝以保留原文件（检索仍可用）。`);
  }
  return _statsCache;
}

/** 在内存中累加检索次数（不落盘）；返回该卡的当前统计 */
export function bumpStats(agent, cardId, day) {
  const stats = loadStats();
  // 结构非法：不累积、不置 dirty，避免后续 flush 把空库写回覆盖原文件
  if (stats.invalid) return null;
  if (!isValidAgent(agent) || typeof cardId !== "string" || !cardId) return null;
  const key = `${agent}::${cardId}`;
  const cur = stats.cards[key] || { queryCount: 0, lastQueried: "" };
  cur.queryCount = (cur.queryCount || 0) + 1;
  cur.lastQueried = day;
  stats.cards[key] = cur;
  stats.dirty = true;
  return cur;
}

export function getStats(agent, cardId) {
  const stats = loadStats();
  return stats.cards[`${agent}::${cardId}`] || { queryCount: 0, lastQueried: "" };
}

export function statsAreDirty() {
  return Boolean(loadStats().dirty);
}

/** 落盘统计；无变更时是纯 no-op（不产生新字节） */
export function flushStats() {
  const stats = loadStats();
  if (stats.invalid) {
    console.warn("[kc-io] stats.json 结构非法，拒绝落盘以免用空库覆盖原文件。");
    return false;
  }
  if (!stats.dirty) return false;
  const text = JSON.stringify({ version: 1, cards: stats.cards }, null, 2);
  // 写放大抑制：磁盘字节与将要写入的完全一致时跳过重写（统计是附属数据，避免无谓 rewrite+rename）
  try {
    if (fs.existsSync(STATS_FILE) && fs.readFileSync(STATS_FILE, "utf-8") === text) {
      stats.dirty = false;
      return false;
    }
  } catch {
    // 读取失败（如路径是目录）：继续走写入分支，由 atomicWriteFile 如实报错
  }
  atomicWriteFile(STATS_FILE, text, { fsync: false });
  stats.signature = statsDiskSignature();
  stats.dirty = false;
  return true;
}

/** 测试专用：丢弃内存中的统计缓存 */
export function _resetStatsCache() {
  _statsCache = null;
}

/**
 * 读取全部分片的卡片（合并统计旁路，供需要热度的只读展示使用）。
 * 分片集合来自目录发现（而非固定名单）。
 *
 * 失败必须显式抛出，不能返回空 Map：空 Map 与「真的没有卡」在调用方看来完全一样，
 * 会把「目录不可读 / 扫描被截断 / 分片读不了」伪装成「库里没有数据」。
 * @returns {Map<string, object>} id → cardWithStats
 * @throws {Error & {code:string}} code 为 DATA_DIR_UNREADABLE / SHARD_DISCOVERY_TRUNCATED / 分片读取错误码
 */
export function readAllCardsWithStats() {
  const map = new Map();
  // 发现失败或被截断时直接抛出，绝不降级为空 Map。
  const agents = listShardAgents();
  for (const agent of agents) {
    const filePath = getJsonlPath(agent);
    if (!fs.existsSync(filePath)) continue;
    let cards;
    try {
      cards = parseCardsFromFile(filePath).cards;
    } catch (e) {
      const err = new Error(`读取分片 ${agent} 失败：${e?.message || String(e)}`);
      err.code = e?.code || 'SHARD_READ_FAILED';
      err.agent = agent;
      throw err;
    }
    for (const card of cards) {
      map.set(`${agent}::${card.id}`, { ...card, ...getStats(agent, card.id), agent: card.agent || agent });
    }
  }
  return map;
}

// ── 索引 ────────────────────────────────────────────────────

let _indexCache = null;
/** 最近一次 rebuild 中「跨 agent 同 id」的冲突列表（v3.0.6：不再静默互相遮蔽，可观测）。 */
let _indexCollisions = [];
export function getIndexCollisions() { return _indexCollisions; }
/** 索引复合键：`agent::id`。v3.0.6 起索引以此为主键，跨 agent 同 id 不再互相遮蔽。 */
export const indexKey = (agent, id) => `${agent}::${id}`;
export function parseIndexKey(key) {
  const i = String(key).indexOf('::');
  return i < 0 ? { agent: null, id: String(key) } : { agent: String(key).slice(0, i), id: String(key).slice(i + 2) };
}

export function loadIndex() {
  if (_indexCache) return _indexCache;
  try {
    if (!fs.existsSync(INDEX_FILE)) return null;
    _indexCache = JSON.parse(fs.readFileSync(INDEX_FILE, "utf-8"));
    return _indexCache;
  } catch {
    return null;
  }
}

function clearIndexCache() {
  _indexCache = null;
}

/**
 * 扫描目录内的全部分片，重建 index.json（原子写），返回卡片总数。
 * 字节稳定性保证：顶层不含时间戳；dataUpdatedAt / contentHash 仅在内容真的变化时更新，
 * 因此「数据没变 → 重复 rebuild 产出逐字节相同的 index.json」。
 */
export function rebuildIndex() {
  const allCards = {};
  const index = {};

  for (const agent of listShardAgents()) {
    const filePath = getJsonlPath(agent);
    for (const rawCard of parseCardsFromFile(filePath).cards) {
      const id = rawCard.id;
      if (!id) continue;
      const ag = rawCard.agent || agent;
      const key = indexKey(ag, id); // 复合键：跨 agent 同 id 不再互相遮蔽
      allCards[key] = {
        agent: ag,
        keywords: Array.isArray(rawCard.keywords) ? rawCard.keywords : [],
        score: typeof rawCard.score === "number" ? rawCard.score : 5,
        summary: rawCard.summary || "",
        created: rawCard.created || "",
        lastUpdated: rawCard.lastUpdated || "",
      };
      for (const kw of allCards[key].keywords) {
        const k = String(kw).toLowerCase().trim();
        if (!k) continue;
        if (!index[k]) index[k] = [];
        if (!index[k].includes(key)) index[k].push(key);
      }
    }
  }

  const contentHash = sha256(stableStringify({ index, allCards }));

  let dataUpdatedAt = "";
  const previous = loadIndex();
  if (previous && previous.contentHash === contentHash && typeof previous.dataUpdatedAt === "string") {
    // 内容未变：沿用旧时间戳，保证字节完全一致
    dataUpdatedAt = previous.dataUpdatedAt;
  } else {
    dataUpdatedAt = new Date().toISOString();
  }

  const indexData = {
    version: 2,
    dataUpdatedAt,
    contentHash,
    index,
    allCards,
  };

  // 复合键（agent::id）下不再存在「跨 agent 同 id 互相遮蔽」；保留空列表以兼容旧消费者。
  _indexCollisions = [];
  atomicWriteFile(INDEX_FILE, JSON.stringify(indexData, null, 2));
  clearIndexCache();
  return Object.keys(allCards).length;
}

// ── 共享写队列 ──
// 语义：writeFn 内部必须完成完整的「读-改-写」。队列只保证同一 key 的 writeFn 串行执行；
// 若调用方在入队前就读取了文件快照，串行化将无法保护该快照（会造成丢更新）。
const _writeQueues = new Map();

export function enqueueWrite(key, writeFn) {
  const prev = _writeQueues.get(key) || Promise.resolve();
  // 显式 catch 上游失败：不把错误对象当作参数喂给下一个 writeFn
  const next = prev.catch(() => {}).then(writeFn);
  _writeQueues.set(key, next);
  const cleanup = () => {
    if (_writeQueues.get(key) === next) _writeQueues.delete(key);
  };
  next.then(cleanup, cleanup);
  return next;
}

// 全库数据写队列（KC5）：store/delete/normalize 共用同一个进程内串行点。
// 顺序契约：先排队，再在回调内获取 data-lock 并重读当前分片；
// 索引重建不得包在这个队列/锁里（会与 rebuildIndexSerialized 形成嵌套等待）。
const DATA_QUEUE_KEY = '__data_write__';
export function enqueueDataWrite(writeFn) {
  return enqueueWrite(DATA_QUEUE_KEY, writeFn);
}

// 索引重建的全局串行点：所有调用方统一走此函数，避免不同 agent 的 rebuild 交错覆盖 index.json
const INDEX_QUEUE_KEY = "__index_rebuild__";

export function rebuildIndexSerialized() {
  return enqueueWrite(INDEX_QUEUE_KEY, () => rebuildIndex());
}

// ── 数据迁移 / 归一化 ───────────────────────────────────────
// 历史卡片把 queryCount / lastQueried 存在 *.notes.jsonl 里，导致「检索一次就改写被检索的数据」。
// normalizeStores() 把这两个字段迁移到 stats.json，并从卡片文件剥离；
// 迁移后卡片文件是纯内容，字节不再被检索行为改变。
//
// 幂等性说明：对已经迁移过的库，本函数不产生任何写入、不改变任何字节（不存在统计字段时直接跳过）。
// 已存在的 stats.json 记录优先——迁移只补空缺，不覆盖更新的统计。
//
// 记录粒度（v1.5.0 新增显式开关）：默认 `recordZeroStats = true`，即「只要卡片带过统计字段，
// 就在 stats.json 里建一条记录」——即使 queryCount 为 0。理由：否则会出现「卡片有、统计没有」的
// 隐性缺口，下游按 stats.json 穷举卡片时会静默漏卡（历史上 66 张 queryCount:0 的卡就是这样丢的）。
// 置为 false 可退回「只记录 queryCount>0 或 lastQueried 非空」的紧凑模式。

/** 迁移时是否为 queryCount 为 0 的卡片也建立 stats 记录（默认 true，见上方说明） */
export const DEFAULT_RECORD_ZERO_STATS = true;

/**
 * @param {{recordZeroStats?: boolean}} [options]
 * @returns {{migratedStats:number, rewrittenFiles:string[], statsFlushed:boolean, statsCommitted:boolean, changed:boolean, recordZeroStats:boolean, backups:object[], committedShards:string[], results:object[], failures:object[], error?:string}}
 */
export function normalizeStores(options = {}) {
  const recordZeroStats =
    options.recordZeroStats === undefined
      ? DEFAULT_RECORD_ZERO_STATS
      : Boolean(options.recordZeroStats);
  const out = {
    migratedStats: 0,
    rewrittenFiles: [],
    statsFlushed: false,
    statsCommitted: false,
    changed: false,
    recordZeroStats,
    backups: [],
    committedShards: [],
    results: [],
    failures: [],
  };
  // 0. 损坏/非法守卫：stats.json 存在但不可解析或结构非法 → 拒绝迁移。
  //    否则 loadStats() 会把它当空库，flush 时用「迁移结果」覆盖成非法文件——静默抹掉其中可能存在的内容。
  //    结构与 load/bump/flush 共用同一 validateStatsShape（单一真源）。
  if (fs.existsSync(STATS_FILE)) {
    let bad = null;
    try {
      const parsed = JSON.parse(fs.readFileSync(STATS_FILE, "utf-8"));
      const v = validateStatsShape(parsed);
      if (!v.ok) bad = v.error;
    } catch {
      bad = "stats.json 已损坏（无法解析）";
    }
    if (bad) {
      out.error = `${bad}，已中止归一化以免覆盖其中的内容`;
      return out;
    }
  }

  const stats = loadStats();
  const pendingWrites = []; // { agent, filePath, newLines }，先攒着，统计落盘成功后再写
  let migratedStats = 0;

  for (const agent of listShardAgents()) {
    const filePath = getJsonlPath(agent);
    if (!fs.existsSync(filePath)) continue;
    const lines = readAllLines(filePath);

    let fileChanged = false;
    const newLines = [];
    for (const line of lines) {
      let card;
      try {
        card = JSON.parse(line);
      } catch {
        newLines.push(line);
        continue;
      }
      const hadStats = STATS_FIELDS.some((f) => card[f] !== undefined);
      if (!hadStats) {
        newLines.push(line);
        continue;
      }

      const key = `${agent}::${card.id}`;
      if (!stats.cards[key]) {
        const queryCount = typeof card.queryCount === "number" ? card.queryCount : 0;
        const lastQueried = typeof card.lastQueried === "string" ? card.lastQueried : "";
        // 粒度由 recordZeroStats 决定（默认全量）。只有整张卡从未被检索过（0 次且无日期）
        // 且显式关闭了全量记录时才跳过，避免下游穷举 stats.json 时静默漏卡。
        if (recordZeroStats || queryCount > 0 || lastQueried) {
          stats.cards[key] = { queryCount, lastQueried };
          stats.dirty = true;
          migratedStats++;
        }
      }

      const cleaned = normalizeCard(card);
      const serialized = JSON.stringify(cleaned);
      if (serialized !== line) {
        newLines.push(serialized);
        fileChanged = true;
      } else {
        newLines.push(line);
      }
    }

    if (fileChanged) {
      pendingWrites.push({ agent, filePath, newLines });
    }
  }

  // 1. 先把统计落盘 —— 此刻分片里还保留着唯一副本。失败则中止，不剥离任何分片。
  let statsFlushed = false;
  if (statsAreDirty()) {
    try {
      statsFlushed = flushStats();
      // false also means byte-identical no-op; require durable equality before stripping.
      const expected = JSON.stringify({ version: 1, cards: stats.cards }, null, 2);
      if (!statsFlushed && (stats.invalid || !fs.existsSync(STATS_FILE) || fs.readFileSync(STATS_FILE, 'utf8') !== expected)) {
        out.statsFlushed = false;
        out.statsCommitted = false;
        out.error = '统计落盘未提交，已中止分片剥离（分片保留统计字段）';
        return out;
      }
    } catch (err) {
      out.statsFlushed = false;
      out.statsCommitted = false;
      out.error = `统计落盘失败，已中止分片剥离（分片保留统计字段）：${err.message}`;
      return out;
    }
  }
  out.statsFlushed = statsFlushed;
  out.statsCommitted = true;
  out.migratedStats = migratedStats;

  // 2. 统计已持久 → 逐片备份 + 重写。任何一片失败都只影响该片，并在结果中如实列出。
  for (const p of pendingWrites) {
    const entry = { agent: p.agent, path: p.filePath, status: 'pending', backup: null, error: null, code: null };
    try {
      entry.backup = backupShardExclusive(p.filePath, { reason: 'normalize' });
      if (entry.backup) out.backups.push({ agent: p.agent, path: entry.backup.path });
    } catch (err) {
      entry.status = 'backup-failed';
      entry.code = err.code || 'BACKUP_FAILED';
      entry.error = err.message;
      out.results.push(entry);
      out.failures.push({ agent: p.agent, stage: 'backup', code: entry.code, error: entry.error });
      continue;
    }
    try {
      writeAllLines(p.filePath, p.newLines);
      entry.status = 'committed';
      out.committedShards.push(p.agent);
      out.rewrittenFiles.push(`${p.agent}.notes.jsonl`);
      out.results.push(entry);
    } catch (err) {
      entry.status = 'write-failed';
      entry.code = err.code || 'WRITE_FAILED';
      entry.error = err.message;
      out.results.push(entry);
      out.failures.push({ agent: p.agent, stage: 'write', code: entry.code, error: entry.error });
    }
  }

  out.changed = out.committedShards.length > 0 || out.statsFlushed;
  if (out.failures.length > 0) {
    out.error = `归一化部分失败：已提交分片 ${out.committedShards.length} 个，失败 ${out.failures.length} 个；stats ${out.statsCommitted ? '已提交' : '未提交'}`;
  }
  return out;
}
