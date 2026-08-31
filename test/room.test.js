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

test('a participant reconnecting during a project transfer restarts it instead of completing it', () => {
  const admin = fakeSocket('admin');
  const actor = fakeSocket('actor');
  const reconnected = fakeSocket('actor-reconnected');
  const room = createRoom(admin, 'DA', 'same-project');
  joinRoom(actor, room.code, 'Comédien', undefined, 'actor-session');
  const metadata = {
    request_id: 'project_reconnect', project_huuid: 'new-project', file_name: 'new.coquerythmo',
    total_bytes: 1, total_chunks: 1, chunk_size: 192 * 1024, sha1: 'a'.repeat(40),
  };

  room.beginProjectTransfer(admin, metadata, 1000);
  room.projectTransferResponse(actor, 'project_reconnect', 'accepted');
  room.startProjectTransferStream(admin, metadata, 1100);
  room.projectTransferChunk(admin, {
    request_id: 'project_reconnect',
    index: 0,
  }, { bytes: 1 }, 1200);
  room.removeMember(actor);

  assert.equal(room.projectTransfer.phase, 'transferring');
  assert.equal(room.projectTransfer.participants.actor.socket, null);

  const result = joinRoom(
    reconnected,
    room.code,
    'Comédien',
    undefined,
    'actor-session',
  );

  assert.equal(result.reconnected.restarted, false);
  assert.equal(room.projectTransfer.phase, 'transferring');
  assert.equal(room.projectTransfer.participants['actor-reconnected'].response, 'disconnected');

  const finished = room.finishProjectTransferStream(admin, 'project_reconnect', 1300);

  assert.equal(finished.restarted, true);
  assert.equal(room.projectTransfer.phase, 'collecting');
  assert.equal(room.projectTransfer.streamStarted, false);
  assert.equal(room.projectTransfer.participants['actor-reconnected'].response, 'pending');
  assert.equal(room.projectTransfer.participants.actor, undefined);
});

