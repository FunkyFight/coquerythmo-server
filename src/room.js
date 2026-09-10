const { randomInt } = require('node:crypto');
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const CODE_LENGTH = 6;
const ZERO_INTEGRITY = '0000000000000000';

function generateCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += ALPHABET[randomInt(ALPHABET.length)];
  }
  return code;
}

class Room {
  constructor(code, adminSocket, adminUsername, projectHuuid, adminSessionId = null) {
    this.code = code;
    this.projectHuuid = projectHuuid;
    this.projectInvitationMode = 'none';
    this.projectInvitationFileName = null;
    this.members = new Map(); // socket -> { id, username, role, muted }
    this.controlOwnerId = adminSocket.id;
    // Session of the founding director: a reconnect with the same session id
    // restores the admin role instead of landing in the room as an actor.
    this.adminSessionId = adminSessionId;
    this.coDirectorSessions = new Set();
    this.recordingChain = {
      nextSequence: 0,
      previousIntegrity: ZERO_INTEGRITY,
    };
    // transfer_id -> chunked `big_*` relay state. The server never
    // reassembles payloads; it only enforces ordering, bounds and routing.
    this.bigTransfers = new Map();
    this.addMember(adminSocket, adminUsername, 'admin', adminSessionId);
  }

  addMember(socket, username, role, sessionId = null) {
    this.members.set(socket, {
      id: socket.id,
      username,
      role,
      sessionId,
      muted: false,
      recording_ready: role === 'admin',
    });
    socket.roomCode = this.code;
  }

  removeMember(socket, suppressPromotion = false) {
    const member = this.members.get(socket);
    this.dropBigTransfersOf(socket);
    this.members.delete(socket);
    socket.roomCode = null;

    // A disconnected director retains authority through its secret session
    // token. Promoting an arbitrary actor here could publish a stale project.
    if (member && member.id === this.controlOwnerId) {
      const admin = this.adminEntry();
      this.controlOwnerId = admin ? admin[0].id : null;
    }

    return member;
  }

  getMemberUsernames() {
    return [...this.members.values()].map(m => m.username);
  }

  getMemberList() {
    return [...this.members.values()].map(({ sessionId, ...member }) => ({ ...member }));
  }

  memberForSocket(socket) {
    return this.members.get(socket) || null;
  }

  replaceMemberForSession(sessionId, suppressPromotion = false) {
    if (!sessionId) return null;
    for (const [socket, member] of this.members) {
      if (member.sessionId === sessionId) {
        socket.leave?.(this.code);
        return this.removeMember(socket, suppressPromotion);
      }
    }
    return null;
  }

  memberEntryById(memberId) {
    for (const [socket, member] of this.members) {
      if (member.id === memberId) return [socket, member];
    }
    return null;
  }

  adminEntry() {
    for (const [socket, member] of this.members) {
      if (member.role === 'admin') return [socket, member];
    }
    return null;
  }

  canControl(socket) {
    const member = this.memberForSocket(socket);
    return Boolean(member && (member.role === 'admin' || member.id === this.controlOwnerId));
  }

  setCoDirector(memberId, enabled) {
    const entry = this.memberEntryById(memberId);
    if (!entry || entry[1].role === 'admin') return false;
    entry[1].role = enabled ? 'co_da' : 'actor';
    if (entry[1].sessionId) {
      if (enabled) this.coDirectorSessions.add(entry[1].sessionId);
      else this.coDirectorSessions.delete(entry[1].sessionId);
    }
    if (!enabled && this.controlOwnerId === memberId) {
      const admin = this.adminEntry();
      this.controlOwnerId = admin ? admin[0].id : null;
    }
    return true;
  }

  setControlOwner(memberId) {
    const entry = this.memberEntryById(memberId);
    if (!entry || !['admin', 'co_da'].includes(entry[1].role)) return false;
    this.controlOwnerId = memberId;
    return true;
  }

  setRecordingReady(socket, ready) {
    const member = this.memberForSocket(socket);
    if (!member || typeof ready !== 'boolean') return false;
    member.recording_ready = ready;
    return true;
  }

  setProjectInvitationMode(socket, mode, fileName = null) {
    const member = this.memberForSocket(socket);
    if (!member || member.role !== 'admin') return false;
    this.projectInvitationMode = mode;
    this.projectInvitationFileName = mode === 'none' ? null : fileName;
    return true;
  }

  getRecordingChain() {
    return { ...this.recordingChain };
  }

  setRecordingChain(chain) {
    this.recordingChain = { ...chain };
  }

  isEmpty() {
    return this.members.size === 0;
  }

