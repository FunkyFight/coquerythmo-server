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

test('a reconnecting director restores the admin role without a promotion', () => {
  const adminGhost = fakeSocket('admin-ghost');
  const adminFresh = fakeSocket('admin-fresh');
  const actor = fakeSocket('actor');
  const room = createRoom(adminGhost, 'DA', 'same-project', 'da-session');
  joinRoom(actor, room.code, 'Comédien', 'same-project', 'actor-session');

  const result = joinRoom(adminFresh, room.code, 'DA', 'same-project', 'da-session');

  assert.equal(result.role, 'admin');
  assert.equal(room.memberForSocket(adminFresh).role, 'admin');
  assert.equal(room.controlOwnerId, adminFresh.id);
  // The stale socket is gone and nobody was promoted in between.
  assert.equal(room.memberForSocket(adminGhost), null);
  assert.equal(room.memberForSocket(actor).role, 'actor');
  assert.equal(actor.emitted.filter(([event]) => event === 'room_created').length, 0);
});

test('a returning director restores authority without promoting a stale actor', () => {
  const adminGhost = fakeSocket('admin-ghost');
  const adminFresh = fakeSocket('admin-fresh');
  const actor = fakeSocket('actor');
  const room = createRoom(adminGhost, 'DA', 'same-project', 'da-session');
  joinRoom(actor, room.code, 'Comédien', 'same-project', 'actor-session');

  // The director truly goes away: the oldest member is promoted.
  room.removeMember(adminGhost);
  assert.equal(room.memberForSocket(actor).role, 'actor');

  const result = joinRoom(adminFresh, room.code, 'DA', 'same-project', 'da-session');

  assert.equal(result.role, 'admin');
  assert.equal(room.memberForSocket(adminFresh).role, 'admin');
  assert.equal(room.memberForSocket(actor).role, 'actor');
  assert.equal(room.controlOwnerId, adminFresh.id);
  assert.equal(room.canControl(adminFresh), true);
  assert.equal(room.canControl(actor), false);
});

function bigBegin(overrides = {}) {
  return {
    transfer_id: 'big_1',
    event: 'recording_prepare', recording_chain: { nextSequence: 0, previousIntegrity: '0000000000000000' },
    total_bytes: 2,
    total_chunks: 1,
    chunk_size: 256 * 1024,
    sha1: 'a'.repeat(40),
    ...overrides,
  };
}

test('chunked recording preparation restores the saved chain before clip edits', () => {
  const { validateRecordingTransaction } = require('../src/recording_protocol');
  for (const target of [null, 'actor']) {
    const admin = fakeSocket('admin');
    const room = createRoom(admin, 'DA', 'saved-project');
    joinRoom(fakeSocket('actor'), room.code, 'Actor', 'saved-project');
    const chain = { nextSequence: 2130, previousIntegrity: 'a'.repeat(16) };
    room.beginBigTransfer(admin, bigBegin({
      event: 'recording_prepare', recording_chain: chain, _target: target,
    }));
    assert.equal(room.getRecordingChain().nextSequence, 0);
    room.bigChunk(admin, { transfer_id: 'big_1' }, { bytes: 2 });
    assert.equal(room.endBigTransfer(admin, 'big_1').error, undefined);
    assert.deepEqual(room.getRecordingChain(), chain);
    for (const operation of [
      { op: 'delete_clips', clip_ids: [1] },
      { op: 'move_clips', placements: [{ clip_id: 2, start_frame: 10 }] },
      { op: 'add_clip', clip: { id: 3 } },
    ]) {
      const expected = room.getRecordingChain();
      const result = validateRecordingTransaction({
        sequence: expected.nextSequence,
        previous_integrity: expected.previousIntegrity,
        integrity: 'b'.repeat(16), operation,
      }, expected);
      assert.equal(result.error, undefined);
      room.setRecordingChain(result.nextChain);
    }
  }
});

test('incomplete recording preparation leaves the chain unchanged', () => {
  const admin = fakeSocket('admin');
  const room = createRoom(admin, 'DA', 'saved-project');
  const before = room.getRecordingChain();
  room.beginBigTransfer(admin, bigBegin({
    event: 'recording_prepare',
    recording_chain: { nextSequence: 2130, previousIntegrity: 'a'.repeat(16) },
  }));
  assert.equal(room.endBigTransfer(admin, 'big_1').error, 'big_transfer_ended_before_completion');
  assert.deepEqual(room.getRecordingChain(), before);
});

