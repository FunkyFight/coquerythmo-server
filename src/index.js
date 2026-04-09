require('dotenv').config();

const { Server } = require('socket.io');
const { validatePassword } = require('./auth');
const { createRoom, joinRoom, leaveRoom, getRoom } = require('./room');

const PORT = parseInt(process.env.PORT || '9050', 10);

const io = new Server(PORT, {
  cors: { origin: '*' },
  maxHttpBufferSize: 200 * 1024 * 1024,
});

// --- Auth via middleware (handshake) ---
io.use((socket, next) => {
  console.log('[auth] handshake.auth:', JSON.stringify(socket.handshake.auth));
  const password = socket.handshake.auth?.password ?? '';
  if (validatePassword(password)) {
    console.log('[auth] Client authenticated:', socket.id);
    next();
  } else {
    console.log('[auth] Client rejected:', socket.id);
    next(new Error('Invalid password'));
  }
});

io.on('connection', (socket) => {
  console.log('[connect] Authenticated client:', socket.id);
  socket.username = null;
  socket.roomCode = null;

  if (process.env.DEBUG) {
    socket.onAny((event, ...args) => {
      console.log(`[event] ${socket.id} -> ${event}`, JSON.stringify(args).substring(0, 200));
    });
  }

  // --- Create room ---
  socket.on('create_room', (data) => {
    if (!data || typeof data.username !== 'string' || !data.username.trim()) return;
    if (socket.roomCode) return socket.emit('server_error', { message: 'Already in a room' });

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
    // Ask admin to send fresh sync
    for (const [memberSocket, member] of room.members) {
      if (member.role === 'admin' && memberSocket !== socket) {
        console.log(`[sync] Asking admin ${member.username} to send sync`);
        // Tell admin who needs the sync
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
    // If targeted to a specific requester, send only to them
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

console.log(`coquerythmo server listening on port ${PORT}`);
