# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a multi-component project for downloading images to a network drive:

1. **Chrome Extensions** (`extension/`, `webhook-trigger/`) - Browser-based image/webhook tools
2. **Backend Server** (`server/`) - Node.js/Express API that handles image fetching and storage
3. **Scriptable** (`scriptable/`) - iOS automation script (InspoDownload.js)

## Architecture

### Image Downloader Flow

```
User right-clicks image in Chrome
    ↓
extension/background.js creates context menu
    ↓
User selects "Download to Network Drive"
    ↓
Extension fetches config from storage (serverUrl, apiKey)
    ↓
POST /upload to backend with imageUrl and sourceUrl
    ↓
server/server.js fetches image server-side (avoids CORS issues)
    ↓
Image saved to NETWORK_DRIVE_PATH with timestamped filename
```

**Key design notes:**
- Server-side image fetching is intentional—it bypasses CORS restrictions that would block the browser extension
- API key validation happens on every upload endpoint
- Extensions use Chrome's storage API to persist configuration (serverUrl, apiKey)

### Environment Setup

The backend requires these environment variables:
- `API_KEY` - Secret key for authentication (shared with extension)
- `NETWORK_DRIVE_PATH` - Path where images are saved (default: `/mnt/network-drive/images`)
- `PORT` - Server port (default: 3000)
- `NODE_ENV` - Set to `production` when using Docker

## Development Commands

### Backend Server

**Run locally (development with auto-reload):**
```bash
cd server
npm install
npm run dev
```

**Run locally (production):**
```bash
cd server
npm install
npm start
```

Server starts on `http://localhost:3000`

**Run in Docker:**
```bash
docker-compose up -d
```

The docker-compose setup:
- Maps port 3001 (host) → 3000 (container)
- Mounts a local network drive path as `/downloads`
- Sets `NODE_ENV=production`
- Uses `node:18-alpine` image

### Chrome Extensions

**Load an extension for testing:**
1. Open `chrome://extensions/`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked"
4. Select either `extension/` or `webhook-trigger/` directory

**Hot reload during development:**
- After modifying `background.js` or `options.js`, click the reload icon in `chrome://extensions/`

## Configuration Files

**server/server.js**
- `API_KEY` - Read from environment variable `API_KEY`
- `NETWORK_DRIVE_PATH` - Read from env var, defaults to `/mnt/network-drive/images`

**extension/background.js**
- Reads `serverUrl` and `apiKey` from Chrome storage
- Must be configured in options page before use
- Shows badge status: "..." (loading), "✓" (success), "✗" (error)

**extension/options.html & options.js**
- User-facing configuration UI for serverUrl and apiKey
- Persists to Chrome storage.local

**docker-compose.yml**
- `API_KEY` - Sourced from `.env` file (not in git)
- Volume mount - Points to actual network drive on host
- Network - Uses external `proxy` network (must exist: `docker network create proxy`)

## Key Dependencies

**Server:**
- `express` - HTTP framework
- `cors` - Cross-origin support for extension requests
- `nodemon` - Dev tool for auto-reloading

**Extensions:**
- Native Chrome APIs only (no external dependencies)

## API Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/upload` | API key | Upload image by URL |
| GET | `/health` | None | Health check |

The `/upload` endpoint expects:
```json
{
  "imageUrl": "https://...",
  "sourceUrl": "https://...",
  "apiKey": "..."
}
```

## Code Structure Notes

- **extension/background.js** - Service worker (Manifest V3) that listens for context menu clicks and calls the backend
- **server/server.js** - Express app with a single main route and middleware for API key validation
- **webhook-trigger/** - Independent extension for firing webhooks (separate from main image downloader)
- **scriptable/** - iOS automation (outside main flow)

## Testing

The `/health` endpoint can be used to verify the server is running:
```bash
curl http://localhost:3000/health
```

To test image uploads locally:
```bash
curl -X POST http://localhost:3000/upload \
  -H "Content-Type: application/json" \
  -d '{
    "imageUrl": "https://example.com/image.jpg",
    "sourceUrl": "https://example.com",
    "apiKey": "your-api-key"
  }'
```

## Docker Network

The docker-compose setup expects an external `proxy` network to exist. Create it if needed:
```bash
docker network create proxy
```

This allows the backend to communicate with other services (e.g., reverse proxy, other containers).
