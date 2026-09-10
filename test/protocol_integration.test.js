const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

process.env.PORT = '0';
process.env.PASSWORD = '';
const { httpServer, io, roomProtocol, shutdown } = require('../src/index');
const { rooms } = require('../src/room');

// Exercise the actual WebSocket/Engine.IO/Socket.IO wire protocol without a
// second client library hiding ordering or reconnection behavior.
async function connect() {
  if (!httpServer.listening) await new Promise(resolve => httpServer.once('listening', resolve));
  const ws = new WebSocket(`ws://127.0.0.1:${httpServer.address().port}/socket.io/?EIO=4&transport=websocket`);
  const messages = [];
  const waiters = [];
  let counter = 0;
  const client = {
    ws,
    send(event, data) { ws.send(`42${JSON.stringify([event, data])}`); },
    event(event, predicate = () => true) {
      const found = messages.findIndex(([name, value]) => name === event && predicate(value));
      if (found >= 0) return Promise.resolve(messages.splice(found, 1)[0][1]);
      return new Promise((resolve, reject) => {
        const waiter = { event, predicate, resolve: value => { clearTimeout(timer); resolve(value); } };
        const timer = setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(new Error(`Timed out waiting for ${event}`)); }, 5000);
        waiters.push(waiter);
      });
    },
    async rpc(method, body = {}) {
      const id = `rpc_${++counter}`;
      const reply = client.event('protocol_reply', data => data.id === id);
      client.send('protocol_request', { id, method, body });
      const result = await reply;
      if (!result.ok) throw new Error(result.error);
      return result.body;
    },
    async close() {
      if (ws.readyState === WebSocket.CLOSED) return;
      const closed = new Promise(resolve => ws.addEventListener('close', resolve, { once: true }));
      ws.close();
      await closed;
    },
  };
  function deliver(name, value) {
    const i = waiters.findIndex(waiter => waiter.event === name && waiter.predicate(value));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(value);
    else messages.push([name, value]);
  }
  ws.addEventListener('message', ({ data }) => {
    if (data.startsWith('0')) ws.send('40' + JSON.stringify({ password: '', protocol_version: 2 }));
    else if (data === '2') ws.send('3');
    else if (data.startsWith('40')) deliver('connected', {});
    else if (data.startsWith('42')) { const [name, value] = JSON.parse(data.slice(2)); deliver(name, value); }
    else if (data.startsWith('44')) deliver('connection_error', JSON.parse(data.slice(2)));
  });
  await client.event('connected');
  return client;
}

test.after(shutdown);

test('one upload serves independent, resumable downloads and is removed when the last participant leaves', async t => {
  const director = await connect();
  const actor = await connect();
  t.after(() => Promise.all([director.close(), actor.close()]));
  director.send('create_room', { username: 'DA', project_huuid: 'project', session_id: 'director-session' });
  const created = await director.event('room_created');
  actor.send('join_room', { code: created.code, username: 'Actor', session_id: 'actor-session' });
  await actor.event('room_joined');
  const room = rooms.get(created.code);
  const data = Buffer.alloc(192 * 1024 + 17, 0x5a);
  const meta = { request_id: 'upload', file_name: 'project.coquerythmo', project_huuid: 'project', total_bytes: data.length,
    total_chunks: 2, chunk_size: 192 * 1024, sha1: createHash('sha1').update(data).digest('hex') };
  await assert.rejects(actor.rpc('project_begin', meta), /director_required/);
  assert.equal((await director.rpc('project_begin', meta)).next_index, 0);
  await assert.rejects(actor.rpc('project_read', { request_id: 'upload', index: 0 }), /unknown_project_transfer/);
  for (let index = 0; index < 2; index++) {
    const body = { request_id: 'upload', index, data: data.subarray(index * meta.chunk_size, (index + 1) * meta.chunk_size).toString('base64') };
    assert.equal((await director.rpc('project_write', body)).next_index, index + 1);
    assert.equal((await director.rpc('project_write', body)).next_index, index + 1);
  }
  await director.rpc('project_commit', { request_id: 'upload' });
  await actor.event('project_transfer_request');
  await actor.rpc('project_response', { request_id: 'upload', response: 'accepted' });
  const first = await actor.rpc('project_read', { request_id: 'upload', index: 0 });
  await actor.close();
  const returning = await connect();
  t.after(() => returning.close());
  returning.send('join_room', { code: created.code, username: 'Actor', session_id: 'actor-session' });
  await returning.event('room_joined');
  const second = await returning.rpc('project_read', { request_id: 'upload', index: 1 });
  assert.deepEqual(Buffer.concat([Buffer.from(first.data, 'base64'), Buffer.from(second.data, 'base64')]), data);
  await returning.rpc('project_result', { request_id: 'upload', success: true });
  await director.close();
  assert.equal((await returning.rpc('project_read', { request_id: 'upload', index: 0 })).data, first.data);
  const lastSocket = [...room.members.keys()][0];
  const serverDisconnected = new Promise(resolve => lastSocket.once('disconnect', resolve));
  await returning.close();
  await serverDisconnected;
  await room.cleanup;
  assert.equal(rooms.has(created.code), false);
  assert.equal(roomProtocol.budget.usedBytes, 0);
  assert.equal(require('node:fs').existsSync(room.networkServices.store.root), false);
});

test('room state rejects actor writes, retries exactly once and catches up after reconnect', async t => {
  const director = await connect();
  const actor = await connect();
  t.after(() => Promise.all([director.close(), actor.close()]));
  director.send('create_room', { username: 'DA', project_huuid: 'project', session_id: 'state-director' });
  const { code } = await director.event('room_created');
  actor.send('join_room', { code, username: 'Actor', session_id: 'state-actor' });
  await actor.event('room_joined');
  const update = { update_id: 'state_one', base_revision: 0, replace: true, changes: { manifest: { text: 'hello' } } };
  await assert.rejects(actor.rpc('state_publish', update), /director_required/);
  assert.equal((await director.rpc('state_publish', update)).revision, 1);
  assert.equal((await director.rpc('state_publish', update)).revision, 1);
  assert.equal((await actor.rpc('state_pull', { since: 0 })).changes.manifest.text, 'hello');
  await actor.close();
  for (let revision = 1; revision <= 30; revision++) {
    await director.rpc('state_publish', { update_id: `edit${revision}`, base_revision: revision, replace: false,
      changes: { manifest: { text: `revision ${revision}` } } });
  }
  const reconnected = await connect();
  t.after(() => reconnected.close());
  reconnected.send('join_room', { code, username: 'Actor', session_id: 'state-actor' });
  await reconnected.event('room_joined');
  const catchup = await reconnected.rpc('state_pull', { since: 1 });
  assert.equal(catchup.revision, 31);
  assert.equal(catchup.changes.manifest.text, 'revision 30');
});
