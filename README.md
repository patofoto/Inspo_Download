# Image Downloader to Network Drive

A Chrome extension that allows you to right-click on any image and download it directly to a folder on your network drive.

## Architecture

- **Chrome Extension** - Runs in your browser, detects right-clicks on images
- **Backend Server** (Node.js/Express) - Receives images and saves them to your network drive
- **Docker Container** - Runs the backend server with network drive mounted

## Setup Instructions

### 1. Configure Your Network Drive

First, mount your network drive on the Docker host machine. You have a few options:

**Option A: SMB/CIFS Share (Windows/Network Share)**
```bash
# On Linux/Mac that will run Docker
sudo mkdir -p /mnt/network-drive
sudo mount -t cifs //192.168.1.100/shared-folder /mnt/network-drive \
  -o username=user,password=pass,uid=1000,gid=1000
```

**Option B: NFS Share**
```bash
sudo mkdir -p /mnt/network-drive
sudo mount -t nfs 192.168.1.100:/export/shared /mnt/network-drive
```

**Option C: If the "other computer" is on the same local network**
Just specify the path in docker-compose.yml volumes

### 2. Update Configuration Files

**backend.js - Set the API key:**
```javascript
const API_KEY = "your-secret-key-here"; // Change this to something secure
```

**background.js (Chrome Extension) - Match the API key:**
```javascript
const API_KEY = "your-secret-key-here"; // Must be the same
const BACKEND_URL = "http://localhost:3000"; // Or your Docker host IP
```

**docker-compose.yml - Update the volume mount:**
```yaml
volumes:
  - /mnt/network-drive:/downloads  # Update the host path
```

### 3. Start the Backend Server

**Using Docker Compose:**
```bash
docker-compose up -d
```

**Or run locally (without Docker):**
```bash
npm install
npm start
```

The server will start on `http://localhost:3000`

### 4. Install Chrome Extension

1. Open `chrome://extensions/` in Chrome
2. Enable "Developer mode" (top right)
3. Click "Load unpacked"
4. Select the directory containing:
   - `manifest.json`
   - `background.js`

### 5. Test It

1. Right-click on any image in your browser
2. Select "Download to Network Drive"
3. Check your network drive folder for the image
4. You should see a notification in Chrome confirming the download

## Network Setup for Local Network Access

If your Docker server is on a different machine than your browser:

1. **Find your Docker host IP:**
   ```bash
   hostname -I  # Linux
   ifconfig | grep "inet "  # Mac
   ```

2. **Update the extension to use that IP:**
   In `background.js`:
   ```javascript
   const BACKEND_URL = "http://192.168.1.50:3000";  // Your Docker host IP
   ```

3. **Ensure firewall allows port 3000:**
   ```bash
   # Linux
   sudo ufw allow 3000
   
   # Mac - use System Preferences > Security & Privacy > Firewall
   ```

## File Organization

Images are saved with timestamps to prevent collisions:
- `photo_2026-04-15T14-30-45.jpg`
- `screenshot_2026-04-15T14-30-50.png`

To change the naming scheme, edit the `extractFilename()` function in `background.js`.

## Security Notes

- **API Key:** Change the default API key in both files
- **Network:** Only expose the server to trusted networks
- **CORS:** Currently allows all origins - restrict in `server.js` if needed

## Troubleshooting

**Extension doesn't show context menu:**
- Ensure manifest.json is valid
- Check that both manifest.json and background.js are in the extension directory
- Try reloading the extension in chrome://extensions/

**Images not saving:**
- Check Docker logs: `docker-compose logs`
- Verify network drive is mounted and writable
- Confirm API keys match between extension and server

**Can't connect from another machine:**
- Check firewall rules
- Verify Docker host IP in extension config
- Test with `curl http://192.168.x.x:3000/health`

## API Endpoints

- `POST /upload` - Upload image (requires multipart form data with `image`, `apiKey`)
- `GET /health` - Health check endpoint
