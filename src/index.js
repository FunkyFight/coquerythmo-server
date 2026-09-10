require('dotenv').config();

const http = require('http');
const { Server } = require('socket.io');
const fs = require('node:fs');
const os = require('node:os');
const { dispatchCommand, rejectCommand } = require('./command_protocol');
const { registerProtocolRpc, PROTOCOL_VERSION } = require('./protocol_rpc');
const { RoomProtocol } = require('./room_protocol');
const { createCacheDirectory } = require('./cache_directory');
const { validatePassword } = require('./auth');
const { createRoom, joinRoom, leaveRoom, getRoom, rooms } = require('./room');
const {
  validateAudioChunk,
  validateAudioStart,
  validateBigBegin,
  validateBigChunk,
  validateRecordingDisplaySettings,
  validateRecordingView,
  validateRecordingPrepare,
  validateRecordingTransaction,
  expiredTransferIds,
  relayAudio,
} = require('./recording_protocol');

const PORT = parseInt(process.env.PORT || '9050', 10);
const SERVER_NAME = process.env.SERVER_NAME || 'Coquerythmo Server';
const MAX_SLOTS = parseInt(process.env.MAX_SLOTS || '20', 10);
const MOTD = process.env.MOTD || '';
const SERVER_IP = process.env.SERVER_IP || '';
const AUDIO_TRANSFER_TIMEOUT_MINUTES = 30;
const AUDIO_TRANSFER_TIMEOUT = AUDIO_TRANSFER_TIMEOUT_MINUTES * 60 * 1000;
const BIG_TRANSFER_TIMEOUT_MINUTES = 10;
const BIG_TRANSFER_TIMEOUT = BIG_TRANSFER_TIMEOUT_MINUTES * 60 * 1000;
const MAX_ACTIVE_AUDIO_TRANSFERS = 1;
const bannedIps = new Set();

const httpServer = http.createServer();
const io = new Server(httpServer, {
  cors: { origin: '*' },
  transports: ['websocket'],
  maxHttpBufferSize: 1024 * 1024,
  pingInterval: 15_000,
  pingTimeout: 30_000,
});

const cacheRoot = createCacheDirectory(process.env.PROJECT_CACHE_DIR || os.tmpdir());
const roomProtocol = new RoomProtocol(cacheRoot, (room, event, data) => io.to(room.code).emit(event, data), {
  maxStorageBytes: Number(process.env.PROJECT_STORAGE_MAX_BYTES || 128 * 1024 ** 3),
  maxProjectBytes: Number(process.env.PROJECT_MAX_BYTES || 64 * 1024 ** 3),
});

