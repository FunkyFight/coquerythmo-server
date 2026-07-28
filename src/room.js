const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const CODE_LENGTH = 6;
const ZERO_INTEGRITY = '0000000000000000';

function generateCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return code;
}

class Room {
  constructor(code, adminSocket, adminUsername, projectHuuid) {
    this.code = code;
    this.projectHuuid = projectHuuid;
    this.members = new Map(); // socket -> { id, username, role, muted }
    this.controlOwnerId = adminSocket.id;
    this.recordingChain = {
      nextSequence: 0,
      previousIntegrity: ZERO_INTEGRITY,
    };
    this.addMember(adminSocket, adminUsername, 'admin');
  }

  addMember(socket, username, role) {
    this.members.set(socket, {
      id: socket.id,
      username,
      role,
      muted: false,
    });
    socket.roomCode = this.code;
  }

  removeMember(socket) {
    const member = this.members.get(socket);
    this.members.delete(socket);
    socket.roomCode = null;

    // Promote oldest member to admin if the admin left
    if (member && member.role === 'admin' && this.members.size > 0) {
      const [firstSocket, firstMember] = this.members.entries().next().value;
      firstMember.role = 'admin';
      this.controlOwnerId = firstSocket.id;
      firstSocket.emit('room_created', {
        code: this.code,
        project_huuid: this.projectHuuid,
        member_id: firstSocket.id,
      });
    }

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
    return [...this.members.values()].map(member => ({ ...member }));
  }

  memberForSocket(socket) {
    return this.members.get(socket) || null;
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

  getRecordingChain() {
    return { ...this.recordingChain };
  }

  setRecordingChain(chain) {
    this.recordingChain = { ...chain };
  }

  isEmpty() {
    return this.members.size === 0;
  }
}

/** Map of code -> Room */
const rooms = new Map();

function createRoom(socket, username, projectHuuid) {
  let code;
  do { code = generateCode(); } while (rooms.has(code));

  const room = new Room(code, socket, username, projectHuuid);
  rooms.set(code, room);
  return room;
}

function joinRoom(socket, code, username, projectHuuid) {
  const room = rooms.get(code);
  if (!room) return { error: 'room_not_found' };
  if (room.projectHuuid !== projectHuuid) return { error: 'project_mismatch' };
  room.addMember(socket, username, 'actor');
  return { room };
}

function leaveRoom(socket) {
  const code = socket.roomCode;
  if (!code) return null;
  const room = rooms.get(code);
  if (!room) return null;

  const member = room.removeMember(socket);
  if (room.isEmpty()) {
    rooms.delete(code);
  }
  return { room, member };
}

function getRoom(socket) {
  const code = socket.roomCode;
  return code ? rooms.get(code) : null;
}

module.exports = { Room, createRoom, joinRoom, leaveRoom, getRoom, rooms };
