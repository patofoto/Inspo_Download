#!/bin/bash

echo "🖼️  Image Downloader Setup Script"
echo "===================================="
echo ""

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo "❌ Docker is not installed. Please install Docker first."
    exit 1
fi

echo "✅ Docker found"
echo ""

# Ask for configuration
read -p "Enter your API key (default: your-secret-key-here): " api_key
api_key=${api_key:-"your-secret-key-here"}

read -p "Enter the path to your network drive (e.g., /mnt/network-drive): " network_drive
network_drive=${network_drive:-"/mnt/network-drive"}

read -p "Enter your Docker host IP (default: localhost): " docker_host
docker_host=${docker_host:-"localhost"}

echo ""
echo "Configuration Summary:"
echo "  API Key: $api_key"
echo "  Network Drive: $network_drive"
echo "  Docker Host: $docker_host"
echo ""

# Update files
echo "Updating configuration files..."

# Update server.js
sed -i.bak "s|const API_KEY = \"your-secret-key-here\"|const API_KEY = \"$api_key\"|g" server.js
sed -i.bak "s|const NETWORK_DRIVE_PATH = process.env.NETWORK_DRIVE_PATH || \"/mnt/network-drive/images\"|const NETWORK_DRIVE_PATH = process.env.NETWORK_DRIVE_PATH || \"$network_drive/images\"|g" server.js

# Update background.js
sed -i.bak "s|const API_KEY = \"your-secret-key-here\"|const API_KEY = \"$api_key\"|g" background.js
sed -i.bak "s|const BACKEND_URL = \"http://localhost:3000\"|const BACKEND_URL = \"http://$docker_host:3000\"|g" background.js

# Update docker-compose.yml
sed -i.bak "s|/path/to/your/network/drive|$network_drive|g" docker-compose.yml

echo "✅ Configuration files updated"
echo ""

# Install dependencies
echo "Installing Node dependencies..."
npm install > /dev/null 2>&1
echo "✅ Dependencies installed"
echo ""

# Build Docker image
echo "Building Docker image..."
docker-compose build > /dev/null 2>&1
echo "✅ Docker image built"
echo ""

echo "🎉 Setup complete!"
echo ""
echo "Next steps:"
echo "1. Start the server: docker-compose up -d"
echo "2. Load the extension in Chrome:"
echo "   - Go to chrome://extensions/"
echo "   - Enable Developer mode"
echo "   - Click Load unpacked and select this folder"
echo "3. Right-click on any image to download it!"
echo ""
echo "View logs: docker-compose logs -f"
