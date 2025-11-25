#!/bin/bash
set -e

echo "🔧 Installing build dependencies..."
apt-get update || true
apt-get install -y make g++ git cmake || true

echo "📦 Building whisper.cpp..."
if [ ! -f "model/whisper-cli" ]; then
  git clone https://github.com/ggml-org/whisper.cpp.git temp-whisper
  cd temp-whisper
  
  cmake -B build
  cmake --build build --config Release
  
  cd ..
  mkdir -p model
  
  # Copy the CLI binary
  cp temp-whisper/build/bin/whisper-cli model/whisper-cli
  chmod +x model/whisper-cli
  
  # ✅ FIX: Copy the shared libraries too
  cp temp-whisper/build/src/libwhisper.so* model/ 2>/dev/null || true
  cp temp-whisper/build/ggml/src/libggml*.so* model/ 2>/dev/null || true
  
  rm -rf temp-whisper
  
  echo "✅ whisper.cpp built successfully"
else
  echo "✅ whisper.cpp already exists"
fi

npm install
echo "✅ Build complete!"
