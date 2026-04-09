require('dotenv').config();

const { Server } = require('socket.io');
const { validatePassword } = require('./auth');
const { createRoom, joinRoom, leaveRoom, getRoom, rooms } = require('./room');

const PORT = parseInt(process.env.PORT || '9050', 10);
const SERVER_NAME = process.env.SERVER_NAME || 'Coquerythmo Server';
const MAX_SLOTS = parseInt(process.env.MAX_SLOTS || '20', 10);
const MOTD = process.env.MOTD || '';
const INACTIVITY_TIMEOUT = 15 * 60 * 1000; // 15 minutes

const io = new Server(PORT, {
  cors: { origin: '*' },
  maxHttpBufferSize: 200 * 1024 * 1024,
});

// --- Auth via middleware (handshake) ---
io.use((socket, next) => {
  const password = socket.handshake.auth?.password ?? '';
  if (validatePassword(password)) {
    next();
  } else {
    console.log('[auth] Client rejected:', socket.id);
    next(new Error('Invalid password'));
  }
});

io.on('connection', (socket) => {
  console.log('[connect] Client:', socket.id);
  socket.username = null;
  socket.roomCode = null;
  socket.lastActivity = Date.now();

  if (process.env.DEBUG) {
    socket.onAny((event, ...args) => {
      console.log(`[event] ${socket.id} -> ${event}`, JSON.stringify(args).substring(0, 200));
    });
  }

  // Reset inactivity timer on any incoming event
  socket.onAny(() => {
    socket.lastActivity = Date.now();
  });

  // --- Server info (ping) ---
  socket.on('ping_server', () => {
    let connectedClients = 0;
    for (const [, room] of rooms) {
      connectedClients += room.members.size;
    }
    socket.emit('server_info', {
      name: SERVER_NAME,
      motd: MOTD,
      max_slots: MAX_SLOTS,
      online: connectedClients,
      rooms: rooms.size,
    }, () => {
      // Disconnect after ack (if client supports it)
      socket.disconnect(true);
    });
    // Also disconnect after a short delay in case no ack
    setTimeout(() => {
      if (socket.connected) socket.disconnect(true);
    }, 500);
  });

  // --- Create room ---
  socket.on('create_room', (data) => {
    if (!data || typeof data.username !== 'string' || !data.username.trim()) return;
    if (socket.roomCode) return socket.emit('server_error', { message: 'Already in a room' });

    // Check slot limit
    let total = 0;
    for (const [, room] of rooms) total += room.members.size;
    if (total >= MAX_SLOTS) return socket.emit('server_error', { message: 'Server is full' });

    const username = data.username.trim().substring(0, 32);
    socket.username = username;
    const room = createRoom(socket, username);
    socket.join(room.code);
    socket.emit('room_created', { code: room.code });
    console.log(`[room] ${username} created room ${room.code}`);
  });

  // --- Join room ---
  socket.on('join_room', (data) => {
    if (!data || typeof data.username !== 'string' || typeof data.code !== 'string') return;
    if (socket.roomCode) return socket.emit('server_error', { message: 'Already in a room' });

    const username = data.username.trim().substring(0, 32);
    const code = data.code.trim().toUpperCase();
    socket.username = username;
    const room = joinRoom(socket, code, username);
    if (!room) return socket.emit('join_error', { reason: 'Room not found' });

    socket.join(room.code);
    socket.emit('room_joined', {
      code: room.code,
      role: 'user',
      members: room.getMemberUsernames(),
    });
    socket.to(room.code).emit('member_joined', { username });
    console.log(`[room] ${username} joined room ${code}`);
  });

  // --- Leave room ---
  socket.on('leave_room', () => {
    handleLeave(socket);
  });

  // --- Command broadcast ---
  socket.on('command', (data) => {
    if (!data || typeof data.payload !== 'object') return;
    const room = getRoom(socket);
    if (!room) return socket.emit('server_error', { message: 'Not in a room' });
    socket.to(room.code).emit('remote_command', {
      from: socket.username,
      payload: data.payload,
    });
  });

  // Delta: lightweight command relay
  socket.on('delta', (data) => {
    if (!data) return;
    const room = getRoom(socket);
    if (!room) return;
    socket.to(room.code).emit('delta', data);
  });

  // --- Sync request ---
  socket.on('request_sync', () => {
    const room = getRoom(socket);
    if (!room) return socket.emit('server_error', { message: 'Not in a room' });
    console.log(`[sync] ${socket.username} requests sync`);
    for (const [memberSocket, member] of room.members) {
      if (member.role === 'admin' && memberSocket !== socket) {
        console.log(`[sync] Asking admin ${member.username} to send sync`);
        memberSocket.emit('request_sync', { requester: socket.id });
        return;
      }
    }
    console.log('[sync] No admin found');
  });

  // --- Sync data (admin -> specific requester or broadcast) ---
  socket.on('sync', (data) => {
    const room = getRoom(socket);
    if (!room) return;
    console.log(`[sync] ${socket.username} sent sync data`);
    if (data._target) {
      const target = data._target;
      delete data._target;
      io.to(target).emit('sync', data);
    } else {
      socket.to(room.code).emit('sync', data);
    }
  });

  // --- Chunked video relay ---
  socket.on('video_start', (data) => {
    if (!data || typeof data.filename !== 'string' || typeof data.total_chunks !== 'number') return;
    const room = getRoom(socket);
    if (!room) return;
    console.log(`[video] ${socket.username} sending video: ${data.filename} (${data.total_chunks} chunks)`);
    socket.to(room.code).emit('video_start', data);
  });

  socket.on('video_chunk', (data) => {
    if (!data || data.index === undefined) return;
    const room = getRoom(socket);
    if (!room) return;
    socket.to(room.code).emit('video_chunk', data);
  });

  socket.on('video_end', (data) => {
    const room = getRoom(socket);
    if (!room) return;
    console.log(`[video] Transfer complete`);
    socket.to(room.code).emit('video_end', data);
  });

  // --- Disconnect ---
  socket.on('disconnect', () => {
    handleLeave(socket);
    console.log('[disconnect] Client:', socket.id);
  });
});

function handleLeave(socket) {
  const result = leaveRoom(socket);
  if (result && result.member) {
    socket.to(result.room.code).emit('member_left', { username: result.member.username });
    socket.leave(result.room.code);
    console.log(`[room] ${result.member.username} left room`);
  }
}

// --- Inactivity check: disconnect clients idle for 15 minutes ---
setInterval(() => {
  const now = Date.now();
  for (const [id, socket] of io.sockets.sockets) {
    if (now - socket.lastActivity > INACTIVITY_TIMEOUT) {
      console.log(`[timeout] Disconnecting idle client: ${socket.username || socket.id}`);
      socket.emit('server_error', { message: 'Disconnected: 15 minutes of inactivity' });
      handleLeave(socket);
      socket.disconnect(true);
    }
  }
}, 60 * 1000); // check every minute

console.log(`${SERVER_NAME} listening on port ${PORT} (max ${MAX_SLOTS} slots)`);
