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
  constructor(code, adminSocket, adminUsername, projectHuuid, adminSessionId = null) {
    this.code = code;
    this.projectHuuid = projectHuuid;
    this.members = new Map(); // socket -> { id, username, role, muted }
    this.controlOwnerId = adminSocket.id;
    this.recordingChain = {
      nextSequence: 0,
      previousIntegrity: ZERO_INTEGRITY,
    };
    this.projectTransfer = null;
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

  removeMember(socket) {
    const member = this.members.get(socket);
    this.members.delete(socket);
    socket.roomCode = null;

    if (this.projectTransfer) {
      if (member?.role === 'admin') {
        this.projectTransfer.phase = 'cancelled';
        this.projectTransfer.cancelReason = 'director_left';
      } else if (member) {
        const participant = this.projectTransfer.participants[member.id];
        if (participant) {
          if (['transferring', 'finishing'].includes(this.projectTransfer.phase)
            && ['receiving', 'loading'].includes(participant.response)) {
            participant.response = 'disconnected';
          }
          participant.socket = null;
          participant.disconnectedAt = Date.now();
        }
      }
    }

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
    return [...this.members.values()].map(({ sessionId, ...member }) => ({ ...member }));
  }

  memberForSocket(socket) {
    return this.members.get(socket) || null;
  }

  replaceMemberForSession(sessionId) {
    if (!sessionId) return null;
    for (const [socket, member] of this.members) {
      if (member.sessionId === sessionId) {
        return this.removeMember(socket);
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

  getRecordingChain() {
    return { ...this.recordingChain };
  }

  setRecordingChain(chain) {
    this.recordingChain = { ...chain };
  }

  isEmpty() {
    return this.members.size === 0;
  }

  beginProjectTransfer(adminSocket, metadata, now = Date.now()) {
    const caller = this.memberForSocket(adminSocket);
    if (!caller || caller.role !== 'admin') return { error: 'director_required' };
    if (this.projectTransfer && !['completed', 'cancelled'].includes(this.projectTransfer.phase)) {
      return { error: 'project_transfer_already_active' };
    }
    const participants = {};
    for (const [socket, member] of this.members) {
      if (socket === adminSocket) continue;
      participants[member.id] = {
        memberId: member.id,
        username: member.username,
        sessionId: member.sessionId,
        response: 'pending',
        progress: 0,
        socket,
        deadline: now + 60_000,
      };
    }
    this.projectTransfer = {
      requestId: metadata.request_id,
      metadata: { ...metadata },
      phase: Object.keys(participants).length === 0 ? 'completed' : 'collecting',
      participants,
      streamStarted: false,
      streamEnded: false,
      nextIndex: 0,
      receivedBytes: 0,
      lastActivity: now,
      cancelReason: null,
    };
    return { transfer: this.projectTransfer };
  }

  projectTransferForSocket(socket) {
    const member = this.memberForSocket(socket);
    return member && this.projectTransfer?.participants[member.id];
  }

  reattachProjectTransfer(socket, username, sessionId, now = Date.now()) {
    const transfer = this.projectTransfer;
    if (!transfer || ['completed', 'cancelled'].includes(transfer.phase)) return null;

    const candidate = Object.entries(transfer.participants).find(([, participant]) => {
      if (participant.socket) return false;
      const sameSession = sessionId && participant.sessionId === sessionId;
      const legacyUsernameMatch = (!sessionId || !participant.sessionId)
        && participant.username === username;
      return sameSession || legacyUsernameMatch;
    });
    if (!candidate) return null;

    const [oldMemberId, participant] = candidate;
    delete transfer.participants[oldMemberId];
    participant.memberId = socket.id;
    participant.socket = socket;
    participant.sessionId = sessionId || participant.sessionId || null;
    participant.disconnectedAt = null;
    transfer.participants[socket.id] = participant;
    if (transfer.acceptedIds) {
      transfer.acceptedIds = transfer.acceptedIds.map(memberId => (
        memberId === oldMemberId ? socket.id : memberId
      ));
    }

    if (transfer.phase === 'collecting' && participant.response === 'saving') {
      participant.response = 'pending';
      participant.deadline = now + 60_000;
    }

    const restarted = transfer.phase === 'finishing'
      && ['accepted', 'receiving', 'loading', 'loaded', 'disconnected']
        .includes(participant.response)
      && this.restartProjectTransfer(now);
    return { participant, restarted };
  }

  restartProjectTransfer(now = Date.now()) {
    const transfer = this.projectTransfer;
    if (!transfer || !['transferring', 'finishing'].includes(transfer.phase)) return false;
    const retryable = Object.values(transfer.participants)
      .filter(({ response }) => ['accepted', 'receiving', 'loading', 'loaded', 'disconnected']
        .includes(response));
    if (retryable.length === 0) return false;

    for (const participant of retryable) {
      participant.response = 'pending';
      participant.progress = 0;
      participant.deadline = now + 60_000;
      delete participant.error;
    }
    transfer.phase = 'collecting';
    transfer.streamStarted = false;
    transfer.streamEnded = false;
    transfer.nextIndex = 0;
    transfer.receivedBytes = 0;
    transfer.lastActivity = now;
    delete transfer.acceptedIds;
    return true;
  }

  projectTransferResponse(socket, requestId, response, now = Date.now()) {
    const transfer = this.projectTransfer;
    const member = this.memberForSocket(socket);
    const participant = member && transfer?.participants[member.id];
    if (!transfer || transfer.requestId !== requestId || !participant) {
      return { error: 'unknown_project_transfer' };
    }
    if (transfer.phase !== 'collecting') return { error: 'project_transfer_not_collecting' };
    if (!['saving', 'accepted', 'refused'].includes(response)) {
      return { error: 'invalid_project_transfer_response' };
    }
    participant.response = response;
    participant.deadline = response === 'saving' ? null : 0;
    if (response !== 'saving') this.evaluateProjectTransfer();
    return { transfer };
  }

  expireProjectTransferResponses(now = Date.now()) {
    const transfer = this.projectTransfer;
    if (!transfer || transfer.phase !== 'collecting') return false;
    let changed = false;
    for (const participant of Object.values(transfer.participants)) {
      if (participant.response === 'pending' && participant.deadline <= now) {
        participant.response = 'expired';
        participant.deadline = 0;
        changed = true;
      }
    }
    if (changed) this.evaluateProjectTransfer();
    return changed;
  }

  evaluateProjectTransfer() {
    const transfer = this.projectTransfer;
    if (!transfer || transfer.phase !== 'collecting') return false;
    const participants = Object.values(transfer.participants);
    if (participants.some(({ response }) => ['pending', 'saving'].includes(response))) return false;
    const accepted = participants.filter(({ response }) => response === 'accepted');
    if (accepted.length === 0) {
      transfer.phase = 'completed';
      transfer.streamEnded = true;
      return true;
    }
    transfer.phase = 'transferring';
    transfer.acceptedIds = accepted.map(({ memberId }) => memberId);
    for (const participant of accepted) participant.response = 'receiving';
    return true;
  }

  closeProjectTransferWaiting() {
    const transfer = this.projectTransfer;
    if (!transfer || transfer.phase !== 'collecting') return false;
    let changed = false;
    for (const participant of Object.values(transfer.participants)) {
      if (['pending', 'saving', 'accepted'].includes(participant.response)) {
        participant.response = 'refused';
        participant.deadline = 0;
        changed = true;
      }
    }
    return changed && this.evaluateProjectTransfer();
  }

  startProjectTransferStream(socket, data, now = Date.now()) {
    const transfer = this.projectTransfer;
    const caller = this.memberForSocket(socket);
    if (!transfer || caller?.role !== 'admin' || transfer.requestId !== data.request_id) {
      return { error: 'project_transfer_not_available' };
    }
    if (transfer.phase !== 'transferring' || transfer.streamStarted) {
      return { error: 'project_transfer_not_ready' };
    }
    for (const key of ['file_name', 'project_huuid', 'total_bytes', 'total_chunks', 'chunk_size', 'sha1']) {
      if (data[key] !== transfer.metadata[key]) return { error: 'project_transfer_metadata_mismatch' };
    }
    transfer.streamStarted = true;
    transfer.lastActivity = now;
    transfer.nextIndex = 0;
    transfer.receivedBytes = 0;
    return { transfer };
  }

  projectTransferChunk(socket, data, validation, now = Date.now()) {
    const transfer = this.projectTransfer;
    const caller = this.memberForSocket(socket);
    if (!transfer || caller?.role !== 'admin' || transfer.requestId !== data.request_id
      || transfer.phase !== 'transferring' || !transfer.streamStarted) {
      return { error: 'project_transfer_not_active' };
    }
    if (validation.error) return validation;
    transfer.nextIndex += 1;
    transfer.receivedBytes += validation.bytes;
    transfer.lastActivity = now;
    const progress = transfer.receivedBytes / transfer.metadata.total_bytes;
    for (const participant of Object.values(transfer.participants)) {
      if (participant.response === 'receiving') participant.progress = progress;
    }
    return { transfer };
  }

  finishProjectTransferStream(socket, requestId, now = Date.now()) {
    const transfer = this.projectTransfer;
    const caller = this.memberForSocket(socket);
    if (!transfer || caller?.role !== 'admin' || transfer.requestId !== requestId
      || transfer.phase !== 'transferring' || !transfer.streamStarted) {
      return { error: 'project_transfer_not_active' };
    }
    if (transfer.nextIndex !== transfer.metadata.total_chunks
      || transfer.receivedBytes !== transfer.metadata.total_bytes) {
      return { error: 'project_transfer_ended_before_completion' };
    }
    if (Object.values(transfer.participants).some(({ response }) => response === 'disconnected')) {
      this.restartProjectTransfer(now);
      return { transfer, restarted: true };
    }
    transfer.streamEnded = true;
    transfer.phase = 'finishing';
    transfer.lastActivity = now;
    return { transfer };
  }

  projectTransferLoading(socket, requestId, now = Date.now()) {
    const transfer = this.projectTransfer;
    const member = this.memberForSocket(socket);
    const participant = member && transfer?.participants[member.id];
    if (!transfer || transfer.requestId !== requestId || !participant) {
      return { error: 'unknown_project_transfer' };
    }
    if (participant.response !== 'receiving' || transfer.phase !== 'finishing') {
      return { error: 'project_transfer_recipient_not_accepted' };
    }
    participant.response = 'loading';
    participant.progress = 1;
    transfer.lastActivity = now;
    return { transfer };
  }

  projectTransferResult(socket, requestId, success, error) {
    const transfer = this.projectTransfer;
    const member = this.memberForSocket(socket);
    const participant = member && transfer?.participants[member.id];
    if (!transfer || transfer.requestId !== requestId || !participant) {
      return { error: 'unknown_project_transfer' };
    }
    // Result delivery is retried by clients when the final status races with
    // the import completion. Treat an already terminal participant as an
    // idempotent success instead of turning a completed transfer into an
    // error.
    if (['loaded', 'failed'].includes(participant.response)) return { transfer };
    if (!['receiving', 'loading'].includes(participant.response)) {
      return { error: 'project_transfer_recipient_not_accepted' };
    }
    if (!['finishing', 'transferring'].includes(transfer.phase)) {
      return { error: 'project_transfer_not_active' };
    }
    participant.response = success ? 'loaded' : 'failed';
    participant.progress = success ? 1 : participant.progress;
    if (success) this.projectHuuid = transfer.metadata.project_huuid;
    if (error) participant.error = String(error).slice(0, 512);
    this.completeProjectTransferIfReady();
    return { transfer };
  }

  completeProjectTransferIfReady() {
    const transfer = this.projectTransfer;
    if (!transfer || !transfer.streamEnded) return false;
    const accepted = Object.values(transfer.participants)
      .filter(({ response }) => ['receiving', 'loading', 'loaded', 'failed', 'disconnected'].includes(response));
    if (accepted.length > 0 && accepted.every(({ response }) => ['loaded', 'failed', 'disconnected'].includes(response))) {
      transfer.phase = 'completed';
      return true;
    }
    return false;
  }

  expireProjectTransfer(now = Date.now()) {
    const transfer = this.projectTransfer;
    // Once the director has sent every chunk, a slow recipient may still be
    // draining its socket. Only the source stream can be inactive here.
    if (!transfer || transfer.phase !== 'transferring') return false;
    if (now - transfer.lastActivity <= 300_000) return false;
    transfer.phase = 'cancelled';
    transfer.cancelReason = 'inactivity';
    return true;
  }

  cancelProjectTransfer(reason = 'protocol_error') {
    if (!this.projectTransfer || ['completed', 'cancelled'].includes(this.projectTransfer.phase)) return false;
    this.projectTransfer.phase = 'cancelled';
    this.projectTransfer.cancelReason = reason;
    return true;
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
  room.replaceMemberForSession(sessionId);
  room.addMember(socket, username, 'actor', sessionId);
  const reconnected = room.reattachProjectTransfer(socket, username, sessionId);
  return {
    room,
    projectMatches: Boolean(projectHuuid && room.projectHuuid === projectHuuid),
    reconnected,
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
  }
  return { room, member };
}

function getRoom(socket) {
  const code = socket.roomCode;
  return code ? rooms.get(code) : null;
}

module.exports = { Room, createRoom, joinRoom, leaveRoom, getRoom, rooms };
