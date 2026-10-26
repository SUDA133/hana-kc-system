// Agent 分片动态发现：任意受限 kebab-case 名称都应可写、可读、可筛、可审、可删。
// 这组测试只使用本文件自建的临时数据根，绝不触碰真实库。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = fs.mkdtempSync(path.join(root, '.fixture-agents-'));
const { configureDataRoot } = await import('../app/lib/io-root.js');
configureDataRoot(fixture);
const io = await import('../app/lib/jsonl-io.js');
const { storeCard } = await import('../app/lib/card-writer.js');
const { readRepository } = await import('../app/lib/repository.js');
const { searchKnowledge } = await import('../app/lib/retrieval.js');
const { listCards, getCard } = await import('../app/lib/ui-api.js');
const { proposeCandidate } = await import('../app/lib/candidate-store.js');
const { getCandidate } = await import('../app/lib/ui-api.js');
const { publishCandidate } = await import('../app/lib/candidate-store.js');
const { execute: deleteCards } = await import('../app/tools/knowledge-delete.js');
const { execute: stats } = await import('../app/tools/knowledge-stats.js');
const { execute: queryExecute } = await import('../app/tools/knowledge-query.js');
const queryParameters = (await import('../app/tools/knowledge-query.js')).parameters;
const { parseProposals } = await import('../app/lib/proposal-parser.js');

const dataDir = path.join(fixture, 'data');
const shard = (agent) => path.join(dataDir, `${agent}.notes.jsonl`);

async function seed(agent, id, extra = {}) {
  const r = await storeCard(
    { agent, id, keywords: ['agents-fixture'], summary: `摘要 ${id}`, content: `正文 ${id}`, ...extra },
    { expectedDigest: 'absent' },
  );
  assert.equal(r.ok, true, `seed ${agent}::${id} 失败：${r.code} ${r.error || ''}`);
  return r;
}

test('empty library offers only generic defaults, no team roster', () => {
  const found = io.discoverShards();
  assert.equal(found.ok, true);
  assert.deepEqual(found.agents, ['cross', 'hanako']);
  assert.equal(found.ignored.length, 0);
  assert.equal(io.DEFAULT_AGENTS.includes('ming'), false);
  assert.equal(io.DEFAULT_AGENTS.includes('shin'), false);
});

test('defaults disappear once the library has its own shards', async () => {
  // 上一个用例时目录尚不存在；这里写入第一个非默认 agent，默认名应不再出现。
  await seed('alpha-team', 'alpha-first');
  const found = io.discoverShards();
  assert.deepEqual(found.agents, ['alpha-team'], '一旦有真实分片，列表就完全由目录决定');
  const facets = (await listCards({})).facets.agents;
  assert.deepEqual(Object.keys(facets), ['alpha-team'], 'facets 不应叠上未使用的默认名');
  // 清理这个分片，避免影响后续用例对分片集合的断言
  fs.rmSync(shard('alpha-team'));
});

test('a never-seen legal agent writes, reads, paginates and shows in facets', async () => {
  await seed('research-lab', 'first-note');
  await seed('research-lab', 'second-note');
  assert.ok(fs.existsSync(shard('research-lab')), '首次写入应创建对应分片');

  // 跨分片读取：不依赖任何枚举，仅靠目录发现
  const repo = readRepository({ includeInactive: true });
  assert.equal(repo.ok, true);
  assert.equal(repo.complete, true);
  assert.equal(repo.cards.filter((c) => c.storageAgent === 'research-lab').length, 2);

  // 分页
  const page1 = await listCards({ agent: 'research-lab', limit: '1' });
  assert.equal(page1.ok, true);
  assert.equal(page1.total, 2);
  assert.equal(page1.items.length, 1);
  const page2 = await listCards({ agent: 'research-lab', limit: '1', offset: '1', snapshotId: page1.snapshotId });
  assert.equal(page2.items.length, 1);
  assert.notEqual(page1.items[0].identity, page2.items[0].identity);
  assert.equal(page2.nextOffset, null);

  // facets 只列库中实际出现的 agent，且不带零值名单
  assert.equal(page1.facets.agents['research-lab'], 2);
  assert.equal(page1.facets.agents.ming, undefined);

  // 详情
  const detail = await getCard({ identity: 'research-lab::first-note' });
  assert.equal(detail.ok, true);
  assert.equal(detail.card.agent, 'research-lab');
  assert.equal(detail.card.content, '正文 first-note');
});

