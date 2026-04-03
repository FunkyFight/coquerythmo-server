const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const CODE_LENGTH = 6;

function generateCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return code;
}

class Room {
  constructor(code, adminSocket, adminUsername) {
    this.code = code;
    this.members = new Map(); // socket -> { username, role }
    this.addMember(adminSocket, adminUsername, 'admin');
  }

  addMember(socket, username, role) {
    this.members.set(socket, { username, role });
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
      firstSocket.emit('room_created', { code: this.code });
    }

    return member;
  }

  getMemberUsernames() {
    return [...this.members.values()].map(m => m.username);
  }

  isEmpty() {
    return this.members.size === 0;
  }
}

/** Map of code -> Room */
const rooms = new Map();

function createRoom(socket, username) {
  let code;
  do { code = generateCode(); } while (rooms.has(code));

  const room = new Room(code, socket, username);
  rooms.set(code, room);
  return room;
}

function joinRoom(socket, code, username) {
  const room = rooms.get(code);
  if (!room) return null;
  room.addMember(socket, username, 'user');
  return room;
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

function sendTo(socket, event, data) {
  try { socket.emit(event, data); } catch (_) {}
}

module.exports = { createRoom, joinRoom, leaveRoom, getRoom, sendTo, rooms };