  beginBigTransfer(socket, data, now = Date.now()) {
    const member = this.memberForSocket(socket);
    if (!member) return { error: 'not_in_room' };
    // Oversized recording state obeys the same authority as direct state.
    // Bande-rythmo sync uses the versioned state protocol.
    if (data.event !== 'recording_prepare') return { error: 'unsupported_big_event' };
    if (!this.canControl(socket)) {
      return { error: 'recording_control_required' };
    }
    if (this.bigTransfers.has(data.transfer_id)) return { error: 'big_transfer_id_duplicate' };
    let targetMemberId = null;
    if (data._target !== undefined && data._target !== null) {
      const entry = this.memberEntryById(data._target);
      if (!entry) return { error: 'invalid_big_transfer_target' };
      targetMemberId = entry[1].id;
    }
    const transfer = {
      senderId: member.id,
      event: data.event,
      recordingChain: data.event === 'recording_prepare' ? { ...data.recording_chain } : null,
      targetMemberId,
      nextIndex: 0,
      receivedBytes: 0,
      totalBytes: data.total_bytes,
      totalChunks: data.total_chunks,
      chunkSize: data.chunk_size,
      lastActivity: now,
    };
    this.bigTransfers.set(data.transfer_id, transfer);
    return { transfer };
  }

  bigChunk(socket, data, validation, now = Date.now()) {
    const transfer = this.bigTransfers.get(data?.transfer_id);
    if (!transfer) return { error: 'unknown_big_transfer' };
    const member = this.memberForSocket(socket);
    if (!member || transfer.senderId !== member.id) return { error: 'big_transfer_sender_mismatch' };
    if (validation.error) return validation;
    transfer.nextIndex += 1;
    transfer.receivedBytes += validation.bytes;
    transfer.lastActivity = now;
    return { transfer };
  }

  endBigTransfer(socket, transferId) {
    const transfer = this.bigTransfers.get(transferId);
    if (!transfer) return { error: 'unknown_big_transfer' };
    const member = this.memberForSocket(socket);
    if (!member || transfer.senderId !== member.id) return { error: 'big_transfer_sender_mismatch' };
    this.bigTransfers.delete(transferId);
    if (transfer.nextIndex !== transfer.totalChunks
      || transfer.receivedBytes !== transfer.totalBytes) {
      return { error: 'big_transfer_ended_before_completion' };
    }
    if (transfer.recordingChain) {
      if (!this.canControl(socket)) return { error: 'recording_control_required' };
      this.setRecordingChain(transfer.recordingChain);
    }
    return { transfer };
  }

  dropBigTransfersOf(socket) {
    const member = this.members.get(socket);
    if (!member) return;
    for (const [transferId, transfer] of this.bigTransfers) {
      if (transfer.senderId === member.id || transfer.targetMemberId === member.id) {
        this.bigTransfers.delete(transferId);
      }
    }
  }

  expireBigTransfers(now = Date.now(), timeoutMs) {
    const expired = [];
    for (const [transferId, transfer] of this.bigTransfers) {
      if (now - transfer.lastActivity > timeoutMs) {
        this.bigTransfers.delete(transferId);
        expired.push({ transferId, senderId: transfer.senderId });
      }
    }
    return expired;
  }
}

/** Map of code -> Room */
const rooms = new Map();

function createRoom(socket, username, projectHuuid, sessionId = null) {
  let code;
  do { code = generateCode(); } while (rooms.has(code));

  const room = new Room(code, socket, username, projectHuuid, sessionId);
  rooms.set(code, room);
  return room;
}

function joinRoom(socket, code, username, projectHuuid, sessionId = null) {
  const room = rooms.get(code);
  if (!room) return { error: 'room_not_found' };
  // A reconnect keeps the client's session id. When it matches the founding
  // director's session, restore the admin role on the fresh socket instead of
  // creating a parallel room or leaving an interim promoted member in charge.
  const returningAdmin = Boolean(sessionId) && room.adminSessionId === sessionId;
  if (returningAdmin) {
    room.replaceMemberForSession(sessionId, true);
    // Demote any member promoted while the director was away.
    for (const [, member] of room.members) {
      if (member.role === 'admin') member.role = 'actor';
    }
  } else {
    room.replaceMemberForSession(sessionId);
  }
  const role = returningAdmin ? 'admin' : room.coDirectorSessions.has(sessionId) ? 'co_da' : 'actor';
  room.addMember(socket, username, role, sessionId);
  if (returningAdmin) room.controlOwnerId = socket.id;
  return {
    room,
    role,
    projectMatches: Boolean(projectHuuid && room.projectHuuid === projectHuuid),
  };
}

function leaveRoom(socket) {
  const code = socket.roomCode;
  if (!code) return null;
  const room = rooms.get(code);
  if (!room) return null;

  const member = room.removeMember(socket);
  if (room.isEmpty()) {
    rooms.delete(code);
    room.cleanup = Promise.resolve(room.dispose?.()).catch(error => console.error('[room-cleanup]', error.message));
  }
  return { room, member };
}

function getRoom(socket) {
  const code = socket.roomCode;
  return code ? rooms.get(code) : null;
}

module.exports = { Room, createRoom, joinRoom, leaveRoom, getRoom, rooms };
