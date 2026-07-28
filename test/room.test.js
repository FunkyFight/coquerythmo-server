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

test('a room rejects a different project HUUID', () => {
  const admin = fakeSocket('admin');
  const actor = fakeSocket('actor');
  const room = createRoom(admin, 'DA', 'Coquerythmo-3.6.0-A');

  const result = joinRoom(actor, room.code, 'Comédien', 'Coquerythmo-3.6.0-B');

  assert.equal(result.error, 'project_mismatch');
  assert.equal(room.members.size, 1);
  assert.equal(actor.roomCode, null);
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
