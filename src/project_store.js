'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { validateProjectStart } = require('./recording_protocol');

// Reservations include incomplete uploads. Slow uploaders cannot collectively
// fill the disk beyond this process-wide budget.
class StorageBudget {
  constructor(maxBytes) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('invalid_storage_quota');
    this.maxBytes = maxBytes;
    this.usedBytes = 0;
  }

  reserve(bytes) {
    if (bytes > this.maxBytes - this.usedBytes) throw new Error('project_storage_quota_exceeded');
    this.usedBytes += bytes;
  }

  release(bytes) { this.usedBytes -= bytes; }
}

function canonicalMetadata(data) {
  const validation = validateProjectStart(data);
  if (validation.error) throw new Error(validation.error);
  return Object.fromEntries(['request_id', 'project_huuid', 'file_name', 'total_bytes',
    'total_chunks', 'chunk_size', 'sha1'].map(key => [key, data[key]]));
}

// One room owns one published archive and at most one replacement upload.
// All I/O is serialized, including disposal, so a disconnected room cannot
// leave an asynchronous write behind after its directory is removed.
class ProjectStore {
  constructor(root, budget, maxProjectBytes = 64 * 1024 ** 3) {
    this.root = root;
    this.budget = budget;
    this.maxProjectBytes = maxProjectBytes;
    this.current = null;
    this.upload = null;
    this.closed = false;
    this.pending = Promise.resolve();
  }

  get metadata() { return this.current ? { ...this.current.metadata } : null; }

  exclusive(operation) {
    const pending = this.pending.then(() => {
      if (this.closed) throw new Error('project_store_closed');
      return operation();
    });
    this.pending = pending.catch(() => {});
    return pending;
  }

  begin(data) {
    return this.exclusive(async () => {
      const metadata = canonicalMetadata(data);
      const existing = [this.upload, this.current].find(entry => entry?.metadata.request_id === metadata.request_id);
      if (existing) {
        if (JSON.stringify(existing.metadata) !== JSON.stringify(metadata)) throw new Error('project_metadata_conflict');
        return this.position(existing);
      }
      if (metadata.total_bytes > this.maxProjectBytes) throw new Error('project_storage_quota_exceeded');
      // Reusing an identical archive needs no new upload and no new disk space.
      if (this.current && ['sha1', 'total_bytes', 'chunk_size', 'project_huuid']
        .every(key => this.current.metadata[key] === metadata[key])) {
        await this.removeUpload();
        // Existing recipients keep reading with this canonical archive id.
        return this.position(this.current);
      }
      this.budget.reserve(metadata.total_bytes);
      let file;
      let filename;
      try {
        await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
        filename = path.join(this.root, `${randomUUID()}.part`);
        file = await fs.open(filename, 'wx+', 0o600);
        await this.removeUpload();
        this.upload = { metadata, filename, file, nextIndex: 0, receivedBytes: 0,
          digest: createHash('sha1'), lastActivity: Date.now(), complete: false };
        return this.position(this.upload);
      } catch (error) {
        await file?.close().catch(() => {});
        if (filename) await fs.unlink(filename).catch(() => {});
        this.budget.release(metadata.total_bytes);
        throw error;
      }
    });
  }

  position(entry) {
    return { next_index: entry.nextIndex, complete: entry.complete, metadata: { ...entry.metadata } };
  }

