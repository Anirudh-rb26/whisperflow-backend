from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
import subprocess
import tempfile
import os
import shutil

# Check for ffmpeg availability
FFMPEG_AVAILABLE = shutil.which("ffmpeg") is not None

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    if not os.path.exists(WHISPER_EXECUTABLE):
        print(f"❌ ERROR: {WHISPER_EXECUTABLE} not found!")
    else:
        print(f"✓ Found: {WHISPER_EXECUTABLE}")
    if not os.path.exists(WHISPER_MODEL):
        print(f"❌ ERROR: {WHISPER_MODEL} not found!")
    else:
        print(f"✓ Found: {WHISPER_MODEL}")
    if FFMPEG_AVAILABLE:
        print(f"✓ Found: ffmpeg (video conversion enabled)")
    else:
        print(f"⚠️  WARNING: ffmpeg not found (MP4 videos may not work)")
    print("🚀 Whisper API is ready!")
    yield
    # Shutdown
    print("👋 Shutting down...")

app = FastAPI(
    title="Whisper.cpp Transcription API",
    description="Audio transcription using local whisper.cpp tiny model",
    lifespan=lifespan
)

# Enable CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Paths to whisper files
WHISPER_EXECUTABLE = r".\model\whisper-cli.exe"
WHISPER_MODEL = r".\model\ggml-tiny.bin"

def convert_to_wav(input_path: str, output_path: str) -> bool:
    """Convert any audio/video file to WAV using ffmpeg"""
    try:
        cmd = [
            "ffmpeg",
            "-i", input_path,
            "-ar", "16000",  # 16kHz sample rate (whisper requirement)
            "-ac", "1",       # Mono
            "-c:a", "pcm_s16le",  # 16-bit PCM
            "-y",             # Overwrite output
            output_path
        ]
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            check=True
        )
        return True
    except subprocess.CalledProcessError as e:
        print(f"❌ FFmpeg error: {e.stderr}")
        return False
    except FileNotFoundError:
        print("❌ FFmpeg not found in PATH")
        return False

@app.get("/")
async def root():
    return {
        "message": "Whisper.cpp Transcription API",
        "status": "running",
        "model": "whisper-tiny",
        "ffmpeg_available": FFMPEG_AVAILABLE,
        "endpoints": {
            "transcribe": "/transcribe",
            "health": "/health",
            "docs": "/docs"
        }
    }

@app.get("/health")
async def health():
    return {
        "status": "healthy",
        "executable_exists": os.path.exists(WHISPER_EXECUTABLE),
        "model_exists": os.path.exists(WHISPER_MODEL),
        "ffmpeg_available": FFMPEG_AVAILABLE
    }

@app.post("/transcribe")
async def transcribe_audio(
    file: UploadFile = File(...),
    language: str = "en"
):
    """
    Accepts audio/video file, returns SRT & VTT subtitles as JSON.
    For MP4 files, ffmpeg must be installed.
    """
    temp_input = None
    temp_wav = None
    srt_path = None
    vtt_path = None
    output_prefix = None

    try:
        # Save uploaded file
        suffix = os.path.splitext(file.filename)[1] or '.wav'
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix, mode='wb') as f:
            contents = await file.read()
            f.write(contents)
            temp_input = f.name

        print(f"📁 Processing: {file.filename} ({len(contents)} bytes)")

        # Determine if we need to convert to WAV
        needs_conversion = suffix.lower() in ['.mp4', '.m4a', '.mov', '.avi', '.mkv', '.webm']
        
        if needs_conversion:
            if not FFMPEG_AVAILABLE:
                print("❌ FFmpeg not available for video conversion")
                raise HTTPException(
                    status_code=400,
                    detail="FFmpeg is required for video/MP4 files. Please install ffmpeg."
                )
            
            # Convert to WAV
            temp_wav = tempfile.NamedTemporaryFile(delete=False, suffix='.wav').name
            print(f"🔄 Converting {suffix} to WAV...")
            if not convert_to_wav(temp_input, temp_wav):
                raise HTTPException(
                    status_code=500,
                    detail="Failed to convert file to WAV format"
                )
            input_file = temp_wav
            print(f"✓ Conversion complete")
        else:
            input_file = temp_input

        # Run whisper.cpp
        print(f"🎤 Running whisper.cpp...")
        
        # Create output prefix in temp directory
        output_prefix = tempfile.NamedTemporaryFile(delete=False, suffix='').name
        
        cmd = [
            WHISPER_EXECUTABLE,
            "-f", input_file,
            "-m", WHISPER_MODEL,
            "-l", language,
            "-osrt",  # Output SRT
            "-ovtt",  # Output VTT
            "-of", output_prefix,  # Output file prefix
        ]
        
        print(f"Command: {' '.join(cmd)}")
        
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            check=True,
            cwd=".",
            timeout=300  # 5 minute timeout
        )

        # Check stdout for any output
        if result.stdout:
            print(f"Whisper output: {result.stdout[:500]}")  # First 500 chars

        srt_path = f"{output_prefix}.srt"
        vtt_path = f"{output_prefix}.vtt"

        # Read subtitle outputs
        srt_text, vtt_text = None, None
        if os.path.exists(srt_path):
            with open(srt_path, 'r', encoding='utf-8') as f:
                srt_text = f.read()
            print(f"✓ SRT generated ({len(srt_text)} chars)")
        else:
            print(f"⚠️  SRT file not found: {srt_path}")
            
        if os.path.exists(vtt_path):
            with open(vtt_path, 'r', encoding='utf-8') as f:
                vtt_text = f.read()
            print(f"✓ VTT generated ({len(vtt_text)} chars)")
        else:
            print(f"⚠️  VTT file not found: {vtt_path}")

        if not srt_text and not vtt_text:
            raise HTTPException(
                status_code=500, 
                detail="No subtitles were generated. Check if the audio file contains speech."
            )

        print(f"✅ Transcription complete!")

        return JSONResponse(content={
            "success": True,
            "filename": file.filename,
            "language": language,
            "srt": srt_text,
            "vtt": vtt_text,
            "converted": needs_conversion
        })

    except HTTPException:
        # Re-raise HTTP exceptions without wrapping them
        raise
    except subprocess.TimeoutExpired:
        print(f"❌ Whisper.cpp timed out")
        raise HTTPException(
            status_code=500,
            detail="Transcription timed out (file too large or processing issue)"
        )
    except subprocess.CalledProcessError as e:
        error_msg = e.stderr if e.stderr else e.stdout if e.stdout else "Unknown error"
        print(f"❌ Whisper.cpp error: {error_msg}")
        print(f"   Return code: {e.returncode}")
        raise HTTPException(
            status_code=500,
            detail=f"Whisper.cpp failed: {error_msg}"
        )
    except Exception as e:
        print(f"❌ Error: {str(e)}")
        raise HTTPException(
            status_code=500,
            detail=f"Transcription failed: {str(e)}"
        )
    finally:
        # Clean up all temporary files
        for path in [temp_input, temp_wav, srt_path, vtt_path, output_prefix]:
            if path and os.path.exists(path):
                try:
                    os.unlink(path)
                except Exception as e:
                    print(f"⚠️  Failed to delete {path}: {e}")

if __name__ == "__main__":
    import uvicorn
    print("=" * 50)
    print("🎙️  Whisper.cpp FastAPI Server")
    print("=" * 50)
    uvicorn.run(app, host="0.0.0.0", port=8000)