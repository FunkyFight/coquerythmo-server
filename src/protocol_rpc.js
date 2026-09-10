'use strict';

const PROTOCOL_VERSION = 2;
const MAX_IN_FLIGHT = 8;
const MAX_REQUEST_BYTES = 512 * 1024;

// Replies carry the caller's correlation id. Methods must be idempotent:
// retrying after a lost reply is normal, including across socket reconnects.
function registerProtocolRpc(socket, dispatch) {
  let inFlight = 0;
  socket.on('protocol_request', async request => {
    if (!request || typeof request.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(request.id)) return;
    const reply = payload => socket.emit('protocol_reply', { id: request.id, ...payload });
    if (typeof request.method !== 'string' || !request.body || typeof request.body !== 'object'
      || Array.isArray(request.body) || Buffer.byteLength(JSON.stringify(request)) > MAX_REQUEST_BYTES) {
      return reply({ ok: false, error: 'invalid_protocol_request' });
    }
    if (inFlight >= MAX_IN_FLIGHT) return reply({ ok: false, error: 'busy', retryable: true });
    inFlight++;
    try {
      const body = await dispatch(request.method, request.body, request.id);
      reply({ ok: true, body: body ?? {} });
    } catch (error) {
      const code = error.code === 'ENOSPC' ? 'project_disk_full' : error.message;
      reply({ ok: false, error: String(code || 'protocol_operation_failed').slice(0, 512),
        retryable: ['not_in_room', 'busy'].includes(code) });
    } finally {
      inFlight--;
    }
  });
}

module.exports = { registerProtocolRpc, PROTOCOL_VERSION };
