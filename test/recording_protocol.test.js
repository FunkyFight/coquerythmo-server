const test = require('node:test');
const assert = require('node:assert/strict');

const {
  relayAudio,
  expiredTransferIds,
  validateAudioChunk,
  validateAudioStart,
  validateBigBegin,
  validateBigChunk,
  validateProjectChunk,
  validateProjectStart,
  validateRecordingDisplaySettings,
  validateRecordingLog,
  validateRecordingPrepare,
  validateRecordingTransaction,
  ZERO_INTEGRITY,
} = require('../src/recording_protocol');

function operation() {
  return {
    op: 'add_track',
    track: { id: 1, name: 'ADR', muted: false, solo: false, armed: false },
  };
}

function transaction(sequence, previousIntegrity, value = operation()) {
  return {
    sequence,
    previous_integrity: previousIntegrity,
    integrity: (sequence + 1).toString(16).padStart(16, '0'),
    operation: value,
  };
}

test('audio is relayed to every other room member, including for an actor', () => {
  const emitted = [];
  const sender = {
    to(roomCode) {
      emitted.push(['room', roomCode]);
      return { emit: (event, data) => emitted.push([event, data]) };
    },
  };

  relayAudio({ code: 'ABC123' }, sender, 'audio_chunk', { index: 0 });

  assert.deepEqual(emitted, [
    ['room', 'ABC123'],
    ['audio_chunk', { index: 0 }],
  ]);
});

test('audio transfer metadata and canonical chunks are validated', () => {
  const metadata = {
    transfer_id: 'take_1',
    file_name: 'take.flac',
    total_bytes: 2,
    total_chunks: 1,
    chunk_size: 192 * 1024,
    sha1: 'a'.repeat(40),
  };
  assert.equal(validateAudioStart(metadata).error, undefined);

  const transfer = {
    nextIndex: 0,
    receivedBytes: 0,
    totalBytes: 2,
    chunkSize: metadata.chunk_size,
  };
  assert.equal(validateAudioChunk({ transfer_id: 'take_1', index: 0, data: 'aGk=' }, transfer).bytes, 2);
  assert.match(
    validateAudioChunk({ transfer_id: 'take_1', index: 0, data: 'aGk' }, transfer).error,
    /base64|size/,
  );
  assert.match(
    validateAudioStart({ ...metadata, file_name: '../take.flac' }).error,
    /file name/,
  );
  assert.match(
    validateAudioChunk({ transfer_id: 'take_1', index: 1, data: 'aGk=' }, transfer).error,
    /out of order/,
  );
});

test('project transfer metadata and chunks use the same strict geometry', () => {
  const metadata = {
    request_id: 'project_1',
    project_huuid: 'Coquerythmo-3.6.0-A',
    file_name: 'scene.coquerythmo',
    total_bytes: 2,
    total_chunks: 1,
    chunk_size: 192 * 1024,
    sha1: 'a'.repeat(40),
  };
  assert.equal(validateProjectStart(metadata).error, undefined);
  const transfer = {
    requestId: metadata.request_id,
    nextIndex: 0,
    chunkSize: metadata.chunk_size,
    receivedBytes: 0,
    totalBytes: metadata.total_bytes,
  };
  assert.equal(validateProjectChunk({ request_id: 'project_1', index: 0, data: 'aGk=' }, transfer).bytes, 2);
  assert.match(validateProjectChunk({ request_id: 'project_1', index: 1, data: 'aGk=' }, transfer).error, /out of order/);
  assert.match(validateProjectChunk({ request_id: 'project_1', index: 0, data: 'aGk' }, transfer).error, /base64/);
  assert.match(validateProjectStart({ ...metadata, file_name: '../scene.coquerythmo' }).error, /file name/);
  assert.match(validateProjectStart({ ...metadata, total_chunks: 2 }).error, /geometry/);
});

test('inactive audio transfers expire while active ones remain', () => {
  const now = 300_000;
  const transfers = new Map([
    ['stale', { lastActivity: -1 }],
    ['active', { lastActivity: 299_999 }],
  ]);
  assert.deepEqual(expiredTransferIds(transfers, now, 300_000), ['stale']);
});

