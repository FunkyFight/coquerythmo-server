# Coquerythmo Server

WebSocket server for coquerythmo cooperative mode.

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

See `src/index.js` for full protocol. Main events:
- `ping_server` — **Deprecated** (use HTTP `/info` instead)
- `create_room` / `join_room` — Room management
- `request_sync` / `sync` — Project synchronization
- `command` / `delta` — Real-time collaboration
- Audio/video transfer events

## Development

```bash
npm install
npm start
```

Logs show connections, room activity, and sync requests.