test('keyword search and model tool both reach the new agent', async () => {
  const hit = await searchKnowledge({ keywords: 'agents-fixture', agent: 'research-lab' });
  assert.equal(hit.isError, undefined);
  assert.equal(hit.details.total, 2);
  assert.ok(hit.details.cards.every((c) => c.agent === 'research-lab'));

  // 工具参数不再有固定 enum：任何合法名都能作为过滤值
  const agentParam = queryParameters.properties.agent;
  assert.equal(agentParam.enum, undefined);
  assert.equal(typeof agentParam.pattern, 'string');
  const viaTool = await queryExecute({ keywords: 'agents-fixture', agent: 'research-lab' });
  assert.equal(viaTool.details.total, 2);
});

test('candidate publish works for the new agent and lands in its shard', async () => {
  const proposed = await proposeCandidate({
    proposed: { agent: 'ops-team', id: 'deploy-check', keywords: ['agents-fixture'], summary: '候选摘要', content: '候选正文' },
    origin: { source: 'test' },
  });
  assert.equal(proposed.ok, true, proposed.error);

  const view = await getCandidate({ candidateId: proposed.candidateId });
  assert.equal(view.ok, true);
  assert.equal(view.canReview, true);
  assert.equal(view.target.digest, 'absent');

  const published = await publishCandidate({
    candidateId: proposed.candidateId,
    expectedRevision: view.candidate.revision,
    expectedTargetDigest: view.target.digest,
    reviewSummary: '已核对候选内容与目标差异，确认写入新分片',
  });
  assert.equal(published.ok, true, JSON.stringify(published));
  assert.equal(published.committed, true);
  assert.ok(fs.readFileSync(shard('ops-team'), 'utf8').includes('deploy-check'));
  assert.equal((await getCard({ identity: 'ops-team::deploy-check' })).ok, true);
});

test('proposal parser accepts any legal agent name and rejects illegal shapes', () => {
  const block = (agent) => [
    '[KNOWLEDGE_STORE]',
    `索引：kc--${agent}-note--sample-card | agents-fixture | 摘要`,
    '正文',
    '[/KNOWLEDGE_STORE]',
  ].join('\n');
  const ok = parseProposals(block('ops-team'));
  assert.equal(ok.proposals.length, 1, JSON.stringify(ok.diagnostics));
  assert.equal(ok.proposals[0].agent, 'ops-team');

  for (const bad of ['../escape', 'Bad Name', 'a/b', 'con']) {
    const parsed = parseProposals(block(bad));
    assert.equal(parsed.proposals.length, 0, `应拒绝 ${bad}`);
    // 拒绝面可能落在索引行格式（分隔符/空格）或 agent 形状校验，两者都必须留可见诊断
    assert.ok(parsed.diagnostics.length > 0, `${bad} 应留下诊断`);
    assert.ok(
      parsed.diagnostics.some((d) => d.kind === 'incomplete_card' || d.kind === 'bad_index_line'),
      `${bad} 诊断类型异常：${JSON.stringify(parsed.diagnostics)}`,
    );
  }
  // 大写字母按历史行为归一化为小写后接受（归一化后仍是合法形状，不产生路径风险）
  const upper = parseProposals(block('Ops-Team'));
  assert.equal(upper.proposals.length, 1);
  assert.equal(upper.proposals[0].agent, 'ops-team');
});

