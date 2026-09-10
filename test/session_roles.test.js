const test = require('node:test');
const assert = require('node:assert/strict');
const { createRoom, joinRoom, leaveRoom, rooms } = require('../src/room');

test('Co-DA authority survives a transport change and can still be revoked', () => {
  const director = { id: 'director' };
  const actor = { id: 'actor' };
  const room = createRoom(director, 'DA', 'project', 'director-session');
  joinRoom(actor, room.code, 'Actor', 'project', 'actor-session');
  room.setCoDirector(actor.id, true);
  leaveRoom(actor);
  const replacement = { id: 'replacement' };
  assert.equal(joinRoom(replacement, room.code, 'Actor', 'project', 'actor-session').role, 'co_da');
  room.setCoDirector(replacement.id, false);
  leaveRoom(replacement);
  assert.equal(joinRoom(actor, room.code, 'Actor', 'project', 'actor-session').role, 'actor');
  leaveRoom(actor);
  leaveRoom(director);
  assert.equal(rooms.has(room.code), false);
});
