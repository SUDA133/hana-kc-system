import path from 'node:path';
let root = null;
export function configureDataRoot(dir) {
  if(typeof dir !== 'string' || !path.isAbsolute(dir))throw new Error('App dataDir 必须是绝对路径');
  const resolved=path.resolve(dir);
  if(root && root!==resolved)throw new Error('App 数据目录已经配置，不能切换');
  root=resolved;
}
export function dataRoot(appId) {
  if(root)return root;
  // 旧套件夹具回落：仅当显式声明 HANA_APP_TEST_FIXTURE=1 时可用（仅供隔离测试）。
  // 目的：生产初始化顺序若被破坏（configureDataRoot 之前 import 了依赖数据根的模块），
  // 必须 fail-closed（抛错），而不是静默回落旧 plugin-data 目录读写。
  if(appId && process.env.HANA_APP_TEST_FIXTURE === '1' && process.env.HANA_HOME) return path.join(process.env.HANA_HOME,'plugin-data',appId);
  throw new Error('App 数据目录未配置：必须先使用宿主 sdk.dataDir 初始化（测试夹具需显式声明 HANA_APP_TEST_FIXTURE=1 并提供 HANA_HOME）');
}
export const hasAppRoot = () => root !== null;
