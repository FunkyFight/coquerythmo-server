'use strict';

const { createHash, randomUUID } = require('node:crypto');
const CHUNK_BYTES = 192 * 1024;
const MAX_DIRECT_BYTES = 384 * 1024;
const MAX_STATE_BYTES = 64 * 1024 * 1024;
const validKey = key => /^(manifest|transport|view|lang\/[0-9]{1,20}\/(meta|settings|markers|characters|actors|line_order|drawing|line\/[0-9]{1,20}))$/.test(key);
const hash = bytes => createHash('sha1').update(bytes).digest('hex');

// Records are opaque domain values keyed by entity. This lets the Rust domain
// own all editing semantics (including undo and detection) while the server
// owns ordering, atomic commits, catch-up, bounds and room authority.
class StateStore {
  constructor({ maxBytes = MAX_STATE_BYTES, journalEntries = 256, budget = null } = {}) {
    this.maxBytes = maxBytes;
    this.journalEntries = journalEntries;
    this.budget = budget;
    this.records = new Map();
    this.sizes = new Map();
    this.bytes = 0;
    this.revision = 0;
    this.transportTime = 0;
    this.journal = [];
    this.journalBytes = 0;
    this.receipts = new Map();
    this.snapshots = new Map();
    this.upload = null;
  }

  info() {
    return { revision: this.revision, server_time: Date.now(), transport_time: this.transportTime };
  }