// HTTP /info endpoint for server browser ping (replaces websocket ping_server)
httpServer.on('request', (req, res) => {
  if (req.method === 'GET' && req.url?.startsWith('/info')) {
    const queryIndex = req.url.indexOf('?');
    const query = queryIndex >= 0 ? req.url.slice(queryIndex + 1) : '';
    const providedPassword = new URLSearchParams(query).get('password') || '';
    if (!validatePassword(providedPassword)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid password' }));
      return;
    }
    let online = 0;
    for (const [, room] of rooms) {
      online += room.members.size;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const info = {
      protocol_version: PROTOCOL_VERSION,
      name: SERVER_NAME,
      motd: MOTD,
      max_slots: MAX_SLOTS,
      online,
      rooms: rooms.size,
    };
    if (SERVER_IP) info.ip = SERVER_IP;
    res.end(JSON.stringify(info));
    return;
  }
});

httpServer.listen(PORT, () => {
  console.log(`${SERVER_NAME} listening on port ${httpServer.address().port} (max ${MAX_SLOTS} slots)`);
});

// --- Auth via middleware (handshake) ---
io.use((socket, next) => {
  if (socket.handshake.auth?.protocol_version !== PROTOCOL_VERSION) {
    return next(new Error(`Protocol ${PROTOCOL_VERSION} required; update Coquerythmo and its server together`));
  }
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
  const commandHandlers = new Map();
  const onCommand = (event, handler) => {
    commandHandlers.set(event, handler);
    socket.on(event, data => {
      try { handler(data); }
      catch (error) { socket.emit('server_error', { message: error.message }); }
    });
  };
  registerProtocolRpc(socket, (method, body, id) => method === 'event'
    ? dispatchCommand(getRoom(socket), socket, id, body, commandHandlers)
    : roomProtocol.dispatch(getRoom(socket), socket, method, body));

  if (process.env.DEBUG) {
    socket.onAny((event, ...args) => {
      console.log(`[event] ${socket.id} -> ${event}`, JSON.stringify(args).substring(0, 200));
    });
  }

  // --- Create room ---
  socket.on('create_room', (data) => {
    if (!data || typeof data.username !== 'string' || !data.username.trim()) return;
    if (!sessionIdFrom(data)) return socket.emit('server_error', { message: 'A session token is required' });
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
    const room = createRoom(socket, username, projectHuuid, sessionIdFrom(data));
    roomProtocol.attach(room);
    socket.join(room.code);
    socket.emit('room_created', {
      protocol_version: PROTOCOL_VERSION,
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
    if (!data.username.trim() || !sessionIdFrom(data)) return socket.emit('join_error', { reason: 'invalid_session' });
    if (socket.roomCode) return socket.emit('server_error', { message: 'Already in a room' });
    if (![...rooms.values()].some(room => [...room.members.values()].some(member => member.sessionId === sessionIdFrom(data)))
      && [...rooms.values()].reduce((total, room) => total + room.members.size, 0) >= MAX_SLOTS) {
      return socket.emit('join_error', { reason: 'server_full' });
    }
    const username = data.username.trim().substring(0, 32);
    const code = data.code.trim().toUpperCase();
    socket.username = username;
    const projectHuuid = typeof data.project_huuid === 'string' && data.project_huuid.trim()
      ? data.project_huuid.trim() : null;
    const projectMode = ['none', 'require_match', 'auto_transfer'].includes(data.project_mode)
      ? data.project_mode : 'none';
    const requestedProjectFileName = typeof data.project_file_name === 'string'
      ? data.project_file_name.trim().substring(0, 256) : null;
    const result = joinRoom(socket, code, username, projectHuuid, sessionIdFrom(data));
    if (result.error === 'room_not_found') {
      return socket.emit('join_error', { reason: 'room_not_found' });
    }
    const room = result.room;
    const effectiveProjectMode = projectMode === 'none' ? room.projectInvitationMode : projectMode;
    const effectiveProjectFileName = requestedProjectFileName || room.projectInvitationFileName;

    socket.join(room.code);
    socket.emit('room_joined', {
      protocol_version: PROTOCOL_VERSION,
      code: room.code,
      role: result.role,
      members: room.getMemberUsernames(),
      project_huuid: room.projectHuuid,
      project_matches: result.projectMatches,
      project_mode: effectiveProjectMode,
      project_file_name: effectiveProjectFileName,
      member_id: socket.id,
    });
    socket.to(room.code).emit('member_joined', { username });
    emitRoomState(room);
    roomProtocol.join(room, socket);
    console.log(`[room] ${username} joined room ${code}`);
  });

  // --- Leave room ---
  socket.on('leave_room', () => {
    handleLeave(socket);
  });

  // --- Sync request ---
  onCommand('request_sync', () => {
    const room = getRoom(socket);
    if (!room) return rejectCommand({ message: 'Not in a room' });
    console.log(`[sync] ${socket.username} requests sync`);
    for (const [memberSocket, member] of room.members) {
      if (member.role === 'admin' && memberSocket !== socket) {
        console.log(`[sync] Asking admin ${member.username} to send sync`);
        memberSocket.emit('request_sync', { requester: socket.id });
        return;
      }
    }
    console.log('[sync] No admin found');
    // Surface the failure instead of letting the requester wait forever on a
    // sync that can never arrive.
    rejectCommand({ message: 'No director available to synchronize' });
  });

  // Recording-workspace changes are authorized independently from the
  // existing bande-rythmo collaboration protocol. Only the DA or the Co-DA
  // currently holding control may mutate or drive playback.
  onCommand('recording_transaction', (data) => {
    const room = controlledRecordingRoom(socket);
    if (!room) return;
    const validation = validateRecordingTransaction(data, room.getRecordingChain());
    if (validation.error) {
      return rejectCommand({
        message: `Invalid recording transaction: ${validation.error}`,
      });
    }
    room.setRecordingChain(validation.nextChain);
    socket.to(room.code).emit('recording_transaction', data);
  });

  onCommand('recording_prepare', (data) => {
    const room = controlledRecordingRoom(socket);
    if (!room) return;
    const target = data?._target;
    const targetSocket = target === undefined ? null : memberSocketInRoom(room, target);
    if (target !== undefined && !targetSocket) {
      return rejectCommand({ message: 'Invalid recording preparation target' });
    }
    const payload = { ...data };
    delete payload._target;
    const validation = validateRecordingPrepare(payload);
    if (validation.error) {
      return rejectCommand({
        message: `Invalid recording preparation: ${validation.error}`,
      });
    }
    room.setRecordingChain(validation.chain);
    if (targetSocket) {
      targetSocket.emit('recording_prepare', payload);
    } else {
      socket.to(room.code).emit('recording_prepare', payload);
    }
  });

  // Chunked relay for payloads too large for a single websocket frame. The
  // server validates geometry and ordering, then relays each frame untouched:
  // reassembly and integrity checks happen on the receiving client.
  onCommand('big_begin', (data) => {
    const room = getRoom(socket);
    if (!room) return rejectCommand({ message: 'Not in a room' });
    const validation = validateBigBegin(data);
    if (validation.error) {
      return rejectCommand({ message: `Invalid big transfer: ${validation.error}` });
    }
    const result = room.beginBigTransfer(socket, data);
    if (result.error) return rejectCommand({ message: result.error });
    relayBigEvent(room, socket, 'big_begin', data, result.transfer.targetMemberId);
  });

  onCommand('big_chunk', (data) => {
    const room = getRoom(socket);
    if (!room) return rejectCommand({ message: 'Not in a room' });
    const transfer = room.bigTransfers.get(data?.transfer_id);
    const validation = validateBigChunk(data, transfer);
    const result = room.bigChunk(socket, data, validation);
    if (result.error) {
      // A protocol error aborts the transfer: the sender must start over
      // with a fresh big_begin instead of guessing the remaining state.
      if (transfer) room.bigTransfers.delete(data.transfer_id);
      return rejectCommand({ message: `Invalid big chunk: ${result.error}` });
    }
    relayBigEvent(room, socket, 'big_chunk', data, result.transfer.targetMemberId);
  });

  onCommand('big_end', (data) => {
    const room = getRoom(socket);
    if (!room) return rejectCommand({ message: 'Not in a room' });
    if (typeof data?.transfer_id !== 'string') {
      return rejectCommand({ message: 'Invalid big transfer id' });
    }
    const result = room.endBigTransfer(socket, data.transfer_id);
    if (result.error) return rejectCommand({ message: result.error });
    relayBigEvent(room, socket, 'big_end', data, result.transfer.targetMemberId);
  });

  onCommand('recording_capture', (data) => {
    const room = controlledRecordingRoom(socket);
    if (!room) return;
    if (!Number.isSafeInteger(data?.current_frame) || data.current_frame < 0
      || (data.capture_target !== null && typeof data.capture_target !== 'object')) {
      return rejectCommand({ message: 'Invalid recording capture command' });
    }
    socket.to(room.code).emit('recording_capture', data);
  });

  onCommand('recording_playback', (data) => {
    const room = controlledRecordingRoom(socket);
    if (!room) return;
    if (!Number.isSafeInteger(data?.frame) || data.frame < 0 || typeof data?.playing !== 'boolean') {
      return rejectCommand({ message: 'Invalid recording playback state' });
    }
    socket.to(room.code).emit('recording_playback', data);
  });

  onCommand('recording_view', (data) => {
    const room = getRoom(socket);
    const caller = room?.memberForSocket(socket);
    if (!room || caller?.role !== 'admin') return rejectCommand({ message: 'director_required' });
    const target = data?._target;
    const targetSocket = target === undefined ? null : memberSocketInRoom(room, target);
    const validation = validateRecordingView(data);
    if (validation.error || (target !== undefined && !targetSocket)) {
      return rejectCommand({ message: 'Invalid recording view' });
    }
    const payload = validation.payload;
    if (targetSocket) {
      targetSocket.emit('recording_view', payload);
    } else {
      socket.to(room.code).emit('recording_view', payload);
    }
  });

  onCommand('recording_ready', (data) => {
    const room = getRoom(socket);
    if (!room?.setRecordingReady(socket, data?.ready)) {
      return rejectCommand({ message: 'Invalid recording readiness' });
    }
    emitRoomState(room);
  });

  onCommand('set_project_invitation_mode', (data) => {
    const room = getRoom(socket);
    const mode = ['none', 'require_match', 'auto_transfer'].includes(data?.project_mode)
      ? data.project_mode : null;
    const fileName = typeof data?.project_file_name === 'string'
      ? data.project_file_name.trim().substring(0, 256) : null;
    if (!room || !mode || (mode !== 'none' && (!fileName || !fileName.toLowerCase().endsWith('.coquerythmo')))
      || !room.setProjectInvitationMode(socket, mode, fileName)) {
      return rejectCommand({ message: 'Invalid project invitation mode' });
    }
    emitRoomState(room);
  });

  onCommand('actor_request', (data) => {
    const room = getRoom(socket);
    const caller = room?.memberForSocket(socket);
    if (!room || caller?.role !== 'admin') return rejectCommand({ message: 'director_required' });
    if (data?.action === 'open_microphone') {
      socket.to(room.code).emit('actor_request', { action: 'open_microphone' });
    } else if (data?.action === 'apply_display_settings') {
      const settings = validateRecordingDisplaySettings(data);
      if (settings.error) {
        return rejectCommand({ message: settings.error });
      }
      socket.to(room.code).emit('actor_request', {
        action: 'apply_display_settings',
        ...settings,
      });
    } else if (data?.action === 'close_project_transfer_waiting') {
      socket.to(room.code).emit('actor_request', {
        action: 'close_project_transfer_waiting',
      });
      roomProtocol.attach(room).distribution.closeWaiting();
      roomProtocol.status(room, true);
    }
  });

  onCommand('set_co_director', (data) => {
    const room = getRoom(socket);
    const caller = room?.memberForSocket(socket);
    if (!room || caller?.role !== 'admin') return rejectCommand({ message: 'director_required' });
    if (typeof data?.member_id !== 'string') return;
    if (room.setCoDirector(data.member_id, Boolean(data.enabled))) emitRoomState(room);
  });

  onCommand('grant_recording_control', (data) => {
    const room = getRoom(socket);
    const caller = room?.memberForSocket(socket);
    if (!room || caller?.role !== 'admin') return rejectCommand({ message: 'director_required' });
    if (typeof data?.member_id !== 'string') return;
    if (room.setControlOwner(data.member_id)) emitRoomState(room);
  });

  onCommand('set_member_muted', (data) => {
    const room = getRoom(socket);
    const caller = room?.memberForSocket(socket);
    if (!room || caller?.role !== 'admin') return rejectCommand({ message: 'director_required' });
    const entry = typeof data?.member_id === 'string'
      ? room.memberEntryById(data.member_id)
      : null;
    if (!entry) return;
    entry[1].muted = Boolean(data.muted);
    emitRoomState(room);
  });

  onCommand('kick_member', (data) => {
    const room = getRoom(socket);
    const caller = room?.memberForSocket(socket);
    if (!room || caller?.role !== 'admin') return rejectCommand({ message: 'director_required' });
    const entry = typeof data?.member_id === 'string'
      ? room.memberEntryById(data.member_id)
      : null;
    if (!entry || entry[0] === socket) return;
    entry[0].emit('server_error', { message: 'Kicked by the artistic director' });
    entry[0].disconnect(true);
  });

  onCommand('ban_member_ip', (data) => {
    const room = getRoom(socket);
    const caller = room?.memberForSocket(socket);
    if (!room || caller?.role !== 'admin') return rejectCommand({ message: 'director_required' });
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
  onCommand('audio_start', (data) => {
    const room = getRoom(socket);
    const member = room?.memberForSocket(socket);
    if (!room || !member) return rejectCommand({ message: 'Not in a room' });
    const isAssetPublication = data?.commit_on_receive === false;
    if (isAssetPublication && !room.canControl(socket)) {
      return rejectCommand({ message: 'Recording control is read-only' });
    }
    if (member.muted && !isAssetPublication) {
      return rejectCommand({ message: 'Audio input is muted' });
    }
    if (socket.audioTransfers.size >= MAX_ACTIVE_AUDIO_TRANSFERS) {
      return rejectCommand({ message: 'Another audio transfer is already active' });
    }
    const validation = validateAudioStart(data);
    if (validation.error) {
      return rejectCommand({ message: `Invalid audio transfer: ${validation.error}` });
    }
    const targetMemberId = data.to_member_id || null;
    if (targetMemberId && !isAssetPublication) {
      return rejectCommand({ message: 'Recorded takes cannot target one recipient' });
    }
    if (targetMemberId && !memberSocketInRoom(room, targetMemberId)) {
      return rejectCommand({ message: 'Invalid audio recipient' });
    }
    if (socket.audioTransfers.has(data.transfer_id)) return;
    socket.audioTransfers.set(data.transfer_id, {
      nextIndex: 0,
      receivedBytes: 0,
      totalBytes: data.total_bytes,
      totalChunks: data.total_chunks,
      chunkSize: data.chunk_size,
      targetMemberId,
      lastActivity: Date.now(),
    });
    relayAudio(
      room,
      socket,
      'audio_start',
      { ...data, from_member_id: member.id },
      targetMemberId,
    );
  });

  onCommand('audio_chunk', (data) => {
    const room = getRoom(socket);
    const member = room?.memberForSocket(socket);
    if (!room || !member) return rejectCommand({ message: 'Not in a room' });
    const transfer = socket.audioTransfers.get(data?.transfer_id);
    const validation = validateAudioChunk(data, transfer);
    if (validation.error) {
      return rejectCommand({ message: `Invalid audio chunk: ${validation.error}` });
    }
    transfer.nextIndex += 1;
    transfer.receivedBytes += validation.bytes;
    transfer.lastActivity = Date.now();
    relayAudio(room, socket, 'audio_chunk', data, transfer.targetMemberId);
  });

  onCommand('audio_end', (data) => {
    const room = getRoom(socket);
    const member = room?.memberForSocket(socket);
    if (!room || !member) return rejectCommand({ message: 'Not in a room' });
    if (typeof data?.transfer_id !== 'string') {
      return rejectCommand({ message: 'Invalid audio transfer id' });
    }
    const transfer = socket.audioTransfers.get(data.transfer_id);
    if (!transfer) return rejectCommand({ message: 'Unknown audio transfer' });
    socket.audioTransfers.delete(data.transfer_id);
    if (transfer.nextIndex !== transfer.totalChunks
      || transfer.receivedBytes !== transfer.totalBytes) {
      return rejectCommand({ message: 'Audio transfer ended before completion' });
    }
    relayAudio(room, socket, 'audio_end', data, transfer.targetMemberId);
    socket.emit('audio_uploaded', { transfer_id: data.transfer_id });
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
    if (!result.room.isEmpty()) {
      emitRoomState(result.room);
      roomProtocol.status(result.room, true);
    }
  }
}

function emitRoomState(room) {
  io.to(room.code).emit('room_state', {
    members: room.getMemberList(),
    control_owner_id: room.controlOwnerId,
  });
}

function memberSocketInRoom(room, memberId) {
  if (typeof memberId !== 'string') return null;
  return room.memberEntryById(memberId)?.[0] || null;
}

function relayBigEvent(room, socket, event, data, targetMemberId) {
  const payload = { ...data };
  delete payload._target;
  if (targetMemberId) {
    memberSocketInRoom(room, targetMemberId)?.emit(event, payload);
  } else {
    socket.to(room.code).emit(event, payload);
  }
}

function sessionIdFrom(data) {
  return typeof data?.session_id === 'string'
    && /^[A-Za-z0-9_-]{1,128}$/.test(data.session_id)
    ? data.session_id
    : null;
}

function controlledRecordingRoom(socket) {
  const room = getRoom(socket);
  if (!room) {
    rejectCommand({ message: 'Not in a room' });
    return null;
  }
  if (!room.canControl(socket)) {
    rejectCommand({ message: 'Recording control is read-only' });
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
        message: `Audio transfer ${transferId} expired after ${AUDIO_TRANSFER_TIMEOUT_MINUTES} minutes of inactivity`,
      });
    }
  }
  for (const [, room] of rooms) {
    roomProtocol.attach(room).state.expire(now);
    roomProtocol.attach(room).store.expire(now).then(expired => {
      if (expired) {
        room.networkServices.distribution.error = 'upload_inactivity';
        roomProtocol.status(room, true);
      }
    }).catch(error => console.error('[project-cache]', error.message));
    for (const expired of room.expireBigTransfers(now, BIG_TRANSFER_TIMEOUT)) {
      const sender = room.memberEntryById(expired.senderId);
      sender?.[0].emit('server_error', {
        message: `Big transfer ${expired.transferId} expired after ${BIG_TRANSFER_TIMEOUT_MINUTES} minutes of inactivity`,
      });
    }
  }
}

// Socket.IO's heartbeat owns liveness. This timer only expires bounded
// transfer state and never disconnects a healthy client that is only receiving.
const transferTimer = setInterval(() => {
  expireAudioTransfers();
}, 60 * 1000); // check every minute
transferTimer.unref();

async function shutdown() {
  clearInterval(transferTimer);
  const activeRooms = [...rooms.values()];
  await new Promise(resolve => io.close(resolve));
  await Promise.all(activeRooms.map(room => room.cleanup || room.dispose?.()));
  await fs.promises.rm(cacheRoot, { recursive: true, force: true });
}

if (require.main === module) {
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    shutdown().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
  });
}

module.exports = { httpServer, io, roomProtocol, cacheRoot, shutdown };
