import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const top = ['app', 'tests', 'scripts', 'docs'];
const files = ['README.md', 'LICENSE', 'NOTICE', 'package.json', '.gitignore'].map(x => path.join(root, x));
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    assert(!entry.isSymbolicLink(), 'symlink: ' + path.relative(root, p));
    if (entry.isDirectory()) walk(p); else files.push(p);
  }
}
for (const item of top) walk(path.join(root, item));
const forbiddenFiles = /(?:\.jsonl|\.log|\.map|\.bak|\.zip|\.exe|\.png|\.jpe?g)$/i;
// These are value-pattern checks, not a claim to detect every possible secret.
const patterns = [
  /[A-Za-z]:\\(?:Users|hana-home|AI!!!|TRPG|跑团)/i,
  /\/Users\/[^\s/]+|\/home\/[^\s/]+/,
  /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{24,})/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /(?:api[_-]?key|password|authorization)\s*[:=]\s*['"][^'"\s]{16,}['"]/i,
];
let bytes = 0;
for (const p of files) {
  const rel = path.relative(root, p).split(path.sep).join('/');
  assert(!forbiddenFiles.test(rel), 'unexpected release file: ' + rel);
  assert(!/(^|\/)(?:data|app-data|candidates|backups|deleted|locks|publish-receipts|node_modules|\.git)(\/|$)/.test(rel), 'runtime content: ' + rel);
  const text = fs.readFileSync(p, 'utf8'); bytes += Buffer.byteLength(text);
  if (rel !== 'scripts/audit-release.mjs') for (const pattern of patterns) assert(!pattern.test(text), 'sensitive value pattern: ' + rel);
}
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'app/manifest.json'), 'utf8'));
assert.equal(manifest.id, 'kc-system'); assert.equal(manifest.version, '1.0.0'); assert.equal(manifest.entry, 'index.js');
assert.equal(manifest.manifestVersion, 2);
assert(fs.existsSync(path.join(root, 'app', manifest.icon)));
for (const card of manifest.contributes.cards) {
  assert(fs.existsSync(path.join(root, 'app/ui', card.route.replace(/^\//, ''))));
  assert(fs.existsSync(path.join(root, 'app/ui', card.face.image)));
  assert(fs.existsSync(path.join(root, 'app/ui', card.pageIcon)));
}
console.log(JSON.stringify({ ok: true, files: files.length, bytes, version: manifest.version, preloadedRuntimeData: false }));
