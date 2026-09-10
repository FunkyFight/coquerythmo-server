const test = require('node:test');
const assert = require('node:assert/strict');
const { dispatchCommand } = require('../src/command_protocol');
const { Room } = require('../src/room');

test('a command whose reply is lost executes once across socket replacement', () => {
  const original = { id: 'original' };
  const room = new Room('ROOM', original, 'DA', 'project', 'session');
  let executions = 0;
  const handlers = new Map([['edit', () => { executions++; }]]);
  const command = { event: 'edit', payload: { frame: 10 } };
  dispatchCommand(room, original, 'operation', command, handlers);
  room.removeMember(original);
  const replacement = { id: 'replacement' };
  room.addMember(replacement, 'DA', 'admin', 'session');
  dispatchCommand(room, replacement, 'operation', command, handlers);
  assert.equal(executions, 1);
  assert.throws(() => dispatchCommand(room, replacement, 'operation', { ...command, payload: { frame: 11 } }, handlers), /id_conflict/);
});

test('invalid and unauthorized commands return errors without acknowledgement of success', () => {
  const socket = { id: 'member' };
  const room = new Room('ROOM', socket, 'DA', 'project', 'session');
  const handlers = new Map([['edit', () => { throw new Error('read_only'); }]]);
  assert.throws(() => dispatchCommand(room, socket, 'a', { event: 'unknown', payload: {} }, handlers), /invalid_room_command/);
  for (let i = 0; i < 2; i++) assert.throws(() => dispatchCommand(room, socket, 'b', { event: 'edit', payload: {} }, handlers), /read_only/);
  assert.throws(() => dispatchCommand(room, { id: 'outsider' }, 'c', { event: 'edit', payload: {} }, handlers), /not_in_room/);
});
