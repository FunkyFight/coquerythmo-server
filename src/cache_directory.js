'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const MARKER = 'coquerythmo-room-cache-v2';

function processIsRunning(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

function createCacheDirectory(base, isRunning = processIsRunning) {
  const namespace = path.join(path.resolve(base), MARKER);
  fs.mkdirSync(namespace, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(namespace, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
    const candidate = path.join(namespace, entry.name);
    try {
      const marker = JSON.parse(fs.readFileSync(path.join(candidate, 'owner.json'), 'utf8'));
      if (marker.kind !== MARKER || !Number.isSafeInteger(marker.pid) || marker.pid <= 0) continue;
      if (!isRunning(marker.pid)) fs.rmSync(candidate, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('[cache-cleanup]', candidate, error.message);
    }
  }
  const directory = path.join(namespace, randomUUID());
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(path.join(directory, 'owner.json'), JSON.stringify({ kind: MARKER, pid: process.pid }), { flag: 'wx', mode: 0o600 });
  return directory;
}

module.exports = { createCacheDirectory };
