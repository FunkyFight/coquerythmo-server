# Coquerythmo Server

WebSocket server for coquerythmo cooperative mode.

**Protocol 2 requires the updated client and server together.** The server now
stores a temporary project archive per room, serves independent actor downloads,
and keeps versioned bande-rythmo state. Empty rooms release their files and state.
See [the protocol contract](../docs/network-protocol-v2.md) in the parent project.

## Quick Start

```bash
npm install
npm start
```

Server runs on `http://localhost:9050` by default.

## Configuration

Environment variables (set before `npm start`):

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `9050` | Server port |
| `SERVER_NAME` | `Coquerythmo Server` | Display name in server browser |
| `MAX_SLOTS` | `20` | Max concurrent users |
| `MOTD` | `` | Message of the day |
| `SERVER_IP` | *(none)* | External IP/hostname for clients to connect (e.g. `38.87.117.194` or `myserver.com`). If set, included in `/info` response. |
| `PASSWORD` | *(none)* | Optional server password. If set, clients must provide it. |
| `PROJECT_CACHE_DIR` | OS temporary directory | Parent of the server's private, marked cache directory. Must have room for the archives. |
| `PROJECT_MAX_BYTES` | `68719476736` | Maximum project archive size (64 GiB). |
| `PROJECT_STORAGE_MAX_BYTES` | `137438953472` | Global reservation limit, including incomplete uploads (128 GiB). |

Example (PowerShell):
```powershell
$env:PORT = "9050"
$env:SERVER_NAME = "My Server"
$env:MAX_SLOTS = "50"
$env:SERVER_IP = "38.87.117.194"
$env:PASSWORD = "secret123"
npm start
```

Example (bash):
```bash
PORT=9050 SERVER_NAME="My Server" MAX_SLOTS=50 SERVER_IP="38.87.117.194" PASSWORD=secret123 npm start
```

## HTTP Endpoint

`GET /info?password=<password>` — Returns server info for the server browser (replaces old websocket ping).

Response:
```json
{
  "name": "Coquerythmo Server",
  "motd": "Welcome",
  "max_slots": 20,
  "online": 5,
  "rooms": 2,
  "ip": "38.87.117.194"
}
```

The `ip` field is only present if `SERVER_IP` environment variable is set.

Returns `401` with `{"error": "Invalid password"}` if password is required but missing/incorrect.

## Manual Ping (Health Check)

Test if the server is running and responding:

**PowerShell:**
```powershell
# Without password
Invoke-WebRequest -Uri "http://localhost:9050/info" -Method GET | Select-Object -ExpandProperty Content

# With password
Invoke-WebRequest -Uri "http://localhost:9050/info?password=secret123" -Method GET | Select-Object -ExpandProperty Content
```

**bash / curl:**
```bash
# Without password
curl "http://localhost:9050/info"

# With password
curl "http://localhost:9050/info?password=secret123"
```

**Expected output (JSON):**
```json
{
  "name": "Coquerythmo Server",
  "motd": "Welcome",
  "max_slots": 20,
  "online": 5,
  "rooms": 2,
  "ip": "38.87.117.194"
}
```

The `ip` field is only present if `SERVER_IP` environment variable is set.

If password is required but wrong/missing, returns HTTP 401:
```json
{"error": "Invalid password"}
```

## WebSocket Events

See `src/index.js` and `src/room_protocol.js` for the protocol. Main events:
- `ping_server` — **Deprecated** (use HTTP `/info` instead)
- `create_room` / `join_room` — Room management
- `protocol_request` / `protocol_reply` — Correlated, acknowledged room operations.
- `project_available` / `project_transfer_request` / `project_transfer_status` — Archive availability and independent download/import progress.
- `state_changed` — Notification to pull versioned entity changes or a verified snapshot.
- RPC methods `project_begin/write/commit/read/response/loading/result/abort` — Room archive lifecycle.
- RPC methods `state_info/publish/pull/upload_begin/upload_chunk/upload_commit/snapshot_begin/snapshot_read/snapshot_end` — Bande-rythmo state.
- RPC method `event` — Acknowledged recording, audio-relay and room commands, deduplicated across reconnections.
- `request_sync` — Recording-workspace catch-up from the available director.
- `big_begin` / `big_chunk` / `big_end` — Chunked relay of oversized
  `recording_prepare` payloads (> 256 KiB serialized; 256 KiB canonical-base64
  chunks, sequential indexes, global SHA-1, 2 GiB cap, 10 min inactivity
  timeout). The server validates and relays without reassembling.
- Audio transfer events. Project video is distributed inside the project archive.

Uploads expire after ten minutes without activity. Server restart ends ephemeral
rooms; startup cleans marked caches belonging to stopped processes. WebSocket
heartbeats detect dead connections without disconnecting healthy receive-only peers.

## Development

```bash
npm install
npm start
npm test
```

Logs show connections, room activity, and sync requests.
