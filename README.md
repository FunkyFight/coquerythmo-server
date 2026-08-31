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
| `PASSWORD` | *(none)* | Optional server password. If set, clients must provide it. |

Example (PowerShell):
```powershell
$env:PORT = "9050"
$env:SERVER_NAME = "My Server"
$env:MAX_SLOTS = "50"
$env:PASSWORD = "secret123"
npm start
```

Example (bash):
```bash
PORT=9050 SERVER_NAME="My Server" MAX_SLOTS=50 PASSWORD=secret123 npm start
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
  "rooms": 2
}
```

Returns `401` with `{"error": "Invalid password"}` if password is required but missing/incorrect.

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