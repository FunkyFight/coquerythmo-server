'use strict';

const { createHash } = require('node:crypto');

// A lost acknowledgement must never execute a take edit, moderation action,
// or transfer block twice. Receipts survive the caller's socket replacement.
function dispatchCommand(room, socket, id, request, handlers) {
  const member = room?.memberForSocket(socket);
  if (!member) throw new Error('not_in_room');
  const handler = handlers.get(request.event);
  if (!handler || !request.payload || typeof request.payload !== 'object' || Array.isArray(request.payload)) {
    throw new Error('invalid_room_command');
  }
  room.commandReceipts ||= new Map();
  const key = `${member.sessionId}:${id}`;
  const fingerprint = createHash('sha1').update(JSON.stringify(request)).digest('hex');
  const previous = room.commandReceipts.get(key);
  if (previous) {
    if (previous.fingerprint !== fingerprint) throw new Error('room_command_id_conflict');
    if (previous.error) throw new Error(previous.error);
    return {};
  }
  const receipt = { fingerprint, error: null };
  try { handler(request.payload); }
  catch (error) { receipt.error = String(error.message || 'room_command_failed').slice(0, 512); }
  room.commandReceipts.set(key, receipt);
  while (room.commandReceipts.size > 2048) room.commandReceipts.delete(room.commandReceipts.keys().next().value);
  if (receipt.error) throw new Error(receipt.error);
  return {};
}

function rejectCommand(error) { throw new Error(error.message); }

module.exports = { dispatchCommand, rejectCommand };
