const AUDIO_CHUNK_MAX_BYTES = 256 * 1024;
const AUDIO_MAX_BYTES = 4 * 1024 * 1024 * 1024;
const PROJECT_CHUNK_MAX_BYTES = 192 * 1024;
const PROJECT_MAX_BYTES = 64 * 1024 * 1024 * 1024;
const MAX_RECORDING_TRANSACTION_BYTES = 4 * 1024 * 1024;
const MAX_RECORDING_ENTRIES = 10000;
const MAX_BATCH_OPERATIONS = 1024;
const MAX_OPERATION_DEPTH = 8;
const ZERO_INTEGRITY = '0000000000000000';
const KNOWN_OPERATIONS = new Set([
  'batch',
  'add_asset',
  'remove_asset',
  'add_track',
  'remove_track',
  'rename_track',
  'set_track_muted',
  'set_track_solo',
  'arm_track',
  'add_clip',
  'move_clips',
  'split_clip',
  'delete_clips',
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSafeNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isHexIntegrity(value) {
  return typeof value === 'string' && /^[a-f0-9]{16}$/.test(value);
}

function requiredField(operation, field, predicate) {
  return Object.prototype.hasOwnProperty.call(operation, field) && predicate(operation[field]);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateOperation(operation, depth = 0) {
  if (!isObject(operation)) return 'operation must be an object';
  if (depth > MAX_OPERATION_DEPTH) return 'recording operation nesting is too deep';
  if (typeof operation.op !== 'string' || !KNOWN_OPERATIONS.has(operation.op)) {
    return 'unknown recording operation';
  }

  switch (operation.op) {
    case 'batch':
      if (!Array.isArray(operation.operations) || operation.operations.length > MAX_BATCH_OPERATIONS) {
        return 'recording batch is missing or too large';
      }
      for (const nested of operation.operations) {
        const error = validateOperation(nested, depth + 1);
        if (error) return error;
      }
      return null;
    case 'add_asset':
      return requiredField(operation, 'asset', isObject) ? null : 'add_asset.asset is invalid';
    case 'remove_asset':
      return requiredField(operation, 'asset_id', isSafeNonNegativeInteger)
        ? null : 'remove_asset.asset_id is invalid';
    case 'add_track':
      return requiredField(operation, 'track', isObject) ? null : 'add_track.track is invalid';
    case 'remove_track':
      return requiredField(operation, 'track_id', isSafeNonNegativeInteger)
        ? null : 'remove_track.track_id is invalid';
    case 'rename_track':
      if (!requiredField(operation, 'track_id', isSafeNonNegativeInteger)
        || !requiredField(operation, 'name', value => typeof value === 'string')) {
        return 'rename_track fields are invalid';
      }
      return null;
    case 'set_track_muted':
      if (!requiredField(operation, 'track_id', isSafeNonNegativeInteger)
        || !requiredField(operation, 'muted', value => typeof value === 'boolean')) {
        return `${operation.op} fields are invalid`;
      }
      return null;
    case 'set_track_solo':
      if (!requiredField(operation, 'track_id', isSafeNonNegativeInteger)
        || !requiredField(operation, 'solo', value => typeof value === 'boolean')) {
        return `${operation.op} fields are invalid`;
      }
      return null;
    case 'arm_track':
      return requiredField(
        operation,
        'track_id',
        value => value === null || isSafeNonNegativeInteger(value),
      ) ? null : 'arm_track.track_id is invalid';
    case 'add_clip':
      return requiredField(operation, 'clip', isObject) ? null : 'add_clip.clip is invalid';
    case 'move_clips':
      return Array.isArray(operation.placements)
        && operation.placements.length <= MAX_BATCH_OPERATIONS
        && operation.placements.every(isObject)
        ? null : 'move_clips.placements are invalid';
    case 'split_clip':
      if (!requiredField(operation, 'clip_id', isSafeNonNegativeInteger)
        || !requiredField(operation, 'at_frame', isFiniteNumber)
        || !requiredField(operation, 'right_clip_id', isSafeNonNegativeInteger)) {
        return 'split_clip fields are invalid';
      }
      return null;
    case 'delete_clips':
      return Array.isArray(operation.clip_ids)
        && operation.clip_ids.length <= MAX_BATCH_OPERATIONS
        && operation.clip_ids.every(isSafeNonNegativeInteger)
        ? null : 'delete_clips.clip_ids are invalid';
    default:
      return 'unknown recording operation';
  }
}

function validateRecordingTransaction(transaction, expected) {
  // Rust peers verify the operation hash; the relay owns bounds and ordering.
  if (!isObject(transaction)) return { error: 'recording transaction must be an object' };
  if (!isSafeNonNegativeInteger(transaction.sequence)) {
    return { error: 'recording transaction sequence is invalid' };
  }
  if (!isHexIntegrity(transaction.previous_integrity)
    || !isHexIntegrity(transaction.integrity)) {
    return { error: 'recording transaction integrity fields are invalid' };
  }

  const operationError = validateOperation(transaction.operation);
  if (operationError) return { error: operationError };

  let serialized;
  try {
    serialized = JSON.stringify(transaction);
  } catch (error) {
    return { error: `recording transaction is not serializable: ${error.message}` };
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_RECORDING_TRANSACTION_BYTES) {
    return { error: 'recording transaction is too large' };
  }

  if (expected) {
    if (transaction.sequence !== expected.nextSequence) {
      return {
        error: `recording transaction sequence ${transaction.sequence} is not ${expected.nextSequence}`,
      };
    }
    if (transaction.previous_integrity !== expected.previousIntegrity) {
      return { error: 'recording transaction previous integrity mismatch' };
    }
  }

  return {
    nextChain: {
      nextSequence: transaction.sequence + 1,
      previousIntegrity: transaction.integrity,
    },
  };
}

function validateRecordingLog(log) {
  if (!isObject(log) || !Array.isArray(log.entries)) {
    return { error: 'recording transaction log is invalid' };
  }
  if (!isSafeNonNegativeInteger(log.cursor) || log.cursor > log.entries.length) {
    return { error: 'recording transaction cursor is invalid' };
  }
  if (log.entries.length > MAX_RECORDING_ENTRIES) {
    return { error: 'recording transaction log is too large' };
  }

  let chain = { nextSequence: 0, previousIntegrity: ZERO_INTEGRITY };
  for (const transaction of log.entries) {
    const result = validateRecordingTransaction(transaction, chain);
    if (result.error) return result;
    chain = result.nextChain;
  }

  const activeChain = log.cursor === 0
    ? { nextSequence: 0, previousIntegrity: ZERO_INTEGRITY }
    : {
        nextSequence: log.cursor,
        previousIntegrity: log.entries[log.cursor - 1].integrity,
      };
  return { chain: activeChain };
}

function validateRecordingPrepare(data) {
  if (!isObject(data) || !isObject(data.project) || !isObject(data.transactions)) {
    return { error: 'recording preparation payload is invalid' };
  }
  if (!isSafeNonNegativeInteger(data.current_frame)) {
    return { error: 'recording preparation frame is invalid' };
  }
  if (data.capture_target !== undefined && data.capture_target !== null
    && !isObject(data.capture_target)) {
    return { error: 'recording preparation capture target is invalid' };
  }
  return validateRecordingLog(data.transactions);
}

function validateAudioStart(data) {
  if (!isObject(data)) return { error: 'audio_start payload is invalid' };
  if (typeof data.transfer_id !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(data.transfer_id)) {
    return { error: 'audio transfer id is invalid' };
  }
  if (typeof data.file_name !== 'string' || data.file_name.length > 256
    || data.file_name.trim() !== data.file_name
    || data.file_name.length === 0
    || data.file_name === '.' || data.file_name === '..'
    || data.file_name.includes('/') || data.file_name.includes('\\')
    || data.file_name.includes(':') || [...data.file_name].some(char => /\p{Cc}/u.test(char))
    || !data.file_name.toLowerCase().endsWith('.flac')) {
    return { error: 'audio file name is invalid' };
  }
  if (!Number.isSafeInteger(data.total_bytes) || data.total_bytes <= 0
    || data.total_bytes > AUDIO_MAX_BYTES) {
    return { error: 'audio transfer size is invalid' };
  }
  if (!Number.isSafeInteger(data.total_chunks) || data.total_chunks <= 0
    || !Number.isSafeInteger(data.chunk_size) || data.chunk_size <= 0
    || data.chunk_size > AUDIO_CHUNK_MAX_BYTES
    || data.total_chunks !== Math.ceil(data.total_bytes / data.chunk_size)) {
    return { error: 'audio transfer chunk geometry is invalid' };
  }
  if (typeof data.sha1 !== 'string' || !/^[a-f0-9]{40}$/.test(data.sha1)) {
    return { error: 'audio transfer SHA-1 is invalid' };
  }
  return { bytes: data.total_bytes };
}

function validateProjectStart(data) {
  if (!isObject(data)) return { error: 'project_transfer payload is invalid' };
  if (typeof data.request_id !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(data.request_id)) {
    return { error: 'project transfer id is invalid' };
  }
  if (typeof data.file_name !== 'string' || data.file_name.length > 256
    || data.file_name.trim() !== data.file_name || data.file_name.length === 0
    || data.file_name === '.' || data.file_name === '..'
    || data.file_name.includes('/') || data.file_name.includes('\\')
    || data.file_name.includes(':') || [...data.file_name].some(char => /\p{Cc}/u.test(char))
    || !data.file_name.toLowerCase().endsWith('.coquerythmo')) {
    return { error: 'project file name is invalid' };
  }
  if (typeof data.project_huuid !== 'string' || data.project_huuid.length === 0
    || data.project_huuid.length > 256 || [...data.project_huuid].some(char => /\p{Cc}/u.test(char))) {
    return { error: 'project HUUID is invalid' };
  }
  if (!Number.isSafeInteger(data.total_bytes) || data.total_bytes <= 0
    || data.total_bytes > PROJECT_MAX_BYTES) {
    return { error: 'project transfer size is invalid' };
  }
  if (!Number.isSafeInteger(data.total_chunks) || data.total_chunks <= 0
    || !Number.isSafeInteger(data.chunk_size) || data.chunk_size <= 0
    || data.chunk_size > PROJECT_CHUNK_MAX_BYTES
    || data.total_chunks !== Math.ceil(data.total_bytes / data.chunk_size)) {
    return { error: 'project transfer chunk geometry is invalid' };
  }
  if (typeof data.sha1 !== 'string' || !/^[a-f0-9]{40}$/.test(data.sha1)) {
    return { error: 'project transfer SHA-1 is invalid' };
  }
  return { bytes: data.total_bytes };
}

function validateProjectChunk(data, transfer) {
  if (!isObject(data) || typeof data.request_id !== 'string'
    || !/^[A-Za-z0-9_-]{1,96}$/.test(data.request_id)
    || !Number.isSafeInteger(data.index) || data.index < 0) {
    return { error: 'project chunk header is invalid' };
  }
  if (!transfer) return { error: 'unknown project transfer' };
  if (data.request_id !== transfer.requestId) return { error: 'project transfer id mismatch' };
  if (data.index !== transfer.nextIndex) {
    return { error: `project chunk out of order: expected ${transfer.nextIndex}` };
  }
  const decoded = decodeCanonicalBase64(data.data);
  if (!decoded || decoded.length === 0 || decoded.length > transfer.chunkSize) {
    return { error: 'project chunk base64 or size is invalid' };
  }
  if (transfer.receivedBytes + decoded.length > transfer.totalBytes) {
    return { error: 'project transfer exceeds announced size' };
  }
  return { bytes: decoded.length };
}

function decodeCanonicalBase64(data) {
  if (typeof data !== 'string' || data.length === 0 || data.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    return null;
  }
  const decoded = Buffer.from(data, 'base64');
  return decoded.toString('base64') === data ? decoded : null;
}

function validateAudioChunk(data, transfer) {
  if (!isObject(data) || typeof data.transfer_id !== 'string'
    || !/^[A-Za-z0-9_-]{1,96}$/.test(data.transfer_id)
    || !Number.isSafeInteger(data.index) || data.index < 0) {
    return { error: 'audio chunk header is invalid' };
  }
  if (!transfer) return { error: 'unknown audio transfer' };
  if (data.index !== transfer.nextIndex) {
    return { error: `audio chunk out of order: expected ${transfer.nextIndex}` };
  }
  const decoded = decodeCanonicalBase64(data.data);
  if (!decoded || decoded.length === 0 || decoded.length > transfer.chunkSize) {
    return { error: 'audio chunk base64 or size is invalid' };
  }
  if (transfer.receivedBytes + decoded.length > transfer.totalBytes) {
    return { error: 'audio transfer exceeds announced size' };
  }
  return { bytes: decoded.length };
}

function expiredTransferIds(transfers, now, timeout) {
  return [...transfers]
    .filter(([, transfer]) => now - transfer.lastActivity > timeout)
    .map(([transferId]) => transferId);
}

function relayAudio(room, sender, event, data) {
  sender.to(room.code).emit(event, data);
}

module.exports = {
  AUDIO_CHUNK_MAX_BYTES,
  AUDIO_MAX_BYTES,
  PROJECT_CHUNK_MAX_BYTES,
  PROJECT_MAX_BYTES,
  MAX_RECORDING_TRANSACTION_BYTES,
  ZERO_INTEGRITY,
  decodeCanonicalBase64,
  expiredTransferIds,
  relayAudio,
  validateAudioChunk,
  validateAudioStart,
  validateProjectChunk,
  validateProjectStart,
  validateRecordingLog,
  validateRecordingPrepare,
  validateRecordingTransaction,
};
