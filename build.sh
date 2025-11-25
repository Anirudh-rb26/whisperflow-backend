#!/bin/bash
set -e

echo "🔧 Installing build dependencies..."
apt-get update || true
apt-get install -y make g++ git cmake || true

echo "📦 Building whisper.cpp..."
if [ ! -f "model/whisper-cli" ]; then
  git clone https://github.com/ggml-org/whisper.cpp.git temp-whisper
  cd temp-whisper
  
  # Use CMake build (new method)
  cmake -B build
  cmake --build build --config Release
  
  cd ..
  mkdir -p model
  
  # ✅ FIX: Correct binary location
  cp temp-whisper/build/bin/whisper-cli model/whisper-cli
  chmod +x model/whisper-cli
  
  rm -rf temp-whisper
  
  echo "✅ whisper.cpp built successfully"
else
  echo "✅ whisper.cpp already exists"
fi

npm install
echo "✅ Build complete!"
