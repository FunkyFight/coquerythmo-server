const test = require('node:test');
const assert = require('node:assert/strict');

const { createRoom, joinRoom, rooms } = require('../src/room');

function fakeSocket(id) {
  return {
    id,
    roomCode: null,
    emitted: [],
    emit(event, payload) {
      this.emitted.push([event, payload]);
    },
  };
}

test.afterEach(() => rooms.clear());

test('a room admits a participant with a different project HUUID', () => {
  const admin = fakeSocket('admin');
  const actor = fakeSocket('actor');
  const room = createRoom(admin, 'DA', 'Coquerythmo-3.6.0-A');

  const result = joinRoom(actor, room.code, 'Comédien', 'Coquerythmo-3.6.0-B');

  assert.equal(result.room, room);
  assert.equal(result.projectMatches, false);
  assert.equal(room.members.size, 2);
  assert.equal(actor.roomCode, room.code);
});

test('a participant may join without a project HUUID', () => {
  const admin = fakeSocket('admin');
  const actor = fakeSocket('actor');
  const room = createRoom(admin, 'DA', 'same-project');

  const result = joinRoom(actor, room.code, 'Comédien', undefined);

  assert.equal(result.room, room);
  assert.equal(result.projectMatches, false);
});

test('project transfer targets the current non-directors and waits for every response', () => {
  const admin = fakeSocket('admin');
  const actor = fakeSocket('actor');
  const coDirector = fakeSocket('co-director');
  const room = createRoom(admin, 'DA', 'same-project');
  joinRoom(actor, room.code, 'Comédien', 'old-project');
  joinRoom(coDirector, room.code, 'Co-DA', 'same-project');
  room.setCoDirector(coDirector.id, true);

  const metadata = {
    request_id: 'project_1', project_huuid: 'new-project', file_name: 'new.coquerythmo',
    total_bytes: 4, total_chunks: 1, chunk_size: 192 * 1024, sha1: 'a'.repeat(40),
  };
  const begun = room.beginProjectTransfer(admin, metadata, 1000);
  assert.equal(Object.keys(begun.transfer.participants).length, 2);
  assert.equal(room.projectTransferResponse(actor, 'project_1', 'accepted').transfer.phase, 'collecting');
  assert.equal(room.projectTransferResponse(coDirector, 'project_1', 'refused').transfer.phase, 'transferring');
  assert.deepEqual(begun.transfer.acceptedIds, [actor.id]);
  const active = room.projectTransfer;
  active.streamEnded = true;
  active.phase = 'finishing';
  room.projectTransferResult(actor, 'project_1', true);
  assert.equal(room.projectHuuid, 'new-project');
});

test('project transfer expires unanswered participants and sends nothing when all refuse', () => {
  const admin = fakeSocket('admin');
  const actor = fakeSocket('actor');
  const room = createRoom(admin, 'DA', 'same-project');
  joinRoom(actor, room.code, 'Comédien', undefined);
  const metadata = {
    request_id: 'project_2', project_huuid: 'new-project', file_name: 'new.coquerythmo',
    total_bytes: 1, total_chunks: 1, chunk_size: 192 * 1024, sha1: 'a'.repeat(40),
  };
  room.beginProjectTransfer(admin, metadata, 1000);
  assert.equal(room.projectHuuid, 'same-project');
  assert.equal(room.expireProjectTransferResponses(60_999), false);
  assert.equal(room.expireProjectTransferResponses(61_000), true);
  assert.equal(room.projectTransfer.phase, 'completed');
  assert.equal(room.projectTransfer.acceptedIds, undefined);

  const next = fakeSocket('next');
  joinRoom(next, room.code, 'Tardif', undefined);
  assert.equal(room.projectTransfer.participants[next.id], undefined);
});

