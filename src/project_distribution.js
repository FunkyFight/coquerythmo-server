'use strict';

// Invitation and import progress are separate from the archive's lifetime.
// Participants are keyed by authenticated session, never by a transient socket
// id or a display name. Every recipient advances independently.
class ProjectDistribution {
  constructor(room) {
    this.room = room;
    this.metadata = null;
    this.participants = new Map();
    this.uploaded = false;
    this.uploadedBytes = 0;
    this.error = null;
    this.targetSession = null;
  }

  begin(metadata, targetId = null) {
    const target = targetId ? this.room.memberEntryById(targetId)?.[1] : null;
    if (targetId && !target) throw new Error('project_transfer_target_not_found');
    if (this.metadata?.request_id === metadata.request_id) return;
    this.metadata = { ...metadata };
    this.uploaded = false;
    this.uploadedBytes = 0;
    this.error = null;
    this.targetSession = target?.sessionId || null;
    this.participants.clear();
  }

  publish(metadata) {
    if (this.metadata?.request_id !== metadata.request_id) return;
    this.uploaded = true;
    this.uploadedBytes = metadata.total_bytes;
    this.room.projectHuuid = metadata.project_huuid;
    for (const [socket, member] of this.room.members) {
      if (!this.targetSession || member.sessionId === this.targetSession) this.join(socket);
    }
  }

  join(socket, reinvite = false) {
    const member = this.room.memberForSocket(socket);
    if (!member || member.role === 'admin' || !this.uploaded) return;
    const key = member.sessionId;
    let participant = this.participants.get(key);
    if (!participant) {
      participant = { member_id: member.id, username: member.username,
        response: 'pending', progress: 0, deadline: null };
      this.participants.set(key, participant);
    }
    participant.member_id = member.id;
    if (reinvite && ['refused', 'failed'].includes(participant.response)) {
      participant.response = 'pending';
      participant.progress = 0;
      delete participant.error;
    }
    if (!['loaded', 'refused'].includes(participant.response)) {
      socket.emit('project_transfer_request', { ...this.metadata });
    }
  }

  participant(socket, requestId) {
    const member = this.room.memberForSocket(socket);
    const participant = member && this.participants.get(member.sessionId);
    if (!participant || this.metadata?.request_id !== requestId) throw new Error('unknown_project_transfer');
    return participant;
  }

  respond(socket, requestId, response) {
    if (!['saving', 'accepted', 'refused'].includes(response)) throw new Error('invalid_project_transfer_response');
    const participant = this.participant(socket, requestId);
    if (['receiving', 'loading', 'loaded'].includes(participant.response)) return;
    participant.response = response === 'accepted' ? 'receiving' : response;
    delete participant.error;
  }

  canDownload(socket, requestId) {
    const participant = this.participant(socket, requestId);
    return this.uploaded && ['receiving', 'loading', 'loaded'].includes(participant.response);
  }

  progress(socket, requestId, nextIndex) {
    const participant = this.participant(socket, requestId);
    if (participant.response === 'receiving') {
      participant.progress = Math.max(participant.progress, nextIndex / this.metadata.total_chunks);
    }
  }

  loading(socket, requestId) {
    const participant = this.participant(socket, requestId);
    if (participant.response === 'loaded') return;
    if (participant.response !== 'receiving') throw new Error('project_transfer_not_accepted');
    participant.response = 'loading';
    participant.progress = 1;
  }

  result(socket, requestId, success, error) {
    const participant = this.participant(socket, requestId);
    if (participant.response === 'loaded') return;
    if (!['receiving', 'loading', 'failed'].includes(participant.response)) throw new Error('project_transfer_not_accepted');
    participant.response = success ? 'loaded' : 'failed';
    if (success) participant.progress = 1;
    if (error) participant.error = String(error).slice(0, 512);
  }

  closeWaiting() {
    for (const participant of this.participants.values()) {
      if (['pending', 'saving'].includes(participant.response)) participant.response = 'refused';
    }
  }

  status() {
    if (!this.metadata) return null;
    const participants = [...this.participants.values()].map(value => ({ ...value }));
    let phase = 'uploading';
    if (this.uploaded) {
      phase = participants.some(p => ['receiving', 'pending', 'saving'].includes(p.response)) ? 'transferring' : 'finishing';
      if (participants.every(p => ['loaded', 'failed', 'refused'].includes(p.response))) phase = 'completed';
    }
    if (this.error) phase = 'cancelled';
    return { request_id: this.metadata.request_id, phase, total_bytes: this.metadata.total_bytes,
      transferred_bytes: this.uploadedBytes, participants, cancel_reason: this.error };
  }
}

module.exports = { ProjectDistribution };