test('recording transaction shape and chain ordering are enforced', () => {
  const first = transaction(0, ZERO_INTEGRITY);
  const firstResult = validateRecordingTransaction(first, {
    nextSequence: 0,
    previousIntegrity: ZERO_INTEGRITY,
  });
  assert.deepEqual(firstResult.nextChain, {
    nextSequence: 1,
    previousIntegrity: first.integrity,
  });

  assert.match(
    validateRecordingTransaction(transaction(1, ZERO_INTEGRITY), {
      nextSequence: 0,
      previousIntegrity: ZERO_INTEGRITY,
    }).error,
    /sequence/,
  );
  assert.match(
    validateRecordingTransaction({ ...first, integrity: 'INVALID' }, {
      nextSequence: 0,
      previousIntegrity: ZERO_INTEGRITY,
    }).error,
    /integrity fields/,
  );
  assert.match(
    validateRecordingTransaction({ ...first, previous_integrity: 'f'.repeat(16) }, {
      nextSequence: 0,
      previousIntegrity: ZERO_INTEGRITY,
    }).error,
    /previous integrity/,
  );
  assert.match(
    validateRecordingTransaction({
      ...first,
      operation: { op: 'not_an_operation' },
    }).error,
    /unknown recording operation/,
  );
});

test('recording display settings are bounded', () => {
  assert.deepEqual(
    validateRecordingDisplaySettings({ scroll_speed: 1.5, reading_bar_offset_percent: -12 }),
    { scroll_speed: 1.5, reading_bar_offset_percent: -12 },
  );
  assert.match(
    validateRecordingDisplaySettings({ scroll_speed: 4.1, reading_bar_offset_percent: 0 }).error,
    /display settings/,
  );
  assert.match(
    validateRecordingDisplaySettings({ scroll_speed: 1, reading_bar_offset_percent: -51 }).error,
    /display settings/,
  );
});

test('recording prepare validates the complete log and returns its active tail', () => {
  const first = transaction(0, ZERO_INTEGRITY);
  const second = transaction(1, first.integrity, {
    op: 'rename_track',
    track_id: 1,
    name: 'Voix',
  });
  const log = { entries: [first, second], cursor: 2 };
  const result = validateRecordingPrepare({
    project: { timeline_fps: 24 },
    transactions: log,
    current_frame: 12,
    capture_target: null,
  });
  assert.deepEqual(result.chain, {
    nextSequence: 2,
    previousIntegrity: second.integrity,
  });

  const corrupted = { ...log, entries: [{ ...first, previous_integrity: 'f'.repeat(16) }, second] };
  assert.match(validateRecordingLog(corrupted).error, /previous integrity/);
});

test('recording batches are bounded', () => {
  const value = {
    op: 'batch',
    operations: Array.from({ length: 1025 }, () => operation()),
  };
  const tx = transaction(0, ZERO_INTEGRITY, value);
  assert.match(validateRecordingTransaction(tx).error, /batch/);
});

test('big transfer geometry is validated like audio transfers', () => {
  const begin = {
    transfer_id: 'big_1',
    event: 'sync',
    total_bytes: 300 * 1024,
    total_chunks: 2,
    chunk_size: 256 * 1024,
    sha1: 'a'.repeat(40),
  };
  assert.equal(validateBigBegin(begin).error, undefined);
  assert.equal(validateBigBegin({ ...begin, _target: 'member-1' }).error, undefined);

  assert.match(validateBigBegin({ ...begin, transfer_id: 'bad id' }).error, /id/);
  assert.match(validateBigBegin({ ...begin, event: 'recording_view' }).error, /event/);
  assert.match(validateBigBegin({ ...begin, total_chunks: 1 }).error, /geometry/);
  assert.match(
    validateBigBegin({ ...begin, chunk_size: 256 * 1024 + 1 }).error,
    /geometry/,
  );
  assert.match(
    validateBigBegin({ ...begin, total_bytes: 2 * 1024 * 1024 * 1024 + 1 }).error,
    /size/,
  );
  assert.match(validateBigBegin({ ...begin, sha1: 'A'.repeat(40) }).error, /SHA-1/);
  assert.match(validateBigBegin({ ...begin, _target: 'bad target' }).error, /target/);
});

test('big chunks enforce sequential indexes and canonical base64', () => {
  const transfer = {
    nextIndex: 0,
    receivedBytes: 0,
    totalBytes: 2,
    chunkSize: 256 * 1024,
  };
  assert.equal(validateBigChunk({ transfer_id: 'big_1', index: 0, data: 'aGk=' }, transfer).bytes, 2);
  assert.match(
    validateBigChunk({ transfer_id: 'big_1', index: 0, data: 'aGk=' }, null).error,
    /unknown/,
  );
  assert.match(
    validateBigChunk({ transfer_id: 'big_1', index: 1, data: 'aGk=' }, transfer).error,
    /out of order/,
  );
  assert.match(
    validateBigChunk({ transfer_id: 'big_1', index: 0, data: 'aGk' }, transfer).error,
    /base64|size/,
  );
  assert.match(
    validateBigChunk({ transfer_id: 'big_1', index: 0, data: 'aGkKaGk=' }, transfer).error,
    /announced size/,
  );
});
