// Authenticated same-App routes. The host authenticates app_route before these
// handlers. Writes additionally require explicit JSON + a non-simple UI header.
import { listCards, getCard, getCandidates, getCandidate } from './ui-api.js';
import { execute as verify } from '../tools/kc-verify.js';
import { execute as status } from '../tools/kc-status.js';
import { publishReviewSummary } from './public-projection.js';
import { APP_VERSION } from './version.js';
import { manageCard, deletePreview } from './ui-management.js';
const MAX_BODY = 16384;
// Only remove filesystem diagnostics/implementation fields. Card prose is user data.
export function pageResponse(value) {
  if (Array.isArray(value)) return value.map(pageResponse);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    if (['sessionPath', 'dataDir', 'path', 'archivePath', 'backupPath', 'archiveDir', 'receiptPath', 'plannedCard'].includes(key)) continue;
    if (key === 'diagnostics' && Array.isArray(v)) { out[key] = v.map(d => ({ code: String(d.code || 'unknown'), ...(Number.isInteger(d.line) ? { line: d.line } : {}), ...(typeof d.storageAgent === 'string' ? { storageAgent: d.storageAgent } : {}) })); continue; }
    if (key === 'error' && typeof v === 'string' && /(?:[A-Za-z]:[\\/]|\\\\|\/Users\/|\/home\/)/.test(v)) { out[key] = '底层存储操作异常，请通过 KC 诊断工具核对'; continue; }
    out[key] = pageResponse(v);
  }
  return out;
}
const fail = (code, error) => ({ ok: false, code, error });
function httpStatus(r) {
  if (r.ok !== false) return 200;
  if (r.code === 'CARD_NOT_FOUND' || r.code === 'CANDIDATE_NOT_FOUND') return 404;
  if (/SNAPSHOT|REVISION|CONFLICT|DIGEST|TARGET_CHANGED/.test(r.code || '')) return 409;
  if (/UNAVAILABLE|INCOMPLETE/.test(r.code || '')) return 503;
  return 400;
}
export function requestGuard(context, headers) {
  if (!context || context.appId !== 'kc-system' || !context.principal) return fail('APP_CONTEXT_REQUIRED', '缺少 KC 页面鉴权上下文');
  const type = headers.get('content-type') || '';
  if (!/^application\/json(?:\s*;|$)/i.test(type) || headers.get('x-kc-ui') !== '1') return fail('UI_REQUEST_REQUIRED', '审核需要 KC 页面 JSON 请求');
  if (headers.get('sec-fetch-site') === 'cross-site') return fail('CROSS_SITE_DENIED', '拒绝跨站审核请求');
  const n = headers.get('content-length');
  if (n !== null && (!/^\d+$/.test(n) || Number(n) > MAX_BODY)) return fail('BODY_TOO_LARGE', '审核请求超过上限');
  return { ok: true };
}
async function readBody(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('审核请求不能为空');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) { await reader.cancel(); throw new Error('审核请求超过16KiB'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const buffer = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
}
export function validateReview(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('INPUT_INVALID', '审核参数需为对象');
  const allowed = ['action', 'candidateId', 'expectedRevision', 'expectedTargetDigest', 'reviewSummary', 'reason', 'confirm'];
  if (Object.keys(input).some(k => !allowed.includes(k))) return fail('INPUT_INVALID', '包含不支持的审核字段');
  if (!['publish', 'reject'].includes(input.action) || input.confirm !== true) return fail('CONFIRM_REQUIRED', '请明确确认发布或驳回');
  if (!/^cand-[a-f0-9]{64}$/.test(input.candidateId || '') || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) return fail('INPUT_INVALID', '候选身份或版本无效');
  if (input.action === 'publish') {
    if (!/^(?:absent|[a-f0-9]{64})$/.test(input.expectedTargetDigest || '')) return fail('DIGEST_REQUIRED', '发布需携带已审阅的目标摘要');
    if (typeof input.reviewSummary !== 'string' || input.reviewSummary.trim().length < 10 || input.reviewSummary.length > 500) return fail('REVIEW_REQUIRED', '审阅说明需10..500字');
  } else if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 500) return fail('REASON_REQUIRED', '驳回理由需1..500字');
  return { ok: true };
}
export async function registerUiRoutes(sdk) {
  return await sdk.routes.register(app => {
    app.use('/ui/*', async (c, next) => {
      c.header('Cache-Control', 'no-store');
      c.header('X-Content-Type-Options', 'nosniff');
      const context = c.get('appRequestContext');
      if (context?.appId !== 'kc-system' || !context.principal) return c.json(fail('APP_CONTEXT_REQUIRED', '缺少 KC 页面鉴权上下文'), 403);
      await next();
    });
    const readRoute = (url, handler) => app.get(url, async c => {
      try { const r = await handler(c.req.query()); return c.json(pageResponse(r), httpStatus(r)); }
      catch (e) { return c.json(fail('READ_FAILED', String(e?.code || e?.message || e).slice(0, 240)), 500); }
    });
    readRoute('/ui/health', () => ({ ok: true, version: APP_VERSION }));
    readRoute('/ui/cards', listCards);
    readRoute('/ui/card', getCard);
    readRoute('/ui/candidates', getCandidates);
    readRoute('/ui/candidate', getCandidate);
    readRoute('/ui/delete-preview', deletePreview);
    app.post('/ui/manage', async c => {
      const guard = requestGuard(c.get('appRequestContext'), c.req.raw.headers);
      if (!guard.ok) return c.json(guard, 403);
      let input;
      try { input = await readBody(c.req.raw); }
      catch { return c.json(fail('INPUT_INVALID', '操作 JSON 不合法或超过16KiB'), 400); }
      try { const r = await manageCard(input, c.get('appRequestContext')); return c.json(pageResponse(r), httpStatus(r)); }
      catch { return c.json({ ok: false, code: 'MANAGEMENT_UNKNOWN', error: '操作结果尚未确认，请重新读取卡片核对，勿直接重试。', unknown: true }, 500); }
    });
    readRoute('/ui/status', async () => {
      const r = await status({}, { getCapabilities: typeof sdk.capabilities?.get === 'function' ? () => sdk.capabilities.get() : undefined });
      // Keep raw filesystem paths and permission ledger out of the page response.
      const { dataDir, capabilities, lock, ...details } = r.details;
      return { ok: true, ...details, lock: { state: lock?.state || lock?.status || 'unknown', remedy: lock?.remedy || null, error: lock?.error || null } };
    });
    app.post('/ui/review', async c => {
      const guard = requestGuard(c.get('appRequestContext'), c.req.raw.headers);
      if (!guard.ok) return c.json(guard, 403);
      let input;
      try { input = await readBody(c.req.raw); }
      catch { return c.json(fail('INPUT_INVALID', '审核 JSON 不合法或超过16KiB'), 400); }
      const valid = validateReview(input);
      if (!valid.ok) return c.json(valid, 400);
      try {
        // A UI flag is not authority: verify repository/target readability server-side.
        // Keep the caller-reviewed revision/digest unchanged; the existing transaction
        // performs the final CAS under lock, so this is only a completeness preflight.
        if (input.action === 'publish') {
          const preview = await getCandidate({ candidateId: input.candidateId });
          if (!preview.ok) return c.json(preview, httpStatus(preview));
          if (!preview.canReview) return c.json(fail('REVIEW_TARGET_UNAVAILABLE', '正式库或目标卡片不完整，暂停发布；请先核对诊断'), 503);
        }
        const r = await verify(input);
        const details = { ...r.details };
        try { details.projection = await publishReviewSummary(sdk); }
        catch { details.projection = { ok: false, error: 'review projection refresh failed' }; }
        details.partial = !!(details.statusPending || details.indexError || details.receiptError);
        return c.json(pageResponse(details), httpStatus(details));
      } catch (e) { return c.json(fail('REVIEW_UNKNOWN', '审核响应异常，请重新读取候选核对结果：' + String(e?.code || e?.message || e).slice(0, 180)), 500); }
    });
  });
}
