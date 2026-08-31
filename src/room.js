const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const CODE_LENGTH = 6;
const ZERO_INTEGRITY = '0000000000000000';
const RECONNECT_GRACE_MS = 60_000;

function generateCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return code;
}

class Room {
  constructor(code, adminSocket, adminUsername, projectHuuid, adminSessionId = null, protocolVersion = 1) {
    this.code = code;
    this.projectHuuid = projectHuuid;
    this.protocolVersion = protocolVersion;
    this.members = new Map(); // socket -> member; detached members keep their old key
    this.controlOwnerId = adminSessionId || adminSocket.id;
    this.activeRecording = null;
    this.completedAudioTransfers = new Set();
    this.recordingChain = {
      nextSequence: 0,
      previousIntegrity: ZERO_INTEGRITY,
    };
    this.projectTransfer = null;
    this.addMember(adminSocket, adminUsername, 'admin', adminSessionId);
  }

  addMember(socket, username, role, sessionId = null) {
    const member = {
      id: sessionId || socket.id,
      username,
      role,
      socket,
      socketId: socket.id,
      sessionId,
      muted: false,
      recording_ready: role === 'admin',
      connected: true,
      reconnect_deadline_ms: null,
      joinedAt: Date.now(),
      disconnectedAt: null,
    };
    this.members.set(socket, member);
    socket.roomCode = this.code;
    return member;
  }

  removeMember(socket, { promote = true, immediate = false } = {}) {
    if (!immediate) return this.detachMember(socket)?.member || null;
    const member = this.members.get(socket);
    if (!member) return null;
    this.members.delete(socket);
    socket.roomCode = null;
    member.socket = null;
    member.connected = false;
    member.reconnect_deadline_ms = null;

    this.detachProjectTransfer(member);
    this.cancelRecordingIfMemberLeaves(member);

    if (member.role === 'admin' && promote) {
      this.promoteOldestConnected();
    }

    if (member.id === this.controlOwnerId) {
      const admin = this.adminEntry();
      this.controlOwnerId = admin ? admin[1].id : null;
    }

    return member;
  }

  detachMember(socket, now = Date.now()) {
    const member = this.members.get(socket);
    if (!member || !member.connected) return null;
    member.connected = false;
    member.socket = null;
    member.socketId = socket.id;
    member.disconnectedAt = now;
    member.reconnect_deadline_ms = now + RECONNECT_GRACE_MS;
    socket.roomCode = null;
    this.detachProjectTransfer(member, now);
    const recordingCancelled = this.cancelRecordingIfMemberLeaves(member);
    return { member, recordingCancelled };
  }

  reattachMember(socket, username, sessionId) {
    if (!sessionId) return null;
    for (const [oldSocket, member] of this.members) {
      if (member.sessionId !== sessionId) continue;
      this.members.delete(oldSocket);
      if (oldSocket !== socket) oldSocket.roomCode = null;
      this.members.set(socket, member);
      member.socket = socket;
      member.socketId = socket.id;
      member.connected = true;
      member.reconnect_deadline_ms = null;
      member.disconnectedAt = null;
      socket.roomCode = this.code;
      // The session identity owns the role and mute/readiness state. The
      // username in a reconnect packet is only a fallback for legacy clients.
      if (!member.username && username) member.username = username;
      const transfer = this.reattachProjectTransfer(socket, username, sessionId);
      return { member, transfer };
    }
    return null;
  }

  expireDetachedMembers(now = Date.now()) {
    const expired = [...this.members.entries()]
      .filter(([, member]) => !member.connected
        && member.reconnect_deadline_ms !== null
        && member.reconnect_deadline_ms <= now);
    if (expired.length === 0) return false;
    let adminExpired = false;
    for (const [socket, member] of expired) {
      adminExpired ||= member.role === 'admin';
      this.members.delete(socket);
      this.detachProjectTransfer(member, now);
    }
    if (adminExpired && !this.adminEntry()) this.promoteOldestConnected();
    return true;
  }

  promoteOldestConnected() {
    const candidates = [...this.members.values()]
      .filter(member => member.connected && member.socket)
      .sort((a, b) => a.joinedAt - b.joinedAt);
    const candidate = candidates.find(member => member.role === 'co_da')
      || candidates.find(member => member.role !== 'admin');
    if (!candidate) {
      this.controlOwnerId = null;
      return null;
    }
    candidate.role = 'admin';
    candidate.recording_ready = true;
    this.controlOwnerId = candidate.id;
    candidate.socket.emit('room_created', {
      code: this.code,
      project_huuid: this.projectHuuid,
      member_id: candidate.id,
      resumed: false,
      protocol_version: this.protocolVersion,
    });
    return candidate;
  }

  detachProjectTransfer(member, now = Date.now()) {
    if (!this.projectTransfer || !member) return;
    if (member.role === 'admin') {
      this.projectTransfer.phase = 'cancelled';
      this.projectTransfer.cancelReason = 'director_left';
      return;
    }
    const participant = Object.values(this.projectTransfer.participants)
      .find(candidate => candidate.memberId === member.id);
    if (participant) {
      if (['transferring', 'finishing'].includes(this.projectTransfer.phase)
        && ['receiving', 'loading'].includes(participant.response)) {
        participant.response = 'disconnected';
      }
      participant.socket = null;
      participant.disconnectedAt = now;
    }
  }

