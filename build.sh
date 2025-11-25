#!/bin/bash
set -e

echo "🔧 Installing build dependencies..."
# Install build tools if needed
apt-get update || true
apt-get install -y make g++ || true

echo "📦 Building whisper.cpp..."
if [ ! -f "model/whisper-cli" ]; then
  # Clone whisper.cpp
  git clone https://github.com/ggml-org/whisper.cpp.git temp-whisper
  cd temp-whisper
  
  # Build the main executable
  make
  
  # Copy to model directory
  cd ..
  mkdir -p model
  cp temp-whisper/main model/whisper-cli
  chmod +x model/whisper-cli
  
  # Cleanup
  rm -rf temp-whisper
  
  echo "✅ whisper.cpp built successfully"
else
  echo "✅ whisper.cpp already exists"
fi

echo "📦 Installing Node.js dependencies..."
npm install

echo "✅ Build complete!"
