require('dotenv').config();

const { Server } = require('socket.io');
const { validatePassword } = require('./auth');
const { createRoom, joinRoom, leaveRoom, getRoom, rooms } = require('./room');
const {
  validateAudioChunk,
  validateAudioStart,
  validateRecordingPrepare,
  validateRecordingTransaction,
  expiredTransferIds,
  relayAudio,
} = require('./recording_protocol');

const PORT = parseInt(process.env.PORT || '9050', 10);
const SERVER_NAME = process.env.SERVER_NAME || 'Coquerythmo Server';
const MAX_SLOTS = parseInt(process.env.MAX_SLOTS || '20', 10);
const MOTD = process.env.MOTD || '';
const INACTIVITY_TIMEOUT = 15 * 60 * 1000; // 15 minutes
const AUDIO_TRANSFER_TIMEOUT = 5 * 60 * 1000;
const MAX_ACTIVE_AUDIO_TRANSFERS = 1;
const bannedIps = new Set();

const io = new Server(PORT, {
  cors: { origin: '*' },
  maxHttpBufferSize: 200 * 1024 * 1024,
});

// --- Auth via middleware (handshake) ---
io.use((socket, next) => {
  const address = socket.handshake.address;
  if (bannedIps.has(address)) {
    next(new Error('Banned'));
    return;
  }
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
  socket.audioTransfers = new Map();
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
    let online = 0;
    for (const [, room] of rooms) {
      online += room.members.size;
    }
    socket.emit('server_info', {
      name: SERVER_NAME,
      motd: MOTD,
      max_slots: MAX_SLOTS,
      online,
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
    if (typeof data.project_huuid !== 'string' || !data.project_huuid.trim()) {
      return socket.emit('server_error', { message: 'A saved project HUUID is required' });
    }

    // Check slot limit
    let total = 0;
    for (const [, room] of rooms) total += room.members.size;
    if (total >= MAX_SLOTS) return socket.emit('server_error', { message: 'Server is full' });

    const username = data.username.trim().substring(0, 32);
    socket.username = username;
    const projectHuuid = data.project_huuid.trim().substring(0, 256);
    const room = createRoom(socket, username, projectHuuid);
    socket.join(room.code);
    socket.emit('room_created', {
      code: room.code,
      project_huuid: room.projectHuuid,
      member_id: socket.id,
    });
    emitRoomState(room);
    console.log(`[room] ${username} created room ${room.code}`);
  });

  // --- Join room ---
  socket.on('join_room', (data) => {
    if (!data || typeof data.username !== 'string' || typeof data.code !== 'string') return;
    if (socket.roomCode) return socket.emit('server_error', { message: 'Already in a room' });
    if (typeof data.project_huuid !== 'string' || !data.project_huuid.trim()) {
      return socket.emit('join_error', { reason: 'project_huuid_required' });
    }

    const username = data.username.trim().substring(0, 32);
    const code = data.code.trim().toUpperCase();
    socket.username = username;
    const result = joinRoom(socket, code, username, data.project_huuid.trim());
    if (result.error === 'room_not_found') {
      return socket.emit('join_error', { reason: 'room_not_found' });
    }
    if (result.error === 'project_mismatch') {
      return socket.emit('join_error', { reason: 'project_mismatch' });
    }
    const room = result.room;

    socket.join(room.code);
    socket.emit('room_joined', {
      code: room.code,
      role: 'actor',
      members: room.getMemberUsernames(),
      project_huuid: room.projectHuuid,
      member_id: socket.id,
    });
    socket.to(room.code).emit('member_joined', { username });
    emitRoomState(room);
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

  // Recording-workspace changes are authorized independently from the
  // existing bande-rythmo collaboration protocol. Only the DA or the Co-DA
  // currently holding control may mutate or drive playback.
  socket.on('recording_transaction', (data) => {
    const room = controlledRecordingRoom(socket);
    if (!room) return;
    const validation = validateRecordingTransaction(data, room.getRecordingChain());
    if (validation.error) {
      return socket.emit('server_error', {
        message: `Invalid recording transaction: ${validation.error}`,
      });
    }
    room.setRecordingChain(validation.nextChain);
    socket.to(room.code).emit('recording_transaction', data);
  });

  socket.on('recording_prepare', (data) => {
    const room = controlledRecordingRoom(socket);
    if (!room) return;
    const target = data?._target;
    if (target !== undefined
      && (typeof target !== 'string' || !room.memberEntryById(target))) {
      return socket.emit('server_error', { message: 'Invalid recording preparation target' });
    }
    const payload = { ...data };
    delete payload._target;
    const validation = validateRecordingPrepare(payload);
    if (validation.error) {
      return socket.emit('server_error', {
        message: `Invalid recording preparation: ${validation.error}`,
      });
    }
    room.setRecordingChain(validation.chain);
    if (target !== undefined) {
      io.to(target).emit('recording_prepare', payload);
    } else {
      socket.to(room.code).emit('recording_prepare', payload);
    }
  });

  socket.on('recording_capture', (data) => {
    const room = controlledRecordingRoom(socket);
    if (!room) return;
    if (!Number.isSafeInteger(data?.current_frame) || data.current_frame < 0
      || (data.capture_target !== null && typeof data.capture_target !== 'object')) {
      return socket.emit('server_error', { message: 'Invalid recording capture command' });
    }
    socket.to(room.code).emit('recording_capture', data);
  });

  socket.on('recording_playback', (data) => {
    const room = controlledRecordingRoom(socket);
    if (!room) return;
    socket.to(room.code).emit('recording_playback', data);
  });

  socket.on('set_co_director', (data) => {
    const room = getRoom(socket);
    const caller = room?.memberForSocket(socket);
    if (!room || caller?.role !== 'admin') return;
    if (typeof data?.member_id !== 'string') return;
    if (room.setCoDirector(data.member_id, Boolean(data.enabled))) emitRoomState(room);
  });

  socket.on('grant_recording_control', (data) => {
    const room = getRoom(socket);
    const caller = room?.memberForSocket(socket);
    if (!room || caller?.role !== 'admin') return;
    if (typeof data?.member_id !== 'string') return;
    if (room.setControlOwner(data.member_id)) emitRoomState(room);
  });

  socket.on('set_member_muted', (data) => {
    const room = getRoom(socket);
    const caller = room?.memberForSocket(socket);
    if (!room || caller?.role !== 'admin') return;
    const entry = typeof data?.member_id === 'string'
      ? room.memberEntryById(data.member_id)
      : null;
    if (!entry) return;
    entry[1].muted = Boolean(data.muted);
    emitRoomState(room);
  });

  socket.on('kick_member', (data) => {
    const room = getRoom(socket);
    const caller = room?.memberForSocket(socket);
    if (!room || caller?.role !== 'admin') return;
    const entry = typeof data?.member_id === 'string'
      ? room.memberEntryById(data.member_id)
      : null;
    if (!entry || entry[0] === socket) return;
    entry[0].emit('server_error', { message: 'Kicked by the artistic director' });
    entry[0].disconnect(true);
  });

  socket.on('ban_member_ip', (data) => {
    const room = getRoom(socket);
    const caller = room?.memberForSocket(socket);
    if (!room || caller?.role !== 'admin') return;
    const entry = typeof data?.member_id === 'string'
      ? room.memberEntryById(data.member_id)
      : null;
    if (!entry || entry[0] === socket) return;
    bannedIps.add(entry[0].handshake.address);
    entry[0].emit('server_error', { message: 'Banned by the artistic director' });
    entry[0].disconnect(true);
  });

  // FLAC files are transferred in bounded chunks. Socket.IO preserves event
  // order, while transfer_id/index/size/checksum let receivers reject a
  // truncated or interleaved upload before exposing it as a clip.
  socket.on('audio_start', (data) => {
    const room = getRoom(socket);
    const member = room?.memberForSocket(socket);
    if (!room || !member) return socket.emit('server_error', { message: 'Not in a room' });
    if (member.muted) return socket.emit('server_error', { message: 'Audio input is muted' });
    if (socket.audioTransfers.size >= MAX_ACTIVE_AUDIO_TRANSFERS) {
      return socket.emit('server_error', { message: 'Another audio transfer is already active' });
    }
    const validation = validateAudioStart(data);
    if (validation.error) {
      return socket.emit('server_error', { message: `Invalid audio transfer: ${validation.error}` });
    }
    if (socket.audioTransfers.has(data.transfer_id)) return;
    socket.audioTransfers.set(data.transfer_id, {
      nextIndex: 0,
      receivedBytes: 0,
      totalBytes: data.total_bytes,
      totalChunks: data.total_chunks,
      chunkSize: data.chunk_size,
      lastActivity: Date.now(),
    });
    relayAudio(room, socket, 'audio_start', { ...data, from_member_id: member.id });
  });

  socket.on('audio_chunk', (data) => {
    const room = getRoom(socket);
    const member = room?.memberForSocket(socket);
    if (!room || !member) return socket.emit('server_error', { message: 'Not in a room' });
    if (member.muted) return socket.emit('server_error', { message: 'Audio input is muted' });
    const transfer = socket.audioTransfers.get(data?.transfer_id);
    const validation = validateAudioChunk(data, transfer);
    if (validation.error) {
      return socket.emit('server_error', { message: `Invalid audio chunk: ${validation.error}` });
    }
    transfer.nextIndex += 1;
    transfer.receivedBytes += validation.bytes;
    transfer.lastActivity = Date.now();
    relayAudio(room, socket, 'audio_chunk', data);
  });

  socket.on('audio_end', (data) => {
    const room = getRoom(socket);
    const member = room?.memberForSocket(socket);
    if (!room || !member) return socket.emit('server_error', { message: 'Not in a room' });
    if (member.muted) return socket.emit('server_error', { message: 'Audio input is muted' });
    if (typeof data?.transfer_id !== 'string') {
      return socket.emit('server_error', { message: 'Invalid audio transfer id' });
    }
    const transfer = socket.audioTransfers.get(data.transfer_id);
    if (!transfer) return socket.emit('server_error', { message: 'Unknown audio transfer' });
    socket.audioTransfers.delete(data.transfer_id);
    if (transfer.nextIndex !== transfer.totalChunks
      || transfer.receivedBytes !== transfer.totalBytes) {
      return socket.emit('server_error', { message: 'Audio transfer ended before completion' });
    }
    relayAudio(room, socket, 'audio_end', data);
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
  socket.audioTransfers?.clear();
  const result = leaveRoom(socket);
  if (result && result.member) {
    socket.to(result.room.code).emit('member_left', { username: result.member.username });
    socket.leave(result.room.code);
    console.log(`[room] ${result.member.username} left room`);
    if (!result.room.isEmpty()) emitRoomState(result.room);
  }
}

function emitRoomState(room) {
  io.to(room.code).emit('room_state', {
    members: room.getMemberList(),
    control_owner_id: room.controlOwnerId,
  });
}

function controlledRecordingRoom(socket) {
  const room = getRoom(socket);
  if (!room) {
    socket.emit('server_error', { message: 'Not in a room' });
    return null;
  }
  if (!room.canControl(socket)) {
    socket.emit('server_error', { message: 'Recording control is read-only' });
    return null;
  }
  return room;
}

function expireAudioTransfers() {
  const now = Date.now();
  for (const socket of io.sockets.sockets.values()) {
    for (const transferId of expiredTransferIds(
      socket.audioTransfers || [],
      now,
      AUDIO_TRANSFER_TIMEOUT,
    )) {
      socket.audioTransfers.delete(transferId);
      socket.emit('server_error', {
        message: `Audio transfer ${transferId} expired after 5 minutes of inactivity`,
      });
    }
  }
}

// --- Inactivity check: disconnect clients idle for 15 minutes ---
setInterval(() => {
  expireAudioTransfers();
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