test('a fast reconnect replaces the stale socket before reattaching the participant', () => {
  const admin = fakeSocket('admin');
  const actor = fakeSocket('actor');
  const reconnected = fakeSocket('actor-reconnected');
  const room = createRoom(admin, 'DA', 'same-project');
  joinRoom(actor, room.code, 'Comédien', undefined, 'actor-session');
  const metadata = {
    request_id: 'project_fast_reconnect', project_huuid: 'new-project',
    file_name: 'new.coquerythmo', total_bytes: 1, total_chunks: 1,
    chunk_size: 192 * 1024, sha1: 'a'.repeat(40),
  };

  room.beginProjectTransfer(admin, metadata);
  room.projectTransferResponse(actor, 'project_fast_reconnect', 'accepted');

  const result = joinRoom(
    reconnected,
    room.code,
    'Comédien',
    undefined,
    'actor-session',
  );

  assert.equal(result.reconnected.restarted, false);
  assert.equal(actor.roomCode, null);
  assert.equal(room.members.size, 2);
  assert.equal(room.projectTransfer.participants['actor-reconnected'].socket, reconnected);
  assert.equal(room.projectTransfer.participants.actor, undefined);
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

test('the director can close the waiting transfer before any stream starts', () => {
  const admin = fakeSocket('admin');
  const actor = fakeSocket('actor');
  const room = createRoom(admin, 'DA', 'same-project');
  joinRoom(actor, room.code, 'Comédien', undefined);
  const metadata = {
    request_id: 'project_close_waiting', project_huuid: 'new-project',
    file_name: 'new.coquerythmo', total_bytes: 1, total_chunks: 1,
    chunk_size: 192 * 1024, sha1: 'a'.repeat(40),
  };

  room.beginProjectTransfer(admin, metadata);
  assert.equal(room.closeProjectTransferWaiting(), true);
  assert.equal(room.projectTransfer.phase, 'completed');
  assert.equal(room.projectTransfer.participants[actor.id].response, 'refused');
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

test('a slow recipient is not expired after the director finished sending', () => {
  const admin = fakeSocket('admin');
  const actor = fakeSocket('actor');
  const room = createRoom(admin, 'DA', 'same-project');
  joinRoom(actor, room.code, 'Comédien', undefined);
  const metadata = {
    request_id: 'project_slow_recipient', project_huuid: 'new-project',
    file_name: 'new.coquerythmo', total_bytes: 1, total_chunks: 1,
    chunk_size: 192 * 1024, sha1: 'a'.repeat(40),
  };

  room.beginProjectTransfer(admin, metadata, 1_000);
  room.projectTransferResponse(actor, metadata.request_id, 'accepted');
  room.startProjectTransferStream(admin, metadata, 2_000);
  room.projectTransferChunk(admin, {
    request_id: metadata.request_id,
    index: 0,
  }, { bytes: 1 }, 3_000);
  room.finishProjectTransferStream(admin, metadata.request_id, 4_000);

  assert.equal(room.projectTransfer.phase, 'finishing');
  assert.equal(room.expireProjectTransfer(604_001), false);
  assert.equal(room.projectTransfer.phase, 'finishing');
});

test('project transfers with the same id stay isolated between rooms', () => {
  const adminA = fakeSocket('admin-a');
  const actorA = fakeSocket('actor-a');
  const adminB = fakeSocket('admin-b');
  const actorB = fakeSocket('actor-b');
  const roomA = createRoom(adminA, 'DA A', 'project-a');
  const roomB = createRoom(adminB, 'DA B', 'project-b');
  joinRoom(actorA, roomA.code, 'Actor A', undefined);
  joinRoom(actorB, roomB.code, 'Actor B', undefined);
  const metadata = {
    request_id: 'same-request-id', project_huuid: 'new-project',
    file_name: 'new.coquerythmo', total_bytes: 1, total_chunks: 1,
    chunk_size: 192 * 1024, sha1: 'a'.repeat(40),
  };

  roomA.beginProjectTransfer(adminA, metadata);
  roomB.beginProjectTransfer(adminB, metadata);
  roomA.projectTransferResponse(actorA, metadata.request_id, 'accepted');

  assert.equal(roomA.projectTransfer.phase, 'transferring');
  assert.equal(roomB.projectTransfer.phase, 'collecting');
  assert.equal(roomA.projectTransferForSocket(actorB), null);
  assert.equal(roomB.projectTransferForSocket(actorA), null);
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

test('a detached member keeps role, mute and control ownership during grace', () => {
  const admin = fakeSocket('admin');
  const actor = fakeSocket('actor');
  const resumed = fakeSocket('actor-resumed');
  const room = createRoom(admin, 'DA', 'same-project', 'admin-session', 2);
  joinRoom(actor, room.code, 'Co-DA', 'same-project', 'actor-session', 2);
  room.setCoDirector('actor-session', true);
  room.setControlOwner('actor-session');
  room.memberForSocket(actor).muted = true;

  const detached = room.detachMember(actor, 1_000);
  assert.equal(detached.member.connected, false);
  assert.equal(detached.member.reconnect_deadline_ms, 61_000);
  assert.equal(room.controlOwnerId, 'actor-session');
  assert.equal(room.expireDetachedMembers(60_999), false);

  const result = joinRoom(
    resumed,
    room.code,
    'changed name is ignored',
    'same-project',
    'actor-session',
    2,
  );
  assert.equal(result.reconnected.restarted, false);
  assert.equal(result.member.id, 'actor-session');
  assert.equal(result.member.role, 'co_da');
  assert.equal(result.member.muted, true);
  assert.equal(result.member.connected, true);
  assert.equal(room.controlOwnerId, 'actor-session');
});

test('the director is promoted only after the sixty-second grace period', () => {
  const admin = fakeSocket('admin');
  const coDirector = fakeSocket('co-director');
  const room = createRoom(admin, 'DA', 'same-project', 'admin-session');
  joinRoom(coDirector, room.code, 'Co-DA', 'same-project', 'co-session');
  room.setCoDirector('co-session', true);
  room.detachMember(admin, 10_000);

  assert.equal(room.memberForSocket(coDirector).role, 'co_da');
  assert.equal(room.expireDetachedMembers(69_999), false);
  assert.equal(room.memberForSocket(coDirector).role, 'co_da');
  assert.equal(room.expireDetachedMembers(70_000), true);
  assert.equal(room.memberForSocket(coDirector).role, 'admin');
});

test('explicit leave removes a member immediately instead of detaching it', () => {
  const admin = fakeSocket('admin');
  const actor = fakeSocket('actor');
  const room = createRoom(admin, 'DA', 'same-project');
  joinRoom(actor, room.code, 'Actor', 'same-project', 'actor-session');

  const { member } = require('../src/room').leaveRoom(actor);
  assert.equal(member.connected, false);
  assert.equal(room.members.has(actor), false);
  assert.equal(actor.roomCode, null);
});

test('recording preparation waits for every active actor and is idempotent', () => {
  const admin = fakeSocket('admin');
  const actor = fakeSocket('actor');
  const room = createRoom(admin, 'DA', 'same-project');
  joinRoom(actor, room.code, 'Actor', 'same-project', 'actor-session');
  const payload = {
    take_id: 'take_1',
    project: { timeline_fps: 24 },
    transactions: { entries: [], cursor: 0 },
    current_frame: 10,
    capture_target: {},
  };

  assert.equal(room.beginRecording(admin, payload, 100).recording.phase, 'preparing');
  assert.equal(room.prepareRecording(actor, 'take_1', true, null, 101).started, true);
  assert.equal(room.activeRecording.phase, 'started');
  assert.equal(room.prepareRecording(actor, 'take_1', true, null, 102).repeated, true);
  assert.equal(room.beginRecording(admin, payload, 103).repeated, true);
});

test('a recording preparation timeout cancels the active take', () => {
  const admin = fakeSocket('admin');
  const actor = fakeSocket('actor');
  const room = createRoom(admin, 'DA', 'same-project');
  joinRoom(actor, room.code, 'Actor', 'same-project', 'actor-session');
  room.beginRecording(admin, {
    take_id: 'take_timeout',
    project: {},
    transactions: {},
    current_frame: 0,
    capture_target: {},
  }, 1_000);

  const expired = room.expireRecordingPreparation(11_000);
  assert.equal(expired.cancelReason, 'preparation_timeout');
  assert.equal(room.activeRecording.phase, 'cancelled');
});

test('muted and late actors are excluded from the active take', () => {
  const admin = fakeSocket('admin');
  const actor = fakeSocket('actor');
  const muted = fakeSocket('muted');
  const late = fakeSocket('late');
  const room = createRoom(admin, 'DA', 'same-project');
  joinRoom(actor, room.code, 'Actor', 'same-project', 'actor-session');
  joinRoom(muted, room.code, 'Muted', 'same-project', 'muted-session');
  room.memberForSocket(muted).muted = true;

  room.beginRecording(admin, {
    take_id: 'take_active_set',
    project: {},
    transactions: {},
    current_frame: 0,
    capture_target: {},
  }, 1_000);
  joinRoom(late, room.code, 'Late', 'same-project', 'late-session');

  assert.deepEqual([...room.activeRecording.requiredIds], ['actor-session']);
  assert.equal(room.prepareRecording(late, 'take_active_set', true, null).repeated, true);
  assert.equal(room.prepareRecording(actor, 'take_active_set', true, null).started, true);
});

test('a required actor disconnecting during preparation cancels the take', () => {
  const admin = fakeSocket('admin');
  const actor = fakeSocket('actor');
  const room = createRoom(admin, 'DA', 'same-project');
  joinRoom(actor, room.code, 'Actor', 'same-project', 'actor-session');
  room.beginRecording(admin, {
    take_id: 'take_disconnect',
    project: {},
    transactions: {},
    current_frame: 0,
    capture_target: {},
  });

  const detached = room.detachMember(actor, 5_000);
  assert.equal(detached.recordingCancelled.cancelReason, 'participant_disconnected');
  assert.equal(room.activeRecording.phase, 'cancelled');
});

test('a room enforces the creator protocol version for subsequent joins', () => {
  const admin = fakeSocket('admin');
  const actor = fakeSocket('actor');
  const room = createRoom(admin, 'DA', 'same-project', 'admin-session', 2);
  assert.equal(joinRoom(actor, room.code, 'Actor', 'same-project', 'actor-session', 1).error,
    'protocol_version_mismatch');
});
