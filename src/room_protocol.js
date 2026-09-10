'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { ProjectStore, StorageBudget } = require('./project_store');
const { ProjectDistribution } = require('./project_distribution');
const { StateStore } = require('./state_store');

class RoomProtocol {
  constructor(root, emit, { maxStorageBytes = 128 * 1024 ** 3, maxProjectBytes = 64 * 1024 ** 3 } = {}) {
    this.root = root;
    this.emit = emit;
    this.budget = new StorageBudget(maxStorageBytes);
    this.maxProjectBytes = maxProjectBytes;
    this.stateBudget = new StorageBudget(256 * 1024 * 1024);
  }

  attach(room) {
    if (room.networkServices) return room.networkServices;
    const root = path.join(this.root, `${room.code}-${randomUUID()}`);
    const services = {
      store: new ProjectStore(root, this.budget, this.maxProjectBytes),
      distribution: new ProjectDistribution(room),
      previousDistribution: null,
      state: new StateStore({ budget: this.stateBudget }),
      lastStatus: 0,
    };
    room.networkServices = services;
    room.dispose = async () => {
      services.state.dispose();
      await services.store.dispose();
      await fs.rmdir(root).catch(error => { if (error.code !== 'ENOENT') throw error; });
    };
    return services;
  }

  status(room, force = false) {
    const services = this.attach(room);
    if (!force && Date.now() - services.lastStatus < 100) return;
    services.lastStatus = Date.now();
    for (const distribution of [services.previousDistribution, services.distribution]) {
      const status = distribution?.status();
      if (status) this.emit(room, 'project_transfer_status', status);
    }
  }

  join(room, socket) {
    const services = this.attach(room);
    const published = services.distribution.uploaded ? services.distribution : services.previousDistribution;
    published?.join(socket);
    this.status(room, true);
  }

  async dispatch(room, socket, method, data) {
    if (!room || !room.memberForSocket(socket)) throw new Error('not_in_room');
    const services = this.attach(room);
    const { store, state } = services;
    let distribution = [services.distribution, services.previousDistribution]
      .find(candidate => candidate?.metadata?.request_id === data.request_id) || services.distribution;
    const requireDirector = () => {
      if (room.memberForSocket(socket)?.role !== 'admin') throw new Error('director_required');
    };
    switch (method) {
      case 'state_info': return state.info();
      case 'state_publish': {
        requireDirector();
        const result = state.publish(data);
        this.emit(room, 'state_changed', result);
        return result;
      }
      case 'state_upload_begin':
        requireDirector();
        return state.uploadBegin(room.memberForSocket(socket).sessionId, data);
      case 'state_upload_chunk':
        requireDirector();
        return state.uploadChunk(room.memberForSocket(socket).sessionId, data.update_id, data.index, data.data);
      case 'state_upload_commit': {
        requireDirector();
        const result = state.uploadCommit(room.memberForSocket(socket).sessionId, data.update_id);
        this.emit(room, 'state_changed', result);
        return result;
      }
      case 'state_pull': return state.pull(data.since);
      case 'state_snapshot_begin': return state.snapshotBegin(room.memberForSocket(socket).sessionId);
      case 'state_snapshot_read': return state.snapshotRead(room.memberForSocket(socket).sessionId, data.snapshot_id, data.index);
      case 'state_snapshot_end':
        state.snapshotEnd(room.memberForSocket(socket).sessionId, data.snapshot_id);
        return {};
      case 'project_begin': {
        requireDirector();
        // Validate the target before reserving storage or changing metadata.
        if (data.member_id && !room.memberEntryById(data.member_id)) throw new Error('project_transfer_target_not_found');
        const result = await store.begin(data);
        if (room.isEmpty()) throw new Error('room_closed');
        if (services.distribution.metadata?.request_id !== result.metadata.request_id) {
          if (services.previousDistribution?.metadata?.request_id === result.metadata.request_id) {
            services.distribution = services.previousDistribution;
            services.previousDistribution = null;
          } else {
            if (services.distribution.uploaded) services.previousDistribution = services.distribution;
            services.distribution = new ProjectDistribution(room);
          }
        }
        distribution = services.distribution;
        distribution.begin(result.metadata, data.member_id);
        if (result.complete) {
          this.emit(room, 'project_available', result.metadata);
          distribution.publish(result.metadata);
          if (data.request_id !== result.metadata.request_id) {
            for (const [recipient, member] of room.members) {
              if (!data.member_id || member.id === data.member_id) distribution.join(recipient, true);
            }
          }
        }
        this.status(room, true);
        return result;
      }
      case 'project_write': {
        requireDirector();
        const result = await store.write(data.request_id, data.index, data.data);
        distribution.uploadedBytes = Math.min(result.next_index * result.metadata.chunk_size, result.metadata.total_bytes);
        this.status(room);
        return { next_index: result.next_index };
      }
      case 'project_commit': {
        requireDirector();
        const result = await store.finish(data.request_id);
        this.emit(room, 'project_available', result.metadata);
        distribution.publish(result.metadata);
        services.previousDistribution = null;
        this.status(room, true);
        return result;
      }
      case 'project_abort':
        requireDirector();
        await store.abort(data.request_id);
        if (distribution.metadata?.request_id === data.request_id && !distribution.uploaded) {
          distribution.error = String(data.error || 'upload_failed').slice(0, 512);
          this.status(room, true);
        }
        return {};
      case 'project_response':
        distribution.respond(socket, data.request_id, data.response);
        this.status(room, true);
        return {};
      case 'project_read': {
        if (!distribution.canDownload(socket, data.request_id)) throw new Error('project_transfer_not_accepted');
        const chunk = await store.read(data.request_id, data.index);
        distribution.progress(socket, data.request_id, data.index + 1);
        this.status(room);
        return chunk;
      }
      case 'project_loading':
        distribution.loading(socket, data.request_id);
        this.status(room, true);
        return {};
      case 'project_result':
        distribution.result(socket, data.request_id, data.success === true, data.error);
        this.status(room, true);
        return {};
      case 'time': return { server_time: Date.now() };
      default: throw new Error('unknown_protocol_method');
    }
  }
}

module.exports = { RoomProtocol };