  cancelRecordingIfMemberLeaves(member) {
    if (!this.activeRecording || !member) return null;
    const { phase, requiredIds } = this.activeRecording;
    if (!['preparing', 'started'].includes(phase)
      || (member.role !== 'admin' && !requiredIds.has(member.id))) return null;
    this.activeRecording.phase = 'cancelled';
    this.activeRecording.cancelReason = 'participant_disconnected';
    return this.activeRecording;
  }

  getMemberUsernames() {
    return [...this.members.values()].map(m => m.username);
  }

  getMemberList() {
    return [...this.members.values()].map(member => ({
      id: member.id,
      username: member.username,
      role: member.role,
      muted: member.muted,
      recording_ready: member.recording_ready,
      connected: member.connected,
      reconnect_deadline_ms: member.reconnect_deadline_ms,
    }));
  }

  memberForSocket(socket) {
    return this.members.get(socket) || null;
  }

  replaceMemberForSession(sessionId) {
    if (!sessionId) return null;
    for (const [socket, member] of this.members) {
      if (member.sessionId === sessionId) {
        return this.reattachMember(socket, member.username, sessionId)?.member || null;
      }
    }
    return null;
  }

  memberEntryById(memberId) {
    for (const [socket, member] of this.members) {
      if (member.id === memberId || socket.id === memberId || member.socketId === memberId) {
        return [member.socket || socket, member];
      }
    }
    return null;
  }

  adminEntry() {
    for (const [socket, member] of this.members) {
      if (member.role === 'admin' && member.connected && member.socket) {
        return [member.socket, member];
      }
    }
    return null;
  }

  canControl(socket) {
    const member = this.memberForSocket(socket);
    return Boolean(member?.connected && (member.role === 'admin' || member.id === this.controlOwnerId));
  }

  setCoDirector(memberId, enabled) {
    const entry = this.memberEntryById(memberId);
    if (!entry || entry[1].role === 'admin') return false;
    entry[1].role = enabled ? 'co_da' : 'actor';
    if (!enabled && this.controlOwnerId === entry[1].id) {
      const admin = this.adminEntry();
      this.controlOwnerId = admin ? admin[1].id : null;
    }
    return true;
  }

