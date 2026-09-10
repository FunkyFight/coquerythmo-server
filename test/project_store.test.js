const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { ProjectStore, StorageBudget } = require('../src/project_store');

const bytes = Buffer.from('a project with several chunks');
function metadata(request_id = 'project_one', content = bytes) {
  return { request_id, project_huuid: 'project-id', file_name: 'test.coquerythmo',
    total_bytes: content.length, total_chunks: Math.ceil(content.length / 8),
    chunk_size: 8, sha1: createHash('sha1').update(content).digest('hex') };
}
async function fixture(t, budget = new StorageBudget(1024)) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'coquerythmo-store-test-'));
  const store = new ProjectStore(root, budget);
  t.after(async () => { await store.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  return store;
}
async function upload(store, meta = metadata(), content = bytes) {
  await store.begin(meta);
  for (let index = 0; index < meta.total_chunks; index++) {
    await store.write(meta.request_id, index, content.subarray(index * 8, (index + 1) * 8).toString('base64'));
  }
  return store.finish(meta.request_id);
}

test('project is downloadable only after server verifies the complete file', async t => {
  const store = await fixture(t);
  await store.begin(metadata());
  await assert.rejects(store.read('project_one', 0), /not_ready/);
  await upload(store);
  const downloaded = [];
  for (let i = 0; i < metadata().total_chunks; i++) downloaded.push(Buffer.from((await store.read('project_one', i)).data, 'base64'));
  assert.deepEqual(Buffer.concat(downloaded), bytes);
});

test('lost acknowledgements and reconnect resume without rewriting accepted chunks', async t => {
  const store = await fixture(t);
  const meta = metadata();
  await store.begin(meta);
  const data = bytes.subarray(0, 8).toString('base64');
  assert.equal((await store.write(meta.request_id, 0, data)).next_index, 1);
  assert.equal((await store.write(meta.request_id, 0, data)).next_index, 1);
  assert.equal((await store.begin(meta)).next_index, 1);
  await assert.rejects(store.write(meta.request_id, 0, Buffer.from('xxxxxxxx').toString('base64')), /chunk_conflict/);
  await assert.rejects(store.write(meta.request_id, 2, data), /out_of_order/);
  await upload(store);
  assert.equal((await store.finish(meta.request_id)).complete, true);
});

test('wrong hashes and chunk geometry never publish a corrupt project', async t => {
  const store = await fixture(t);
  const meta = { ...metadata(), sha1: 'a'.repeat(40) };
  await store.begin(meta);
  await assert.rejects(store.write(meta.request_id, 0, Buffer.from('tiny').toString('base64')), /chunk_size/);
  await assert.rejects(upload(store, meta), /checksum/);
  assert.equal(store.metadata, null);
  await assert.rejects(store.read(meta.request_id, 0), /not_ready/);
});

test('rooms have independent storage and release reservations and files when empty', async t => {
  const budget = new StorageBudget(bytes.length * 2);
  const one = await fixture(t, budget);
  const two = await fixture(t, budget);
  await upload(one);
  await upload(two);
  assert.equal(budget.usedBytes, bytes.length * 2);
  await one.dispose();
  assert.equal(budget.usedBytes, bytes.length);
  await assert.rejects(one.read('project_one', 0), /closed/);
  assert.deepEqual(Buffer.from((await two.read('project_one', 0)).data, 'base64'), bytes.subarray(0, 8));
  await two.dispose();
  assert.equal(budget.usedBytes, 0);
});

test('quota rejection preserves the existing published project', async t => {
  const store = await fixture(t, new StorageBudget(bytes.length));
  await upload(store);
  await assert.rejects(store.begin(metadata('replacement', Buffer.alloc(bytes.length + 1))), /quota/);
  assert.equal(store.metadata.request_id, 'project_one');
});

test('duplicate upload id with changed metadata and unsafe filenames are rejected', async t => {
  const store = await fixture(t);
  await store.begin(metadata());
  await assert.rejects(store.begin({ ...metadata(), sha1: 'b'.repeat(40) }), /metadata_conflict/);
  await assert.rejects(store.begin({ ...metadata('bad'), file_name: '../test.coquerythmo' }), /file name/);
});

test('disposing during a pending write cannot resurrect the room file', async t => {
  const store = await fixture(t);
  await store.begin(metadata());
  const write = store.write('project_one', 0, bytes.subarray(0, 8).toString('base64'));
  const dispose = store.dispose();
  await Promise.allSettled([write, dispose]);
  assert.equal(store.budget.usedBytes, 0);
  assert.deepEqual(await fs.readdir(store.root), []);
});

test('reusing an identical archive preserves the id used by active downloads', async t => {
  const store = await fixture(t);
  await upload(store);
  const reused = await store.begin(metadata('second_invitation'));
  assert.equal(reused.complete, true);
  assert.equal(reused.metadata.request_id, 'project_one');
  assert.equal(store.budget.usedBytes, bytes.length);
  assert.equal((await store.read('project_one', 1)).index, 1);
});
