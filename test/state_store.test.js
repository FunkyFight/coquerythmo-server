const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { StateStore } = require('../src/state_store');

function patch(update_id, base_revision, changes, replace = false) {
  return { update_id, base_revision, changes, replace };
}
test('state updates are atomic, ordered and idempotent after an ACK is lost', () => {
  const store = new StateStore();
  const update = patch('one', 0, { manifest: { project: 'one' }, 'lang/1/line/7': { text: 'Bonjour' } }, true);
  assert.equal(store.publish(update).revision, 1);
  assert.equal(store.publish(update).revision, 1);
  assert.throws(() => store.publish(patch('one', 0, { manifest: {} }, true)), /conflict/);
  assert.throws(() => store.publish(patch('two', 0, { manifest: {} })), /revision_conflict/);
  assert.equal(store.pull(0).revision, 1);
  assert.equal(store.records.get('lang/1/line/7').text, 'Bonjour');
});
test('reconnected readers catch up additions, replacements and deletions in one revision', () => {
  const store = new StateStore();
  store.publish(patch('one', 0, { manifest: {}, 'lang/1/line/7': { text: 'old' } }, true));
  store.publish(patch('two', 1, { 'lang/1/line/7': { text: 'new' } }));
  store.publish(patch('three', 2, { 'lang/1/line/7': null, 'lang/1/markers': [10] }));
  const replay = store.pull(1);
  assert.equal(replay.revision, 3);
  assert.equal(replay.changes['lang/1/line/7'], null);
  assert.deepEqual(replay.changes['lang/1/markers'], [10]);
});
test('a slow snapshot reader sees an immutable snapshot while the director keeps editing', () => {
  const store = new StateStore();
  store.publish(patch('one', 0, { manifest: { text: 'original' } }, true));
  const snapshot = store.snapshotBegin('actor');
  store.publish(patch('two', 1, { manifest: { text: 'changed' } }));
  const chunk = store.snapshotRead('actor', snapshot.snapshot_id, 0);
  const records = JSON.parse(Buffer.from(chunk.data, 'base64'));
  assert.equal(records.manifest.text, 'original');
  assert.equal(store.pull(snapshot.revision).changes.manifest.text, 'changed');
  assert.throws(() => store.snapshotRead('outsider', snapshot.snapshot_id, 0), /snapshot_not_open/);
  store.snapshotEnd('actor', snapshot.snapshot_id);
});
test('invalid records and quota overflows preserve the previous state', () => {
  const store = new StateStore({ maxBytes: 256 });
  store.publish(patch('one', 0, { manifest: {} }, true));
  assert.throws(() => store.publish(patch('two', 1, { '__proto__/x': {} })), /record_key/);
  assert.throws(() => store.publish(patch('three', 1, { manifest: 'x'.repeat(300) })), /size_limit/);
  assert.equal(store.revision, 1);
  assert.deepEqual(store.records.get('manifest'), {});
});
test('large updates are staged and checksum-verified before their single commit', () => {
  const store = new StateStore();
  const bytes = Buffer.from(JSON.stringify(patch('bulk', 0, { manifest: { text: 'x'.repeat(400_000) } }, true)));
  const info = { update_id: 'bulk', total_bytes: bytes.length, sha1: createHash('sha1').update(bytes).digest('hex') };
  store.uploadBegin('director', info);
  assert.equal(store.revision, 0);
  const chunkSize = 192 * 1024;
  for (let index = 0; index < Math.ceil(bytes.length / chunkSize); index++) {
    const data = bytes.subarray(index * chunkSize, (index + 1) * chunkSize).toString('base64');
    store.uploadChunk('director', 'bulk', index, data);
    store.uploadChunk('director', 'bulk', index, data);
  }
  assert.equal(store.uploadCommit('director', 'bulk').revision, 1);
  assert.equal(store.uploadCommit('director', 'bulk').revision, 1);
  assert.equal(store.records.get('manifest').text.length, 400_000);
});
test('expired journals explicitly require a new snapshot, never a partial replay', () => {
  const store = new StateStore({ journalEntries: 2 });
  for (let i = 0; i < 4; i++) store.publish(patch(`update${i}`, i, { manifest: { i } }, i === 0));
  assert.equal(store.pull(1).snapshot_required, true);
  assert.equal(store.pull(3).changes.manifest.i, 3);
});

test('a slow reader never pins a new reader to an obsolete snapshot', () => {
  const { StorageBudget } = require('../src/project_store');
  const budget = new StorageBudget(1024 * 1024);
  const store = new StateStore({ budget });
  store.publish(patch('one', 0, { manifest: { text: 'old' } }, true));
  const slow = store.snapshotBegin('slow');
  store.publish(patch('two', 1, { manifest: { text: 'latest' } }));
  const fast = store.snapshotBegin('fast');
  assert.equal(fast.revision, 2);
  assert.equal(store.snapshotBegin('slow').snapshot_id, slow.snapshot_id);
  assert.equal(store.snapshotBegin('another-fast').snapshot_id, fast.snapshot_id);
  assert.equal(JSON.parse(Buffer.from(store.snapshotRead('slow', slow.snapshot_id, 0).data, 'base64')).manifest.text, 'old');
  assert.equal(JSON.parse(Buffer.from(store.snapshotRead('fast', fast.snapshot_id, 0).data, 'base64')).manifest.text, 'latest');
  store.snapshotEnd('slow', slow.snapshot_id);
  store.dispose();
  assert.equal(budget.usedBytes, 0);
});
