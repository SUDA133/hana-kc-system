// KC System — SDK entry: advisory retrieval, candidate review and honest diagnostics.
// Ordinary tools are never gated by KC workflow state.
//
// 迁移要点（对应 DESIGN「公开接口」与 PLAN 第 5 条）：
//   · 官方 defineApp + await 注册（注册方法必须 await：不 await 时失败会变成 unhandled rejection 杀进程）。
//   · 顺序契约：configureDataRoot(sdk.dataDir) 必须发生在**动态 import 任何读取路径常量的模块之前**
//     （jsonl-io / pending-store 等在 import 期解析路径）。因此工具模块一律动态 import。
//   · 本文件不得静态 import 上述模块，也不得静态 import 工具文件——否则路径会在 configure 之前固化。
//   · 工具名按 DESIGN：kc_check / kc_query / kc_store / kc_delete / kc_reindex / kc_stats / kc_verify /
//     kc_acknowledge / kc_scope（kc_migrate 属迁移工具切片，后续接）。宿主不给工具名加前缀，故自带命名空间。
//   · 权限档：只读三件套（check/query/stats）声明 readOnly→免审阅；其余不声明→宿主默认 review。
//   · 注册失败 → 回滚已注册工具并抛出（带失败工具名），不静默半截成功。
//   · 旧工具模块签名 execute(input, toolCtx)；SDK 通道是单参数 execute({ ...args, context })。
//     适配器把 context 还原为 toolCtx，输出统一为 { content: [{ type:'text', text }] }。
import { defineApp } from "./sdk/app-contract/server-client.js";
import { configureDataRoot } from "./lib/io-root.js";
import { APP_VERSION } from './lib/version.js';
import { bindConfigMode } from "./lib/config-mode.js";
import { resetHealth,noteRegistration,noteFailure,noteSuccess } from './lib/runtime-health.js';

export const name = "kc-system";

/** 11 tools: ten compatibility names plus read-only kc_status. */
const TOOL_SPECS = [
  { name: "kc_check",       module: "./tools/check-kc.js",        readOnly: true },
  { name: "kc_query",       module: "./tools/knowledge-query.js", readOnly: true },
  { name: "kc_stats",       module: "./tools/knowledge-stats.js", readOnly: true },
  { name: "kc_status",      module: "./tools/kc-status.js",       readOnly: true },
  { name: "kc_store",       module: "./tools/knowledge-store.js" },
  { name: "kc_delete",      module: "./tools/knowledge-delete.js" },
  { name: "kc_reindex",     module: "./tools/knowledge-reindex.js" },
  { name: "kc_verify",      module: "./tools/kc-verify.js" },
  { name: "kc_acknowledge", module: "./tools/acknowledge.js" },
  { name: "kc_scope",       module: "./tools/kc-scope.js" },
  { name: "kc_archive",     module: "./tools/kc-archive.js" },
];

/** 旧工具输出（字符串 / 已包装对象）→ SDK 结果形状。 */
function toSdkResult(out) {
  if (typeof out === "string") return { content: [{ type: "text", text: out }] };
  if (out && typeof out === "object" && Array.isArray(out.content)) return out;
  return { content: [{ type: "text", text: String(out ?? "") }] };
}