test('delete and stats see the new agent through directory discovery', async () => {
  await seed('field-notes', 'to-delete');
  const removed = await deleteCards({ ids: ['to-delete'], agent: 'field-notes', reason: 'fixture cleanup', confirm: true });
  assert.equal(removed.details.ok, true, JSON.stringify(removed.details));
  assert.equal(removed.details.removedCount, 1);
  assert.equal((await getCard({ identity: 'field-notes::to-delete' })).code, 'CARD_NOT_FOUND');

  // 统计工具按 index.json 的复合键工作；重建索引后新分片才会进入索引。
  await io.rebuildIndexSerialized();
  // 先用检索工具跑一次，让它写出 stats.json（stats 是检索旁路，不是读卡必需）。
  const heated = await queryExecute({ keywords: 'agents-fixture', agent: 'ops-team' });
  assert.equal(heated.details.total, 1);
  const statsOut = await stats({ agent: 'ops-team' });
  assert.equal(typeof statsOut, 'string');
  assert.ok(statsOut.includes('ops-team'), `统计结果应包含新 agent 的卡片：${statsOut}`);
  assert.ok(!statsOut.includes('ming'), '统计结果不应出现未使用的团队名');
});

test('agent name validation rejects traversal, absolute paths, devices and reserved names', () => {
  const rejected = [
    '', 'all', 'All', '../escape', '..\\escape', 'a/b', 'a\\b', 'C:\\temp', '/etc/passwd',
    '.hidden', 'name.', 'con', 'CON', 'nul', 'com1', 'lpt9', 'has space', 'has_underscore',
    'UPPER', '-leading', 'trailing-', 'double--hyphen', 'x'.repeat(65),
  ];
  for (const name of rejected) assert.equal(io.isValidAgent(name), false, `应拒绝 ${JSON.stringify(name)}`);
  const accepted = ['hanako', 'cross', 'research-lab', 'ops-team', 'a', 'a1-b2-c3', 'x'.repeat(64)];
  for (const name of accepted) assert.equal(io.isValidAgent(name), true, `应接受 ${JSON.stringify(name)}`);
  // 非字符串
  for (const value of [null, undefined, 42, {}, [], true]) assert.equal(io.isValidAgent(value), false);
});

test('getJsonlPath never escapes the data directory for rejected names', () => {
  for (const bad of ['../escape', '..\\escape', 'C:\\temp\\x', '/etc/passwd', 'a/b']) {
    assert.throws(() => io.getJsonlPath(bad), /非法的 agent 名/);
  }
  const good = io.getJsonlPath('research-lab');
  assert.equal(path.dirname(path.resolve(good)), path.resolve(dataDir));
  assert.equal(path.basename(good), 'research-lab.notes.jsonl');
});

