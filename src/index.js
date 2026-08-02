require('dotenv').config();

const { Server } = require('socket.io');
const { validatePassword } = require('./auth');
const { createRoom, joinRoom, leaveRoom, getRoom, rooms } = require('./room');
const {
  validateAudioChunk,
  validateAudioStart,
  validateProjectChunk,
  validateProjectStart,
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
    const room = createRoom(socket, username, projectHuuid, sessionIdFrom(data));
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
    const username = data.username.trim().substring(0, 32);
    const code = data.code.trim().toUpperCase();
    socket.username = username;
    const projectHuuid = typeof data.project_huuid === 'string' && data.project_huuid.trim()
      ? data.project_huuid.trim() : null;
    const result = joinRoom(socket, code, username, projectHuuid, sessionIdFrom(data));
    if (result.error === 'room_not_found') {
      return socket.emit('join_error', { reason: 'room_not_found' });
    }
    const room = result.room;

    socket.join(room.code);
    socket.emit('room_joined', {
      code: room.code,
      role: 'actor',
      members: room.getMemberUsernames(),
      project_huuid: room.projectHuuid,
      project_matches: result.projectMatches,
      member_id: socket.id,
    });
    socket.to(room.code).emit('member_joined', { username });
    emitRoomState(room);
    if (result.reconnected) {
      if (result.reconnected.restarted) {
        emitProjectTransferRequests(room);
      } else if (room.projectTransfer?.phase === 'collecting') {
        emitProjectTransferRequest(
          socket,
          room.projectTransfer,
          room.adminEntry()?.[1]?.id,
        );
      }
      emitProjectTransferStatus(room);
    }
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

  socket.on('recording_view', (data) => {
    const room = getRoom(socket);
    const caller = room?.memberForSocket(socket);
    if (!room || caller?.role !== 'admin') return;
    const target = data?._target;
    if (!Number.isSafeInteger(data?.language_id) || data.language_id < 0
      || typeof data.instrumental !== 'boolean'
      || (target !== undefined
        && (typeof target !== 'string' || !room.memberEntryById(target)))) {
      return socket.emit('server_error', { message: 'Invalid recording view' });
    }
    const payload = {
      language_id: data.language_id,
      instrumental: data.instrumental,
    };
    if (target !== undefined) {
      io.to(target).emit('recording_view', payload);
    } else {
      socket.to(room.code).emit('recording_view', payload);
    }
  });

  socket.on('recording_ready', (data) => {
    const room = getRoom(socket);
    if (!room?.setRecordingReady(socket, data?.ready)) {
      return socket.emit('server_error', { message: 'Invalid recording readiness' });
    }
    emitRoomState(room);
  });

  socket.on('actor_request', (data) => {
    const room = getRoom(socket);
    const caller = room?.memberForSocket(socket);
    if (!room || caller?.role !== 'admin') return;
    if (data?.action === 'open_microphone') {
      socket.to(room.code).emit('actor_request', { action: 'open_microphone' });
    } else if (data?.action === 'close_project_transfer_waiting') {
      socket.to(room.code).emit('actor_request', {
        action: 'close_project_transfer_waiting',
      });
      if (room.closeProjectTransferWaiting()) emitProjectTransferStatus(room);
    }
  });

  socket.on('project_transfer_request', (data) => {
    const room = getRoom(socket);
    const validation = validateProjectStart(data);
    if (!room || validation.error) {
      return socket.emit('server_error', {
        message: `Invalid project transfer: ${validation.error || 'not in a room'}`,
      });
    }
    const result = room.beginProjectTransfer(socket, data);
    if (result.error) return socket.emit('server_error', { message: result.error });
    for (const participant of Object.values(result.transfer.participants)) {
      emitProjectTransferRequest(participant.socket, result.transfer, room.memberForSocket(socket).id);
    }
    emitProjectTransferStatus(room);
  });

  socket.on('project_transfer_response', (data) => {
    const room = getRoom(socket);
    const response = typeof data?.response === 'string' ? data.response : '';
    const result = room?.projectTransferResponse(socket, data?.request_id, response);
    if (!result || result.error) {
      if (room?.projectTransfer && (room.projectTransferForSocket(socket)
        || room.memberForSocket(socket)?.role === 'admin')) {
        room.cancelProjectTransfer('protocol_error');
        emitProjectTransferStatus(room);
      }
      return socket.emit('server_error', { message: result?.error || 'Not in a room' });
    }
    emitProjectTransferStatus(room);
    if (result.transfer.phase === 'transferring') {
      room.adminEntry()?.[0].emit('project_transfer_ready', {
        request_id: result.transfer.requestId,
        metadata: result.transfer.metadata,
      });
    }
  });

  socket.on('project_transfer_start', (data) => {
    const room = getRoom(socket);
    const validation = validateProjectStart(data);
    const result = room?.startProjectTransferStream(socket, data);
    if (!result || result.error || validation.error) {
      if (room?.projectTransfer && room.memberForSocket(socket)?.role === 'admin') {
        room.cancelProjectTransfer('protocol_error');
        emitProjectTransferStatus(room);
      }
      return socket.emit('server_error', {
        message: result?.error || validation.error || 'Not in a room',
      });
    }
    emitProjectTransferStatus(room);
  });

  socket.on('project_transfer_chunk', (data) => {
    const room = getRoom(socket);
    const transfer = room?.projectTransfer;
    const validation = validateProjectChunk(data, transfer && {
      requestId: transfer.requestId,
      nextIndex: transfer.nextIndex,
      chunkSize: transfer.metadata.chunk_size,
      receivedBytes: transfer.receivedBytes,
      totalBytes: transfer.metadata.total_bytes,
    });
    const result = room?.projectTransferChunk(socket, data, validation);
    if (!result || result.error) {
      if (room?.projectTransfer && room.memberForSocket(socket)?.role === 'admin') {
        room.cancelProjectTransfer('protocol_error');
        emitProjectTransferStatus(room);
      }
      return socket.emit('server_error', {
        message: result?.error || validation.error || 'Not in a room',
      });
    }
    for (const memberId of result.transfer.acceptedIds || []) {
      const participant = result.transfer.participants[memberId];
      if (participant?.response === 'receiving' && participant.socket) participant.socket.emit('project_transfer_chunk', data);
    }
    emitProjectTransferStatus(room);
  });

  socket.on('project_transfer_end', (data) => {
    const room = getRoom(socket);
    const result = room?.finishProjectTransferStream(socket, data?.request_id);
    if (!result || result.error) {
      if (room?.projectTransfer && room.memberForSocket(socket)?.role === 'admin') {
        room.cancelProjectTransfer('protocol_error');
        emitProjectTransferStatus(room);
      }
      return socket.emit('server_error', { message: result?.error || 'Not in a room' });
    }
    if (result.restarted) {
      emitProjectTransferStatus(room);
      emitProjectTransferRequests(room);
      return;
    }
    for (const memberId of result.transfer.acceptedIds || []) {
      const participant = result.transfer.participants[memberId];
      if (participant?.socket) participant.socket.emit('project_transfer_end', {
        request_id: result.transfer.requestId,
      });
    }
    emitProjectTransferStatus(room);
  });

  socket.on('project_transfer_loading', (data) => {
    const room = getRoom(socket);
    const result = room?.projectTransferLoading(socket, data?.request_id);
    if (!result || result.error) {
      return socket.emit('server_error', { message: result?.error || 'Not in a room' });
    }
    emitProjectTransferStatus(room);
  });

  socket.on('project_transfer_result', (data) => {
    const room = getRoom(socket);
    const result = room?.projectTransferResult(
      socket,
      data?.request_id,
      data?.success === true,
      data?.error,
    );
    if (!result || result.error) {
      if (room?.projectTransfer) {
        room.cancelProjectTransfer('protocol_error');
        emitProjectTransferStatus(room);
      }
      return socket.emit('server_error', { message: result?.error || 'Not in a room' });
    }
    emitProjectTransferStatus(room);
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
    socket.emit('audio_uploaded', { transfer_id: data.transfer_id });
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
    if (!result.room.isEmpty()) {
      emitRoomState(result.room);
      if (result.room.projectTransfer) emitProjectTransferStatus(result.room);
    }
  }
}

function emitRoomState(room) {
  io.to(room.code).emit('room_state', {
    members: room.getMemberList(),
    control_owner_id: room.controlOwnerId,
  });
}

function projectTransferStatus(room) {
  const transfer = room.projectTransfer;
  if (!transfer) return null;
  return {
    request_id: transfer.requestId,
    phase: transfer.phase,
    total_bytes: transfer.metadata.total_bytes,
    transferred_bytes: transfer.receivedBytes,
    participants: Object.values(transfer.participants).map(participant => ({
      member_id: participant.memberId,
      username: participant.username,
      response: participant.response,
      progress: participant.progress,
      deadline: participant.deadline,
      error: participant.error,
    })),
    cancel_reason: transfer.cancelReason,
  };
}

function emitProjectTransferStatus(room) {
  const payload = projectTransferStatus(room);
  if (payload) io.to(room.code).emit('project_transfer_status', payload);
}

function emitProjectTransferRequest(socket, transfer, fromMemberId) {
  socket.emit('project_transfer_request', {
    ...transfer.metadata,
    from_member_id: fromMemberId,
  });
}

function emitProjectTransferRequests(room) {
  const transfer = room.projectTransfer;
  if (!transfer) return;
  const fromMemberId = room.adminEntry()?.[1]?.id;
  for (const participant of Object.values(transfer.participants)) {
    if (participant.socket && participant.response === 'pending') {
      emitProjectTransferRequest(participant.socket, transfer, fromMemberId);
    }
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
  for (const [, room] of rooms) {
    const changed = room.expireProjectTransferResponses(now) || room.expireProjectTransfer(now);
    if (changed) emitProjectTransferStatus(room);
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
