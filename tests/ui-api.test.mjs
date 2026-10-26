import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = fs.mkdtempSync(path.join(root, '.fixture-ui-'));
const { configureDataRoot } = await import('../app/lib/io-root.js');
configureDataRoot(fixture);
fs.mkdirSync(path.join(fixture, 'data'), { recursive: true });
const hanako = Array.from({ length: 65 }, (_, i) => ({ agent: 'hanako', id: `card-${String(i).padStart(3, '0')}`, keywords: ['frontend', 'KC'], summary: `前端卡片 ${i}`, content: `正文 ${i}`, related: ['ming::card-000'] }));
fs.writeFileSync(path.join(fixture, 'data', 'hanako.notes.jsonl'), hanako.map(c => JSON.stringify(c)).join('\n') + '\n');
fs.writeFileSync(path.join(fixture, 'data', 'ming.notes.jsonl'), JSON.stringify({ ...hanako[0], agent: 'ming' }) + '\n');
const api = await import('../app/lib/ui-api.js');

test('browse and search paginate over all matches beyond the model tool limit', async () => {
  const first = await api.listCards({ q: 'frontend', limit: '30' });
  assert.equal(first.ok, true);
  assert.equal(first.total, 66);
  assert.equal(first.items.length, 30);
  const second = await api.listCards({ q: 'frontend', limit: '30', offset: '30', snapshotId: first.snapshotId });
  assert.equal(second.items.length, 30);
  assert.notEqual(first.items[0].identity, second.items[0].identity);
  const last = await api.listCards({ q: 'frontend', limit: '30', offset: '60', snapshotId: first.snapshotId });
  assert.equal(last.items.length, 6);
  assert.equal(last.nextOffset, null);
});

test('identity is composite; detail preserves related and warnings without writing heat', async () => {
  const detail = await api.getCard({ identity: 'ming::card-000' });
  assert.equal(detail.card.agent, 'ming');
  assert.deepEqual(detail.card.related, ['ming::card-000']);
  assert.ok(detail.card.warnings.some(s => s.includes('未核验')));
  assert.ok(detail.card.contentDigest.match(/^[a-f0-9]{64}$/));
  assert.equal(fs.existsSync(path.join(fixture, 'data', 'stats.json')), false);
  const missing = await api.getCard({ identity: 'ming::missing' });
  assert.equal(missing.code, 'CARD_NOT_FOUND');
});

test('filters and validation cannot silently produce an unfiltered full list', async () => {
  const filtered = await api.listCards({ agent: 'ming', status: 'legacy-unverified' });
  assert.equal(filtered.total, 1);
  assert.equal((await api.listCards({ agent: '../hanako' })).ok, false);
  assert.equal((await api.listCards({ status: 'made-up' })).ok, false);
  assert.equal((await api.listCards({ offset: '-1' })).ok, false);
});

test('snapshot changes return an explicit conflict', async () => {
  const before = await api.listCards({ limit: '2' });
  fs.appendFileSync(path.join(fixture, 'data', 'ming.notes.jsonl'), JSON.stringify({ ...hanako[0], agent: 'ming', id: 'another' }) + '\n');
  const changed = await api.listCards({ offset: '2', snapshotId: before.snapshotId });
  assert.equal(changed.ok, false);
  assert.equal(changed.code, 'KC_SNAPSHOT_CHANGED');
});

test('partial repository is never reported as a complete total or review target', async () => {
  fs.appendFileSync(path.join(fixture, 'data', 'ming.notes.jsonl'), '{broken\n');
  const result = await api.listCards({});
  assert.equal(result.complete, false);
  assert.equal(result.total, null);
  assert.ok(result.diagnostics.length > 0);
});

test.after(() => {
  // Delete only this test-owned directory, never HANA_HOME or a production path.
  assert.ok(fixture.startsWith(path.join(root, '.fixture-ui-')));
  fs.rmSync(fixture, { recursive: true, force: true });
});
