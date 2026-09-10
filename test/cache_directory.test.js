const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCacheDirectory } = require('../src/cache_directory');

test('startup removes only marked caches of dead processes and preserves active servers', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'coquerythmo-cache-test-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const stale = createCacheDirectory(base);
  fs.writeFileSync(path.join(stale, 'archive.part'), 'interrupted upload');
  const unowned = path.join(path.dirname(stale), 'unrelated');
  fs.mkdirSync(unowned);
  fs.writeFileSync(path.join(unowned, 'keep'), 'user file');
  const active = createCacheDirectory(base, () => false);
  assert.equal(fs.existsSync(stale), false);
  const next = createCacheDirectory(base, () => true);
  assert.equal(fs.existsSync(active), true);
  assert.equal(fs.existsSync(next), true);
  assert.equal(fs.readFileSync(path.join(unowned, 'keep'), 'utf8'), 'user file');
});
