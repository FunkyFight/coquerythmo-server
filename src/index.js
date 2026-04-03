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

  socket.onAny((event, ...args) => {
    console.log(`[event] ${socket.id} -> ${event}`, JSON.stringify(args).substring(0, 200));
  });

  // --- Create room ---
  socket.on('create_room', (data) => {
    if (socket.roomCode) return socket.emit('server_error', { message: 'Already in a room' });

    socket.username = data.username;
    const room = createRoom(socket, data.username);
    socket.join(room.code);
    socket.emit('room_created', { code: room.code });
    console.log(`[room] ${data.username} created room ${room.code}`);
  });

  // --- Join room ---
  socket.on('join_room', (data) => {
    if (socket.roomCode) return socket.emit('server_error', { message: 'Already in a room' });

    socket.username = data.username;
    const room = joinRoom(socket, data.code, data.username);
    if (!room) return socket.emit('join_error', { reason: 'Room not found' });

    socket.join(room.code);
    socket.emit('room_joined', {
      code: room.code,
      role: 'user',
      members: room.getMemberUsernames(),
    });
    socket.to(room.code).emit('member_joined', { username: data.username });
    console.log(`[room] ${data.username} joined room ${data.code}`);
  });

  // --- Leave room ---
  socket.on('leave_room', () => {
    handleLeave(socket);
  });

  // --- Command broadcast ---
  socket.on('command', (data) => {
    const room = getRoom(socket);
    if (!room) return socket.emit('server_error', { message: 'Not in a room' });
    socket.to(room.code).emit('remote_command', {
      from: socket.username,
      payload: data.payload,
    });
  });

  // --- Sync request ---
  socket.on('request_sync', () => {
    const room = getRoom(socket);
    if (!room) {
      console.log('[sync] request_sync but not in a room');
      return socket.emit('server_error', { message: 'Not in a room' });
    }
    console.log(`[sync] ${socket.username} requests sync from room ${room.code} (${room.members.size} members)`);
    let sent = false;
    for (const [memberSocket, member] of room.members) {
      if (member.role === 'admin' && memberSocket !== socket) {
        console.log(`[sync] Forwarding request_sync to admin: ${member.username}`);
        memberSocket.emit('request_sync');
        sent = true;
        break;
      }
    }
    if (!sent) console.log('[sync] No admin found to forward request_sync');
  });

  // --- Sync data (admin -> all) ---
  socket.on('sync', (data) => {
    const room = getRoom(socket);
    if (!room) return;
    console.log(`[sync] ${socket.username} sending sync data to room ${room.code}`);
    socket.to(room.code).emit('sync', data);
  });

  // --- Chunked video relay ---
  socket.on('video_start', (data) => {
    const room = getRoom(socket);
    if (!room) return;
    console.log(`[video] ${socket.username} sending video: ${data.filename} (${data.total_chunks} chunks)`);
    socket.to(room.code).emit('video_start', data);
  });

  socket.on('video_chunk', (data) => {
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