  write(requestId, index, data) {
    return this.exclusive(async () => {
      const upload = [this.upload, this.current].find(entry => entry?.metadata.request_id === requestId);
      if (!upload) throw new Error('unknown_project_upload');
      const meta = upload.metadata;
      if (!Number.isSafeInteger(index) || index < 0 || index >= meta.total_chunks) throw new Error('invalid_project_chunk_index');
      const expected = Math.min(meta.chunk_size, meta.total_bytes - index * meta.chunk_size);
      if (typeof data !== 'string' || data.length !== Math.ceil(expected / 3) * 4) throw new Error('invalid_project_chunk_size');
      const bytes = Buffer.from(data, 'base64');
      if (bytes.length !== expected || bytes.toString('base64') !== data) throw new Error('invalid_project_chunk_size_or_encoding');
      if (index > upload.nextIndex) throw new Error('project_chunk_out_of_order');
      if (index < upload.nextIndex) {
        // An ACK can be lost after a successful write. Compare the on-disk
        // block before accepting a retry; never silently accept changed data.
        const previous = await this.readBytes(upload, index);
        if (!previous.equals(bytes)) throw new Error('project_chunk_conflict');
        upload.lastActivity = Date.now();
        return this.position(upload);
      }
      let written = 0;
      while (written < bytes.length) {
        const result = await upload.file.write(bytes, written, bytes.length - written, upload.receivedBytes + written);
        if (!result.bytesWritten) throw new Error('project_disk_write_failed');
        written += result.bytesWritten;
      }
      upload.digest.update(bytes);
      upload.receivedBytes += bytes.length;
      upload.nextIndex++;
      upload.lastActivity = Date.now();
      return this.position(upload);
    });
  }

  finish(requestId) {
    return this.exclusive(async () => {
      if (this.current?.metadata.request_id === requestId) return this.position(this.current);
      const upload = this.upload;
      if (!upload || upload.metadata.request_id !== requestId) throw new Error('unknown_project_upload');
      if (upload.receivedBytes !== upload.metadata.total_bytes || upload.nextIndex !== upload.metadata.total_chunks) {
        throw new Error('project_upload_incomplete');
      }
      if (upload.digest.copy().digest('hex') !== upload.metadata.sha1) {
        await this.removeUpload();
        throw new Error('project_checksum_mismatch');
      }
      await upload.file.sync();
      const previous = this.current;
      upload.complete = true;
      this.current = upload;
      this.upload = null;
      if (previous) await this.removeEntry(previous);
      return this.position(upload);
    });
  }

  read(requestId, index) {
    return this.exclusive(async () => {
      const current = this.current;
      if (!current || current.metadata.request_id !== requestId) throw new Error('project_not_ready');
      if (!Number.isSafeInteger(index) || index < 0 || index >= current.metadata.total_chunks) throw new Error('invalid_project_chunk_index');
      const bytes = await this.readBytes(current, index);
      return { request_id: requestId, index, data: bytes.toString('base64') };
    });
  }

  async readBytes(entry, index) {
    const offset = index * entry.metadata.chunk_size;
    const bytes = Buffer.alloc(Math.min(entry.metadata.chunk_size, entry.metadata.total_bytes - offset));
    let read = 0;
    while (read < bytes.length) {
      const result = await entry.file.read(bytes, read, bytes.length - read, offset + read);
      if (!result.bytesRead) throw new Error('project_disk_read_incomplete');
      read += result.bytesRead;
    }
    return bytes;
  }

  async removeEntry(entry) {
    await entry.file.close();
    await fs.unlink(entry.filename);
    this.budget.release(entry.metadata.total_bytes);
  }

  async removeUpload() {
    if (!this.upload) return;
    const entry = this.upload;
    this.upload = null;
    await this.removeEntry(entry);
  }

  expire(now = Date.now()) {
    return this.exclusive(async () => {
      if (!this.upload || now - this.upload.lastActivity < 10 * 60_000) return false;
      await this.removeUpload();
      return true;
    });
  }

  abort(requestId) {
    return this.exclusive(async () => {
      if (this.upload?.metadata.request_id === requestId) await this.removeUpload();
    });
  }

  dispose() {
    if (this.closed) return this.pending;
    this.closed = true;
    this.pending = this.pending.then(async () => {
      await this.removeUpload();
      if (this.current) {
        const entry = this.current;
        this.current = null;
        await this.removeEntry(entry);
      }
    });
    return this.pending;
  }
}

module.exports = { ProjectStore, StorageBudget };
