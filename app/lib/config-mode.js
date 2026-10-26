// lib/config-mode.js — observe/enforce 模式读取（DESIGN「安全切换」骨架）
//
// 语义：应用对宿主工具的拦截默认应为 observe（记录不阻断）；用户正式授权后切 enforce。
// 读取点：ctx.config 只在 apply 完成、装载器发布贡献之后才可用——因此本模块不缓存值，
// 只在调用时经绑定的读取函数取；未绑定 / 读取失败 / 值非法一律回落 observe（fail-safe）。
let _configGet = null;

/** 入口在 apply 内绑定（惰性调用，不立即读）。 */
export function bindConfigMode(getter) {
  _configGet = typeof getter === "function" ? getter : null;
}

export const MODES = ["observe", "enforce"];
export const DEFAULT_MODE = "observe";

/** 读当前模式：observe | enforce（任何异常与非法值 → observe）。 */
export async function readMode() {
  if (!_configGet) return DEFAULT_MODE;
  try {
    const v = await _configGet("mode");
    return v === "enforce" ? "enforce" : DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE;
  }
}

/** 是否需要执行实际拦截（enforce 模式）。 */
export async function shouldEnforce() {
  return (await readMode()) === "enforce";
}