export default defineApp(async (sdk) => {
  // ① 数据根：先于一切读取路径常量的模块（顺序契约见文件头）。
  configureDataRoot(sdk.dataDir);
  resetHealth();
  bindConfigMode(null);
  // ①b 运行模式读取绑定（懒调用：ctx.config 在装载器发布贡献之后才通，不能在此处立即读）。
  if (sdk.config && typeof sdk.config.get === "function") {
    bindConfigMode((key) => sdk.config.get(key));
  }
  await sdk.logger.info(`[kc-system] v${APP_VERSION}: advisory retrieval and reviewable candidates; no ordinary-tool gate`);

  // ② 注册工具（每个 await；失败即回滚 + 抛出）。
  const done = [];
  let registering = null;
  try {
    for (const spec of TOOL_SPECS) {
      registering = spec.name;
      const mod = await import(spec.module); // 动态 import：在 configureDataRoot 之后
      const registration = {
        name: spec.name,
        description: mod.description,
        parameters: mod.parameters,
        ...(spec.readOnly ? { sessionPermission: { readOnly: true } } : {}),
        async execute(args) {
          const { context, ...input } = args || {};
          const out = await mod.execute(input, {
            ...(context || {}),
            getCapabilities:typeof sdk.capabilities?.get==='function'?()=>sdk.capabilities.get():undefined,
          });
          const result=toSdkResult(out);
          const changed=spec.name==='kc_archive'||(spec.name==='kc_verify'&&['publish','reject','confirm','reconcile','discard-candidate'].includes(input.action));
          if(changed){
            try{const p=await import('./lib/public-projection.js');const projection=await p.publishReviewSummary(sdk);result.details={...(result.details||{}),projection};}
            catch(e){noteFailure('review-projection',e);result.details={...(result.details||{}),projection:{ok:false,error:String(e?.code||e?.message||e)}};}
          }
          return result;
        },
      };
      const receipt = await sdk.tools.register(registration);
      noteRegistration('tool:'+spec.name,true);
      done.push({ name: spec.name, receipt });
    }
    // ②b Same-App page routes. Reuse existing business modules after data root setup.
    registering = 'ui-routes';
    const { registerUiRoutes } = await import('./lib/ui-routes.js');
    const routeReceipt = await registerUiRoutes(sdk);
    noteRegistration('routes:ui', true);
    done.push({ name: 'routes:ui', receipt: routeReceipt });

    // ③ hooks 接线（降级语义：hook 是增强；import/注册失败都不拖垮应用启动——与 reply-guard 同姿态）
    registering = 'hooks';
    try {
      const { registerHooks } = await import('./lib/hooks.js');
      const { receipts: hookReceipts, failures: hookFailures } = await registerHooks(sdk);
      for (const h of hookReceipts) done.push({ name: h.word, receipt: h.receipt });
      for (const f of hookFailures) await sdk.logger.warn(`[kc-system] hook ${f.word} 注册失败（kc_status可见）：${f.error}`);
    } catch (e) {
      noteFailure('hooks-registration',e);
      await sdk.logger.warn(`[kc-system] hooks 接线失败（kc_status可见）：${e?.message || e}`);
    }
    // ④ 跨 App 只读查询服务（降级语义：服务不可用不拖垮启动；工具本身仍可用）
    registering = 'service';
    try {
      const { registerQueryService } = await import('./lib/service.js');
      const svcReceipt = await registerQueryService(sdk);
      noteRegistration('service:query',true);
      done.push({ name: 'service:query', receipt: svcReceipt });
    } catch (e) {
      noteRegistration('service:query',false,e);
      await sdk.logger.warn(`[kc-system] 查询服务注册失败（kc_status可见）：${e?.message || e}`);
    }
    // ⑤ publicData：读 SP 投影刷 install 队列 + 发布自身 review 摘要（best-effort，不阻断启动）
    registering = 'publicData';
    try {
      const projection = await import('./lib/public-projection.js');
      projection.setProjectionSdk(sdk);
      await projection.refreshInstallQueueFrom(sdk);
      await projection.publishReviewSummary(sdk);
    } catch (e) {
      noteFailure('public-data',e);
      await sdk.logger.warn(`[kc-system] publicData 接线失败（kc_status可见）：${e?.message || e}`);
    }
  } catch (err) {
    noteRegistration(String(registering),false,err);
    const rolled = [];
    for (const d of done.reverse()) {
      try { if(typeof d.receipt==='function')await d.receipt();else if(typeof d.receipt?.disposeAsync==='function')await d.receipt.disposeAsync();else if(typeof d.receipt?.dispose==='function')await d.receipt.dispose();rolled.push(d.name); } catch (e) { noteFailure('rollback:'+d.name,e); }
    }
    throw new Error(
      `kc-system 应用注册失败（${registering}）：${err.message}。` +
      `已回滚 ${rolled.length} 个已注册项（${rolled.join(", ") || "无"}）。`
    );
  }

  await sdk.logger.info(`[kc-system] 已注册 ${done.length} 项（工具 + hooks）：${done.map((d) => d.name).join(", ")}`);
});
