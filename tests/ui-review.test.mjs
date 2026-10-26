import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = fs.mkdtempSync(path.join(root, '.fixture-review-'));
const { configureDataRoot } = await import('../app/lib/io-root.js');
configureDataRoot(fixture);
const { requestGuard, validateReview, registerUiRoutes, pageResponse } = await import('../app/lib/ui-routes.js');
const { proposeCandidate, readCandidate } = await import('../app/lib/candidate-store.js');
const { getCandidate } = await import('../app/lib/ui-api.js');
const context = { appId: 'kc-system', principal: { kind: 'app-surface' } };
const headers = { 'Content-Type': 'application/json', 'X-KC-UI': '1' };
const handlers = new Map();
await registerUiRoutes({ routes: { async register(callback) { callback({ use() {}, get(name, handler) { handlers.set('GET ' + name, handler); }, post(name, handler) { handlers.set('POST ' + name, handler); } }); } } });
async function review(body, opts = {}) {
  const request = new Request('http://local/api/apps/kc-system/routes/ui/review', { method: 'POST', headers: { ...headers, ...opts.headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return handlers.get('POST /ui/review')({ get: () => opts.context === undefined ? context : opts.context, req: { raw: request }, json: (data, code = 200) => new Response(JSON.stringify(data), { status: code, headers: { 'Content-Type': 'application/json' } }) });
}
const makeProposal = (id) => ({ agent: 'hanako', id, summary: '页面候选', content: '测试库中的候选正文', keywords: ['UI-review'] });

test('write requires host context, JSON, explicit confirmation and non-simple UI header', () => {
  assert.equal(requestGuard(null, new Headers(headers)).ok, false);
  assert.equal(requestGuard({ ...context, appId: 'other' }, new Headers(headers)).ok, false);
  assert.equal(requestGuard(context, new Headers({ 'Content-Type': 'text/plain' })).ok, false);
  assert.equal(requestGuard(context, new Headers({ ...headers, 'Sec-Fetch-Site': 'cross-site' })).ok, false);
  assert.equal(requestGuard(context, new Headers(headers)).ok, true);
  assert.equal(validateReview({ action: 'recover-lock', confirm: true }).ok, false);
  assert.equal(validateReview({ action: 'publish', confirm: false }).ok, false);
});

test('page projection strips storage metadata and diagnostics without changing card prose', () => {
  const projected = pageResponse({ card: { content: '用户正文可提到 /example/project', source: '用户标注来源' }, sessionPath: '/example/private/session.jsonl', diagnostics: [{ code: 'io-error', message: '/example/private/data', line: 3 }], error: 'ENOENT ' + ['', 'home', 'example', 'private', 'x'].join('/') });
  assert.equal(projected.sessionPath, undefined);
  assert.deepEqual(projected.diagnostics, [{ code: 'io-error', line: 3 }]);
  assert.ok(!projected.error.includes('private'));
  assert.equal(projected.card.content, '用户正文可提到 /example/project');
});
test('review input limits match storage and cannot select legacy queue actions', () => {
  const base = { action: 'publish', candidateId: 'cand-' + 'a'.repeat(64), expectedRevision: 1, expectedTargetDigest: 'absent', confirm: true };
  assert.equal(validateReview({ ...base, reviewSummary: '字'.repeat(500) }).ok, true);
  assert.equal(validateReview({ ...base, reviewSummary: '字'.repeat(501) }).ok, false);
  assert.equal(validateReview({ ...base, reviewSummary: '字'.repeat(20), kcName: 'legacy' }).ok, false);
});

test('candidate preview and publish use the reviewed digest and create a real formal card', async () => {
  const proposed = await proposeCandidate({ proposed: makeProposal('ui-publish'), origin: { source: 'test', sessionPath: '/example/private/session.jsonl' } });
  assert.equal(proposed.ok, true, proposed.error);
  const view = await getCandidate({ candidateId: proposed.candidateId });
  assert.equal(view.canReview, true);
  assert.equal(view.target.digest, 'absent');
  assert.equal(view.candidate.origins[0].sessionPath, undefined);
  assert.equal(view.candidate.intent, undefined);
  const res = await review({ action: 'publish', candidateId: proposed.candidateId, expectedRevision: view.candidate.revision, expectedTargetDigest: view.target.digest, reviewSummary: '已核对候选内容与目标卡片差异', confirm: true });
  const body = await res.json();
  assert.equal(body.ok, true, JSON.stringify(body));
  assert.equal(body.committed, true);
  assert.equal((await readCandidate(proposed.candidateId)).candidate.status, 'published');
  assert.ok(fs.readFileSync(path.join(fixture, 'data', 'hanako.notes.jsonl'), 'utf8').includes('ui-publish'));
});

test('stale target digest refuses overwriting an intervening card', async () => {
  const p = await proposeCandidate({ proposed: makeProposal('ui-conflict') });
  const view = await getCandidate({ candidateId: p.candidateId });
  fs.appendFileSync(path.join(fixture, 'data', 'hanako.notes.jsonl'), JSON.stringify({ ...makeProposal('ui-conflict'), content: '另一个Agent新写的内容' }) + '\n');
  const before = fs.readFileSync(path.join(fixture, 'data', 'hanako.notes.jsonl'));
  const res = await review({ action: 'publish', candidateId: p.candidateId, expectedRevision: view.candidate.revision, expectedTargetDigest: 'absent', reviewSummary: '已完成候选内容审阅但是目标发生变化', confirm: true });
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(res.status, 409);
  assert.deepEqual(fs.readFileSync(path.join(fixture, 'data', 'hanako.notes.jsonl')), before);
});

test('reject updates only the candidate; malformed/oversized requests cannot invoke review', async () => {
  const p = await proposeCandidate({ proposed: makeProposal('ui-reject') });
  const before = fs.readFileSync(path.join(fixture, 'data', 'hanako.notes.jsonl'));
  assert.equal((await review('{bad')).status, 400);
  assert.equal((await review('a'.repeat(17000))).status, 400);
  const res = await review({ action: 'reject', candidateId: p.candidateId, expectedRevision: p.revision, reason: '不作为正式知识发布', confirm: true });
  assert.equal((await res.json()).ok, true);
  assert.equal((await readCandidate(p.candidateId)).candidate.status, 'rejected');
  assert.deepEqual(fs.readFileSync(path.join(fixture, 'data', 'hanako.notes.jsonl')), before);
});

test('server refuses publishing when repository completeness cannot be established', async () => {
  const p = await proposeCandidate({ proposed: makeProposal('ui-incomplete') });
  fs.appendFileSync(path.join(fixture, 'data', 'hanako.notes.jsonl'), '{broken\n');
  const before = fs.readFileSync(path.join(fixture, 'data', 'hanako.notes.jsonl'));
  const res = await review({ action: 'publish', candidateId: p.candidateId, expectedRevision: p.revision, expectedTargetDigest: 'absent', reviewSummary: '损坏库不应允许页面发布新卡片内容', confirm: true });
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.code, 'REVIEW_TARGET_UNAVAILABLE');
  assert.deepEqual(fs.readFileSync(path.join(fixture, 'data', 'hanako.notes.jsonl')), before);
});

test.after(() => { assert.ok(fixture.startsWith(path.join(root, '.fixture-review-'))); fs.rmSync(fixture, { recursive: true, force: true }); });