test('symlinked shard is ignored by discovery and never read', { skip: process.platform === 'win32' ? 'symlink 需要管理员权限，Windows 下跳过' : false }, async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-outside-'));
  const outsideFile = path.join(outside, 'evil.notes.jsonl');
  fs.writeFileSync(outsideFile, JSON.stringify({ agent: 'linked', id: 'leak', keywords: ['agents-fixture'], summary: '外部', content: '外部正文' }) + '\n');
  try {
    fs.symlinkSync(outsideFile, shard('linked'));
    const found = io.discoverShards();
    assert.equal(found.agents.includes('linked'), false, '符号链接分片不得进入发现结果');
    assert.ok(found.ignored.some((x) => x.name === 'linked.notes.jsonl' && x.reason.includes('符号链接')));
    assert.ok(found.ignored.some((x) => x.name === 'linked.notes.jsonl' && x.code === 'symlink'), '符号链接条目必须带 code=symlink');
    assert.equal(io.unsafeIgnoredEntries(found).some((x) => x.name === 'linked.notes.jsonl'), true, '符号链接属于不安全 ignored');
    const repo = readRepository({ includeInactive: true });
    assert.equal(repo.cards.some((c) => c.id === 'leak'), false, '符号链接内容不得进入仓库');
    assert.equal(repo.complete, false, '被忽略的分片必须让完整性标记为不完整');
    assert.ok(repo.diagnostics.some((d) => d.code === 'shard-ignored'));
  } finally {
    try { fs.unlinkSync(shard('linked')); } catch {}
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('non-shard files and illegal shard names in the data dir are ignored, not fatal', async () => {
  fs.writeFileSync(path.join(dataDir, 'notes.txt'), 'not a shard\n');
  fs.writeFileSync(path.join(dataDir, 'Bad Name.notes.jsonl'), '{}\n');
  const found = io.discoverShards();
  assert.equal(found.ok, true);
  assert.equal(found.agents.includes('Bad Name'), false);
  assert.ok(found.ignored.some((x) => x.name === 'Bad Name.notes.jsonl'));
  assert.ok(!found.ignored.some((x) => x.name === 'notes.txt'), '非分片后缀文件不应进入 ignored 列表');
  // 合法分片仍然可读
  assert.equal((await getCard({ identity: 'research-lab::first-note' })).ok, true);
});

test('legacy shards with old legal names stay readable without migration', async () => {
  // 旧库里的合法名字（此处用 hanako/cross 之外的任意名字模拟历史数据）必须继续可读
  const legacy = path.join(dataDir, 'legacy-team.notes.jsonl');
  fs.writeFileSync(legacy, JSON.stringify({ agent: 'legacy-team', id: 'old-card', keywords: ['legacy'], summary: '旧卡', content: '旧正文' }) + '\n');
  const repo = readRepository({ includeInactive: true });
  assert.equal(repo.cards.some((c) => c.identity === 'legacy-team::old-card'), true);
  const view = await getCard({ identity: 'legacy-team::old-card' });
  assert.equal(view.ok, true);
  assert.equal(view.card.content, '旧正文');
});

test('identity parsing accepts composite and archive forms, rejects lookalikes', async () => {
  const { parseIdentityText } = await import('../app/lib/retrieval.js');
  assert.deepEqual(parseIdentityText('ops-team::deploy-check'), { agent: 'ops-team', id: 'deploy-check' });
  assert.deepEqual(parseIdentityText('kc--ops-team-note--deploy-check'), { agent: 'ops-team', id: 'deploy-check' });
  assert.deepEqual(parseIdentityText('kc--ops-team--note--deploy-check'), { agent: 'ops-team', id: 'deploy-check' });
  // agent 自身含 -note- 时取最长合法切分
  assert.deepEqual(parseIdentityText('kc--note-keeper-note--deep-card'), { agent: 'note-keeper', id: 'deep-card' });
  for (const bad of ['https://example.com/x', 'ops-team::Deploy', 'ops-team::a/b', '../x::y', 'plain-id', '']) {
    assert.equal(parseIdentityText(bad), null, `不应解析 ${JSON.stringify(bad)}`);
  }
});

// ── 扫描上限（257 分片）：部分库不得被当成完整库 ─────────────
// 独立数据目录 + 子进程：configureDataRoot 是单例，同一进程内无法切换数据根，
// 所以 repository / reindex / delete 的集成行为必须在一个全新的 Node 进程里跑。
test('shard discovery cap: 257 shards makes the library incomplete, reindex and delete refuse', async () => {
  const capRoot = fs.mkdtempSync(path.join(root, '.fixture-cap-'));
  const capData = path.join(capRoot, 'data');
  fs.mkdirSync(capData, { recursive: true });
  const total = io.MAX_SHARD_FILES + 1; // 257
  for (let i = 0; i < total; i++) {
    const agent = `shard-${String(i).padStart(3, '0')}`;
    fs.writeFileSync(
      path.join(capData, `${agent}.notes.jsonl`),
      JSON.stringify({ agent, id: 'card', keywords: ['cap'], summary: `摘要 ${i}`, content: `正文 ${i}` }) + '\n',
    );
  }
  try {
    // 全部断言都在子进程内完成：discoverShards / listShardAgents / repository / reindex / delete
    // 都读「当前已配置的数据根」，而本进程的数据根是另一个 fixture，无法切换。
    const script = `
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
// Windows 上 ESM 动态 import 必须用 file:// URL，不能直接给盘符路径。
const app = (p) => pathToFileURL(${JSON.stringify(path.join(root, 'app'))} + '/' + p).href;
const dataDir = ${JSON.stringify(capData)};
const { configureDataRoot } = await import(app('lib/io-root.js'));
configureDataRoot(${JSON.stringify(capRoot)});
const io = await import(app('lib/jsonl-io.js'));
const out = { maxShardFiles: io.MAX_SHARD_FILES };

const found = io.discoverShards();
out.discoverOk = found.ok;
out.discoverTruncated = found.truncated;
out.discoverCount = found.agents.length;

try { io.listShardAgents(); out.listThrew = null; }
catch (e) { out.listThrew = e.code; }

try { io.readAllCardsWithStats(); out.statsThrew = null; }
catch (e) { out.statsThrew = e.code; }

const { readRepository } = await import(app('lib/repository.js'));
const repo = readRepository({ includeInactive: true });
out.repoOk = repo.ok;
out.repoComplete = repo.complete;
out.repoTotal = repo.total;
out.repoDiag = repo.diagnostics.map(d => d.code);

const { execute: reindex } = await import(app('tools/knowledge-reindex.js'));
const indexFile = dataDir + '/index.json';
out.indexBefore = fs.existsSync(indexFile);
const re = await reindex({});
out.reindexIsError = re.isError === true;
out.reindexCode = re.details && re.details.code;
out.indexAfter = fs.existsSync(indexFile);

const { execute: del } = await import(app('tools/knowledge-delete.js'));
const shardFile = dataDir + '/shard-000.notes.jsonl';
const before = fs.readFileSync(shardFile);
const dr = await del({ ids: ['card'], agent: 'shard-000', reason: 'cap probe', confirm: true });
out.deleteIsError = dr.isError === true;
out.deleteCode = dr.details && dr.details.code;
out.deleteRemoved = dr.details && dr.details.removedCount;
out.shardUnchanged = Buffer.compare(fs.readFileSync(shardFile), before) === 0;

process.stdout.write('__RESULT__' + JSON.stringify(out));
`;
    const { execFileSync } = await import('node:child_process');
    const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root,
      encoding: 'utf8',
      timeout: 120000,
    });
    const marker = stdout.lastIndexOf('__RESULT__');
    assert.ok(marker >= 0, `子进程未返回结果：${stdout.slice(-400)}`);
    const r = JSON.parse(stdout.slice(marker + '__RESULT__'.length));

    // 0. 确认上限确实是 256，且库里有 257 个
    assert.equal(r.maxShardFiles, 256, `扫描上限变更：${r.maxShardFiles}（本用例按 257 分片设计）`);
    assert.equal(total, r.maxShardFiles + 1);

    // 1. 发现层：ok=true 但 truncated=true，只看到 MAX_SHARD_FILES 个
    assert.equal(r.discoverOk, true);
    assert.equal(r.discoverTruncated, true, '超过上限必须标记 truncated');
    assert.equal(r.discoverCount, r.maxShardFiles);

    // 2. listShardAgents 必须抛 SHARD_DISCOVERY_TRUNCATED
    assert.equal(r.listThrew, 'SHARD_DISCOVERY_TRUNCATED', 'listShardAgents 在 truncated 时必须抛 SHARD_DISCOVERY_TRUNCATED');

    // 3. readAllCardsWithStats 不得降级为空 Map
    assert.equal(r.statsThrew, 'SHARD_DISCOVERY_TRUNCATED', 'readAllCardsWithStats 在 truncated 时不得返回空 Map');

    // 4. repository：不得把部分库当完整库
    assert.equal(r.repoOk, true);
    assert.equal(r.repoComplete, false, '257 分片时 repository.complete 必须为 false');
    assert.equal(r.repoTotal, null, '不完整库不得报精确 total');
    assert.ok(r.repoDiag.includes('shard-discovery-truncated'), `缺 truncated 诊断：${r.repoDiag}`);

    // 5. reindex：必须拒绝，且不创建 index.json
    assert.equal(r.indexBefore, false, '前置条件：索引尚不存在');
    assert.equal(r.reindexIsError, true, 'reindex 必须报错');
    assert.equal(r.reindexCode, 'INDEX_REBUILD_FAILED', `reindex 错误码异常：${r.reindexCode}`);
    assert.equal(r.indexAfter, false, 'reindex 拒绝时不得写 index.json');

    // 6. delete：整库拒绝，且不改任何分片
    assert.equal(r.deleteIsError, true, 'delete 必须报错');
    assert.equal(r.deleteCode, 'SHARD_DISCOVERY_TRUNCATED', `delete 错误码异常：${r.deleteCode}`);
    // 拒绝路径不产生删除计数（undefined 或 0 都可接受，但不能是正数——那意味着已改动数据）
    assert.ok(r.deleteRemoved === undefined || r.deleteRemoved === 0, `delete 拒绝时不得报告已删除数量：${r.deleteRemoved}`);
    assert.equal(r.shardUnchanged, true, 'delete 拒绝时不得改动分片字节');
  } finally {
    assert.ok(capRoot.startsWith(path.join(root, '.fixture-cap-')));
    fs.rmSync(capRoot, { recursive: true, force: true });
  }
});