  publish(patch) {
    if (!patch || !/^[A-Za-z0-9_-]{1,128}$/.test(patch.update_id) || !Number.isSafeInteger(patch.base_revision)
      || patch.base_revision < 0 || typeof patch.replace !== 'boolean'
      || !patch.changes || typeof patch.changes !== 'object' || Array.isArray(patch.changes)) throw new Error('invalid_state_update');
    const serialized = JSON.stringify(patch);
    const fingerprint = hash(serialized);
    const receipt = this.receipts.get(patch.update_id);
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) throw new Error('state_update_id_conflict');
      return receipt.result;
    }
    if (patch.base_revision !== this.revision) throw new Error('state_revision_conflict');
    if (Buffer.byteLength(serialized) > this.maxBytes) throw new Error('state_size_limit');
    const changes = Object.entries(patch.changes);
    if (changes.length > 200_000) throw new Error('state_record_limit');
    const sizes = new Map();
    let nextBytes = patch.replace ? 0 : this.bytes;
    for (const [key, value] of changes) {
      if (!validKey(key)) throw new Error('invalid_state_record_key');
      const size = value === null ? 0 : Buffer.byteLength(JSON.stringify(value)) + key.length + 4;
      sizes.set(key, size);
      nextBytes += size - (patch.replace ? 0 : this.sizes.get(key) || 0);
    }
    if (nextBytes > this.maxBytes) throw new Error('state_size_limit');
    if (nextBytes > this.bytes) this.budget?.reserve(nextBytes - this.bytes);
    else this.budget?.release(this.bytes - nextBytes);
    if (patch.replace) { this.records.clear(); this.sizes.clear(); }
    for (const [key, value] of changes) {
      if (value === null) { this.records.delete(key); this.sizes.delete(key); }
      else { this.records.set(key, value); this.sizes.set(key, sizes.get(key)); }
    }
    this.bytes = nextBytes;
    this.revision++;
    if (Object.hasOwn(patch.changes, 'transport')) this.transportTime = Date.now();
    const result = this.info();
    this.receipts.set(patch.update_id, { fingerprint, result });
    while (this.receipts.size > 512) this.receipts.delete(this.receipts.keys().next().value);
    // A replacement establishes a new baseline; earlier diffs cannot be
    // replayed over it. Large diffs fall back to an immutable snapshot.
    if (patch.replace) { this.journal = []; this.journalBytes = 0; }
    const bytes = Buffer.byteLength(serialized);
    this.journal.push({ base: patch.base_revision, revision: this.revision,
      changes: patch.changes, replace: patch.replace, bytes });
    this.journalBytes += bytes;
    while (this.journal.length > this.journalEntries || this.journalBytes > 8 * 1024 * 1024) {
      this.journalBytes -= this.journal.shift().bytes;
    }
    return result;
  }

  pull(since) {
    if (!Number.isSafeInteger(since) || since < 0 || since > this.revision) throw new Error('invalid_state_revision');
    if (since === this.revision) return { ...this.info(), changes: {} };
    const start = this.journal.findIndex(entry => entry.base === since);
    if (start < 0) return { ...this.info(), snapshot_required: true };
    const changes = Object.create(null);
    let replace = false;
    for (const entry of this.journal.slice(start)) {
      if (entry.replace) { for (const key of Object.keys(changes)) delete changes[key]; replace = true; }
      Object.assign(changes, entry.changes);
    }
    const reply = { ...this.info(), changes, replace };
    if (Buffer.byteLength(JSON.stringify(reply)) > MAX_DIRECT_BYTES) return { ...this.info(), snapshot_required: true };
    return reply;
  }

  snapshotBegin(session) {
    this.expire();
    // Retrying a lost begin reply preserves this reader's snapshot. A new
    // reader joins the latest revision, independently of slower readers.
    let snapshot = [...this.snapshots.values()].find(value => value.readers.has(session));
    snapshot ||= [...this.snapshots.values()].find(value => value.revision === this.revision);
    if (!snapshot) {
      if (this.snapshots.size >= 256) throw new Error('state_snapshot_busy');
      const bytes = Buffer.from(JSON.stringify(Object.fromEntries(this.records)));
      this.budget?.reserve(bytes.length);
      snapshot = { bytes, id: randomUUID(), revision: this.revision,
        transportTime: this.transportTime, readers: new Map(), sha1: hash(bytes) };
      this.snapshots.set(snapshot.id, snapshot);
    }
    snapshot.readers.set(session, Date.now());
    return { snapshot_id: snapshot.id, revision: snapshot.revision, total_bytes: snapshot.bytes.length,
      total_chunks: Math.ceil(snapshot.bytes.length / CHUNK_BYTES), sha1: snapshot.sha1,
      transport_time: snapshot.transportTime, server_time: Date.now() };
  }

  snapshotRead(session, id, index) {
    const snapshot = this.snapshots.get(id);
    if (!snapshot || snapshot.id !== id || !snapshot.readers.has(session)) throw new Error('state_snapshot_not_open');
    if (!Number.isSafeInteger(index) || index < 0 || index >= Math.ceil(snapshot.bytes.length / CHUNK_BYTES)) throw new Error('invalid_state_chunk_index');
    snapshot.readers.set(session, Date.now());
    return { index, data: snapshot.bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES).toString('base64') };
  }

  snapshotEnd(session, id) {
    const snapshot = this.snapshots.get(id);
    if (!snapshot) return;
    snapshot.readers.delete(session);
    if (!snapshot.readers.size) {
      this.budget?.release(snapshot.bytes.length);
      this.snapshots.delete(id);
    }
  }

  uploadBegin(session, info) {
    if (!info || typeof info.update_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(info.update_id)
      || !Number.isSafeInteger(info.total_bytes) || info.total_bytes <= 0 || info.total_bytes > this.maxBytes
      || typeof info.sha1 !== 'string' || !/^[a-f0-9]{40}$/.test(info.sha1)) throw new Error('invalid_state_upload');
    if (this.receipts.has(info.update_id)) return { complete: true, ...this.receipts.get(info.update_id).result };
    if (this.upload?.id === info.update_id) {
      if (this.upload.session !== session || this.upload.sha1 !== info.sha1 || this.upload.bytes.length !== info.total_bytes) throw new Error('state_upload_conflict');
      return { next_index: this.upload.nextIndex };
    }
    if (this.upload) throw new Error('state_upload_busy');
    this.budget?.reserve(info.total_bytes);
    this.upload = { session, id: info.update_id, bytes: Buffer.alloc(info.total_bytes),
      sha1: info.sha1, nextIndex: 0, activity: Date.now() };
    return { next_index: 0 };
  }

  uploadChunk(session, id, index, encoded) {
    const upload = this.upload;
    if (!upload || upload.id !== id || upload.session !== session) throw new Error('unknown_state_upload');
    if (!Number.isSafeInteger(index) || index < 0 || index > upload.nextIndex) throw new Error('state_chunk_out_of_order');
    const expected = Math.min(CHUNK_BYTES, upload.bytes.length - index * CHUNK_BYTES);
    if (expected <= 0 || typeof encoded !== 'string' || encoded.length !== Math.ceil(expected / 3) * 4) throw new Error('invalid_state_chunk');
    const data = Buffer.from(encoded, 'base64');
    if (data.length !== expected || data.toString('base64') !== encoded) throw new Error('invalid_state_chunk');
    if (index < upload.nextIndex) {
      if (!data.equals(upload.bytes.subarray(index * CHUNK_BYTES, index * CHUNK_BYTES + expected))) throw new Error('state_chunk_conflict');
    } else { data.copy(upload.bytes, index * CHUNK_BYTES); upload.nextIndex++; }
    upload.activity = Date.now();
    return { next_index: upload.nextIndex };
  }

  uploadCommit(session, id) {
    if (this.receipts.has(id)) return this.receipts.get(id).result;
    const upload = this.upload;
    if (!upload || upload.id !== id || upload.session !== session) throw new Error('unknown_state_upload');
    if (upload.nextIndex !== Math.ceil(upload.bytes.length / CHUNK_BYTES)) throw new Error('state_upload_incomplete');
    this.upload = null;
    this.budget?.release(upload.bytes.length);
    if (hash(upload.bytes) !== upload.sha1) throw new Error('state_checksum_mismatch');
    const patch = JSON.parse(upload.bytes.toString('utf8'));
    if (patch.update_id !== id) throw new Error('state_upload_conflict');
    return this.publish(patch);
  }

  expire(now = Date.now()) {
    if (this.upload && now - this.upload.activity > 5 * 60_000) {
      this.budget?.release(this.upload.bytes.length);
      this.upload = null;
    }
    for (const snapshot of this.snapshots.values()) {
      for (const [session, activity] of snapshot.readers) {
        if (now - activity > 5 * 60_000) this.snapshotEnd(session, snapshot.id);
      }
    }
  }

  dispose() {
    this.budget?.release(this.bytes + [...this.snapshots.values()].reduce((sum, value) => sum + value.bytes.length, 0) + (this.upload?.bytes.length || 0));
    this.bytes = 0;
    this.records.clear();
    this.sizes.clear();
    this.snapshots.clear();
    this.upload = null;
    this.journal = [];
    this.journalBytes = 0;
    this.receipts.clear();
  }
}

module.exports = { StateStore, CHUNK_BYTES, MAX_STATE_BYTES };
