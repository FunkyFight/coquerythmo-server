const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Room } = require('../src/room');
const { RoomProtocol } = require('../src/room_protocol');

test('preparing or aborting a replacement leaves the published project downloadable', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'coquerythmo-protocol-test-'));
  const protocol = new RoomProtocol(root, () => {});
  const director = { id: 'director', emit() {} };
  const actor = { id: 'actor', emit() {} };
  const room = new Room('ROOM', director, 'DA', 'original', 'director-session');
  room.addMember(actor, 'Actor', 'actor', 'actor-session');
  protocol.attach(room);
  t.after(async () => { await room.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  const data = Buffer.from('original archive');
  const metadata = { request_id: 'original', project_huuid: 'original', file_name: 'project.coquerythmo',
    total_bytes: data.length, chunk_size: 8, total_chunks: 2, sha1: createHash('sha1').update(data).digest('hex') };
  const call = (socket, method, body) => protocol.dispatch(room, socket, method, body);
  await call(director, 'project_begin', metadata);
  for (let index = 0; index < 2; index++) await call(director, 'project_write', {
    request_id: 'original', index, data: data.subarray(index * 8, (index + 1) * 8).toString('base64') });
  await call(director, 'project_commit', { request_id: 'original' });
  await call(actor, 'project_response', { request_id: 'original', response: 'accepted' });
  await call(director, 'project_begin', { ...metadata, request_id: 'replacement', project_huuid: 'replacement' });
  assert.equal((await call(actor, 'project_read', { request_id: 'original', index: 1 })).index, 1);
  const offers = [];
  const late = { id: 'late', emit(event, body) { if (event === 'project_transfer_request') offers.push(body); } };
  room.addMember(late, 'Late', 'actor', 'late-session');
  protocol.join(room, late);
  assert.equal(offers[0].request_id, 'original');
  await call(director, 'project_abort', { request_id: 'replacement' });
  await call(late, 'project_response', { request_id: 'original', response: 'accepted' });
  assert.equal((await call(late, 'project_read', { request_id: 'original', index: 0 })).index, 0);
});