test('a chunked recording snapshot can target one member or broadcast to the room', () => {
  const admin = fakeSocket('admin');
  const actor = fakeSocket('actor');
  const room = createRoom(admin, 'DA', 'same-project');
  joinRoom(actor, room.code, 'Comédien', 'same-project');

  const broadcast = room.beginBigTransfer(admin, bigBegin());
  assert.equal(broadcast.transfer.targetMemberId, null);

  const targeted = room.beginBigTransfer(
    admin,
    bigBegin({ transfer_id: 'big_2', _target: actor.id }),
  );
  assert.equal(targeted.transfer.targetMemberId, actor.id);

  assert.equal(
    room.beginBigTransfer(admin, bigBegin({ transfer_id: 'big_3', _target: 'ghost' })).error,
    'invalid_big_transfer_target',
  );
});

test('a chunked recording_prepare requires recording control', () => {
  const admin = fakeSocket('admin');
  const actor = fakeSocket('actor');
  const room = createRoom(admin, 'DA', 'same-project');
  joinRoom(actor, room.code, 'Comédien', 'same-project');

  assert.equal(
    room.beginBigTransfer(actor, bigBegin({ event: 'recording_prepare' })).error,
    'recording_control_required',
  );
  assert.equal(
    room.beginBigTransfer(admin, bigBegin({ event: 'recording_prepare' })).error,
    undefined,
  );
  // Legacy unversioned band snapshots cannot bypass the state authority.
  assert.equal(room.beginBigTransfer(actor, bigBegin({ event: 'sync', transfer_id: 'big_2' })).error, 'unsupported_big_event');
});

test('big transfer ids are unique per room and chunks must be sequential', () => {
  const admin = fakeSocket('admin');
  const room = createRoom(admin, 'DA', 'same-project');

  room.beginBigTransfer(admin, bigBegin());
  assert.equal(room.beginBigTransfer(admin, bigBegin()).error, 'big_transfer_id_duplicate');

  const chunk = { transfer_id: 'big_1', index: 0, data: 'aGk=' };
  assert.match(room.bigChunk(admin, chunk, { error: 'out of order' }).error, /out of order/);
  assert.equal(room.bigChunk(admin, chunk, { bytes: 2 }).transfer.receivedBytes, 2);
  assert.equal(room.endBigTransfer(admin, 'big_1').transfer.event, 'recording_prepare');
  assert.equal(room.bigTransfers.size, 0);
});

test('an incomplete big transfer cannot end and foreign senders are rejected', () => {
  const admin = fakeSocket('admin');
  const actor = fakeSocket('actor');
  const room = createRoom(admin, 'DA', 'same-project');
  joinRoom(actor, room.code, 'Comédien', 'same-project');

  room.beginBigTransfer(admin, bigBegin({ total_bytes: 4, total_chunks: 2 }));
  room.bigChunk(admin, { transfer_id: 'big_1', index: 0 }, { bytes: 2 });
  assert.equal(
    room.bigChunk(actor, { transfer_id: 'big_1', index: 1 }, { bytes: 2 }).error,
    'big_transfer_sender_mismatch',
  );
  assert.equal(room.endBigTransfer(admin, 'big_1').error, 'big_transfer_ended_before_completion');
  // The transfer is consumed by endBigTransfer even when it fails.
  assert.equal(room.bigTransfers.size, 0);
});

test('big transfers expire and leave with their sender or target', () => {
  const admin = fakeSocket('admin');
  const actor = fakeSocket('actor');
  const room = createRoom(admin, 'DA', 'same-project');
  joinRoom(actor, room.code, 'Comédien', 'same-project');

  room.beginBigTransfer(admin, bigBegin(), 1000);
  room.beginBigTransfer(admin, bigBegin({ transfer_id: 'big_2', _target: actor.id }), 1000);
  room.beginBigTransfer(admin, bigBegin({ transfer_id: 'big_3' }), 1000);

  assert.deepEqual(room.expireBigTransfers(1000 + 599_999, 600_000), []);
  const expired = room.expireBigTransfers(1000 + 600_001, 600_000);
  assert.equal(expired.length, 3);
  assert.equal(room.bigTransfers.size, 0);

  room.beginBigTransfer(admin, bigBegin({ transfer_id: 'big_4', _target: actor.id }));
  room.beginBigTransfer(actor, bigBegin({ transfer_id: 'big_5' }));
  room.beginBigTransfer(admin, bigBegin({ transfer_id: 'big_6' }));
  room.removeMember(actor);
  // The transfer targeting the departed member and the one it sent are gone;
  // unrelated transfers survive.
  assert.deepEqual([...room.bigTransfers.keys()], ['big_6']);
});