test('readAllCardsWithStats never turns an unreadable library into an empty Map', async () => {
  // 用一个不存在的子目录模拟「目录读不了」：这里用文件占位一个「数据目录路径是文件」的错误形态，
  // 子进程内切换数据根验证（configureDataRoot 是单例）。
  const badRoot = fs.mkdtempSync(path.join(root, '.fixture-badstats-'));
  // 把数据目录位置占成一个普通文件：readdir 会 ENOTDIR 而不是 ENOENT，属于「不可读」而非「空库」。
  fs.writeFileSync(path.join(badRoot, 'data'), 'not a directory');
  try {
    const script = `
import { pathToFileURL } from 'node:url';
const app = (p) => pathToFileURL(${JSON.stringify(path.join(root, 'app'))} + '/' + p).href;
const { configureDataRoot } = await import(app('lib/io-root.js'));
configureDataRoot(${JSON.stringify(badRoot)});
const io = await import(app('lib/jsonl-io.js'));
const out = {};
try { io.readAllCardsWithStats(); out.threw = null; out.size = 'no-throw'; }
catch (e) { out.threw = e.code || e.message; }
try { io.listShardAgents(); out.listThrew = null; }
catch (e) { out.listThrew = e.code || e.message; }
const { readRepository } = await import(app('lib/repository.js'));
const repo = readRepository({ includeInactive: true });
out.repoComplete = repo.complete;
out.repoTotal = repo.total;
out.repoDiag = repo.diagnostics.map(d => d.code);
process.stdout.write('__RESULT__' + JSON.stringify(out));
`;
    const { execFileSync } = await import('node:child_process');
    const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, encoding: 'utf8', timeout: 60000 });
    const marker = stdout.lastIndexOf('__RESULT__');
    assert.ok(marker >= 0, `子进程未返回结果：${stdout.slice(-300)}`);
    const r = JSON.parse(stdout.slice(marker + '__RESULT__'.length));

    assert.notEqual(r.threw, null, 'readAllCardsWithStats 在数据目录不可读时必须抛错，不能返回空 Map');
    assert.equal(r.listThrew, 'DATA_DIR_UNREADABLE', `listShardAgents 错误码异常：${r.listThrew}`);
    assert.equal(r.repoComplete, false, '不可读库必须报 complete=false');
    assert.equal(r.repoTotal, null, '不可读库不得报 total');
    assert.ok(r.repoDiag.includes('data-dir-unreadable'), `缺 data-dir-unreadable 诊断：${r.repoDiag}`);
  } finally {
    assert.ok(badRoot.startsWith(path.join(root, '.fixture-badstats-')));
    fs.rmSync(badRoot, { recursive: true, force: true });
  }
});

test.after(() => {
  assert.ok(fixture.startsWith(path.join(root, '.fixture-agents-')), '只删除本测试自建的目录');
  fs.rmSync(fixture, { recursive: true, force: true });
});