test('a refusing participant cannot report a loaded project', () => {
  const admin = fakeSocket('admin');
  const actor = fakeSocket('actor');
  const room = createRoom(admin, 'DA', 'same-project');
  joinRoom(actor, room.code, 'Comédien', undefined);
  const metadata = {
    request_id: 'project_3', project_huuid: 'new-project', file_name: 'new.coquerythmo',
    total_bytes: 1, total_chunks: 1, chunk_size: 192 * 1024, sha1: 'a'.repeat(40),
  };
  room.beginProjectTransfer(admin, metadata, 1000);
  room.projectTransferResponse(actor, 'project_3', 'refused');
  assert.equal(room.projectTransferResult(actor, 'project_3', true).error, 'project_transfer_recipient_not_accepted');
});

test('a duplicate terminal project result is idempotent after completion', () => {
  const admin = fakeSocket('admin');
  const actor = fakeSocket('actor');
  const room = createRoom(admin, 'DA', 'same-project');
  joinRoom(actor, room.code, 'Comédien', undefined);
  const metadata = {
    request_id: 'project_4', project_huuid: 'new-project', file_name: 'new.coquerythmo',
    total_bytes: 1, total_chunks: 1, chunk_size: 192 * 1024, sha1: 'a'.repeat(40),
  };
  room.beginProjectTransfer(admin, metadata);
  room.projectTransferResponse(actor, 'project_4', 'accepted');
  room.projectTransfer.streamEnded = true;
  room.projectTransfer.phase = 'finishing';
  assert.equal(room.projectTransferResult(actor, 'project_4', true).error, undefined);
  assert.equal(room.projectTransfer.phase, 'completed');
  assert.equal(room.projectTransferResult(actor, 'project_4', true).error, undefined);
});

test('project loading is visible and still reaches a terminal state', () => {
  const admin = fakeSocket('admin');
  const actor = fakeSocket('actor');
  const room = createRoom(admin, 'DA', 'same-project');
  joinRoom(actor, room.code, 'ComÃ©dien', undefined);
  const metadata = {
    request_id: 'project_5', project_huuid: 'new-project', file_name: 'new.coquerythmo',
    total_bytes: 1, total_chunks: 1, chunk_size: 192 * 1024, sha1: 'a'.repeat(40),
  };
  room.beginProjectTransfer(admin, metadata);
  room.projectTransferResponse(actor, 'project_5', 'accepted');
  room.projectTransfer.streamEnded = true;
  room.projectTransfer.phase = 'finishing';

  assert.equal(room.projectTransferLoading(actor, 'project_5').error, undefined);
  assert.equal(room.projectTransferForSocket(actor).response, 'loading');
  assert.equal(room.projectTransferResult(actor, 'project_5', true).error, undefined);
  assert.equal(room.projectTransfer.phase, 'completed');
});

test('matching projects join as actors without timeline control', () => {
  const admin = fakeSocket('admin');
  const actor = fakeSocket('actor');
  const room = createRoom(admin, 'DA', 'same-project');

  const result = joinRoom(actor, room.code, 'Comédien', 'same-project');

  assert.equal(result.room, room);
  assert.equal(room.memberForSocket(actor).role, 'actor');
  assert.equal(room.canControl(actor), false);
  assert.equal(room.canControl(admin), true);
});

test('only a promoted Co-DA can receive recording control', () => {
  const admin = fakeSocket('admin');
  const actor = fakeSocket('actor');
  const room = createRoom(admin, 'DA', 'same-project');
  joinRoom(actor, room.code, 'Co-DA', 'same-project');

  assert.equal(room.setControlOwner(actor.id), false);
  assert.equal(room.setCoDirector(actor.id, true), true);
  assert.equal(room.setControlOwner(actor.id), true);
  assert.equal(room.canControl(actor), true);

  assert.equal(room.setCoDirector(actor.id, false), true);
  assert.equal(room.canControl(actor), false);
  assert.equal(room.controlOwnerId, admin.id);
});

test('actors stay unready until their microphone preflight succeeds', () => {
  const admin = fakeSocket('admin');
  const actor = fakeSocket('actor');
  const room = createRoom(admin, 'DA', 'same-project');
  joinRoom(actor, room.code, 'Comédien', 'same-project');

  assert.equal(room.memberForSocket(actor).recording_ready, false);
  assert.equal(room.setRecordingReady(actor, true), true);
  assert.equal(room.memberForSocket(actor).recording_ready, true);
});