  setControlOwner(memberId) {
    const entry = this.memberEntryById(memberId);
    if (!entry || !entry[1].connected || !['admin', 'co_da'].includes(entry[1].role)) return false;
    this.controlOwnerId = entry[1].id;
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

  connectedMemberIds() {
    return [...this.members.values()]
      .filter(member => member.connected)
      .map(member => member.id);
  }

  beginRecording(socket, payload, now = Date.now()) {
    if (!this.canControl(socket)) return { error: 'recording_control_required' };
    const takeId = payload?.take_id;
    if (typeof takeId !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(takeId)) {
      return { error: 'recording_take_id_invalid' };
    }
    if (this.activeRecording && this.activeRecording.takeId === takeId) {
      return { recording: this.activeRecording, repeated: true };
    }
    if (this.activeRecording && ['preparing', 'started'].includes(this.activeRecording.phase)) {
      return { error: 'recording_already_active' };
    }
    const requiredIds = new Set([...this.members.values()]
      .filter(member => member.connected && member.role === 'actor' && !member.muted)
      .map(member => member.id));
    this.activeRecording = {
      takeId,
      payload: { ...payload },
      phase: 'preparing',
      requiredIds,
      prepared: new Map(),
      deadline: now + 10_000,
      startAt: null,
      cancelReason: null,
    };
    if (requiredIds.size === 0) this.startRecording(now);
    return { recording: this.activeRecording };
  }

  prepareRecording(socket, takeId, ready, error, now = Date.now()) {
    const recording = this.activeRecording;
    const member = this.memberForSocket(socket);
    if (!recording || recording.takeId !== takeId || !member) {
      return { error: 'recording_take_unknown' };
    }
    if (recording.phase === 'started') return { recording, repeated: true };
    if (recording.phase !== 'preparing' || !recording.requiredIds.has(member.id)) {
      return { recording, repeated: true };
    }
    recording.prepared.set(member.id, { ready: ready === true, error: error || null });
    if (ready !== true) {
      recording.phase = 'cancelled';
      recording.cancelReason = error || 'participant_not_ready';
      return { recording, cancelled: true };
    }
    if ([...recording.requiredIds].every(id => recording.prepared.get(id)?.ready === true)) {
      this.startRecording(now);
      return { recording, started: true };
    }
    return { recording };
  }

  startRecording(now = Date.now()) {
    if (!this.activeRecording || this.activeRecording.phase !== 'preparing') return false;
    this.activeRecording.phase = 'started';
    this.activeRecording.startAt = now + 3_000;
    return true;
  }

  stopRecording(socket, takeId) {
    const recording = this.activeRecording;
    if (!this.canControl(socket)) return { error: 'recording_control_required' };
    if (!recording || recording.takeId !== takeId) return { error: 'recording_take_unknown' };
    if (recording.phase === 'preparing') {
      recording.phase = 'cancelled';
      recording.cancelReason = 'stopped_during_preparation';
    } else if (recording.phase === 'started') {
      recording.phase = 'stopped';
    }
    return { recording };
  }

  cancelRecording(socket, takeId, reason = 'cancelled') {
    const recording = this.activeRecording;
    if (socket && !this.canControl(socket)) return { error: 'recording_control_required' };
    if (!recording || recording.takeId !== takeId) return { error: 'recording_take_unknown' };
    recording.phase = 'cancelled';
    recording.cancelReason = reason;
    return { recording };
  }

  expireRecordingPreparation(now = Date.now()) {
    const recording = this.activeRecording;
    if (!recording || recording.phase !== 'preparing' || recording.deadline > now) return null;
    recording.phase = 'cancelled';
    recording.cancelReason = 'preparation_timeout';
    return recording;
  }

  beginProjectTransfer(adminSocket, metadata, now = Date.now()) {
    const caller = this.memberForSocket(adminSocket);
    if (!caller || caller.role !== 'admin') return { error: 'director_required' };
    if (this.projectTransfer && !['completed', 'cancelled'].includes(this.projectTransfer.phase)) {
      return { error: 'project_transfer_already_active' };
    }
    const participants = {};
    for (const [socket, member] of this.members) {
      if (member.id === this.memberForSocket(adminSocket)?.id) continue;
      participants[socket.id] = {
        memberId: member.id,
        username: member.username,
        sessionId: member.sessionId,
        response: 'pending',
        progress: 0,
        socket: member.socket,
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
    if (!member || !this.projectTransfer) return null;
    return Object.values(this.projectTransfer.participants)
      .find(participant => participant.memberId === member.id);
  }

  reattachProjectTransfer(socket, username, sessionId, now = Date.now()) {
    const transfer = this.projectTransfer;
    if (!transfer || ['completed', 'cancelled'].includes(transfer.phase)) return null;

    const candidate = Object.entries(transfer.participants).find(([, participant]) => {
      const sameSession = sessionId && participant.sessionId === sessionId;
      const legacyUsernameMatch = (!sessionId || !participant.sessionId)
        && participant.username === username;
      return sameSession || legacyUsernameMatch;
    });
    if (!candidate) return null;

    const [oldMemberId, participant] = candidate;
    delete transfer.participants[oldMemberId];
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
    const participant = this.projectTransferForSocket(socket);
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
    const participant = this.projectTransferForSocket(socket);
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
    const participant = this.projectTransferForSocket(socket);
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

function createRoom(socket, username, projectHuuid, sessionId = null, protocolVersion = 1) {
  let code;
  do { code = generateCode(); } while (rooms.has(code));

  const room = new Room(code, socket, username, projectHuuid, sessionId, protocolVersion);
  rooms.set(code, room);
  return room;
}

function roomForSession(sessionId) {
  if (!sessionId) return null;
  for (const room of rooms.values()) {
    for (const member of room.members.values()) {
      if (member.sessionId === sessionId) return room;
    }
  }
  return null;
}

function resumeRoom(socket, username, projectHuuid, sessionId, protocolVersion = 1) {
  const room = roomForSession(sessionId);
  if (!room || room.protocolVersion !== protocolVersion) return null;
  const reattached = room.reattachMember(socket, username, sessionId);
  if (!reattached) return null;
  const { member } = reattached;
  return {
    room,
    member,
    projectMatches: Boolean(projectHuuid && room.projectHuuid === projectHuuid),
    reconnected: true,
    transfer: reattached.transfer,
  };
}

function joinRoom(socket, code, username, projectHuuid, sessionId = null, protocolVersion = 1) {
  const room = rooms.get(code);
  if (!room) return { error: 'room_not_found' };
  if (room.protocolVersion !== protocolVersion) return { error: 'protocol_version_mismatch' };
  const reattached = room.reattachMember(socket, username, sessionId);
  const member = reattached?.member;
  const reconnected = Boolean(reattached);
  if (!member) room.addMember(socket, username, 'actor', sessionId);
  return {
    room,
    member: member || room.memberForSocket(socket),
    projectMatches: Boolean(projectHuuid && room.projectHuuid === projectHuuid),
    reconnected: reconnected
      ? { restarted: Boolean(reattached.transfer?.restarted), transfer: reattached.transfer }
      : null,
  };
}

function leaveRoom(socket) {
  const code = socket.roomCode;
  if (!code) return null;
  const room = rooms.get(code);
  if (!room) return null;

  const member = room.removeMember(socket, { immediate: true });
  if (room.isEmpty()) {
    rooms.delete(code);
  }
  return { room, member };
}

function getRoom(socket) {
  const code = socket.roomCode;
  return code ? rooms.get(code) : null;
}

module.exports = {
  RECONNECT_GRACE_MS,
  Room,
  createRoom,
  joinRoom,
  leaveRoom,
  getRoom,
  roomForSession,
  resumeRoom,
  rooms,
};
