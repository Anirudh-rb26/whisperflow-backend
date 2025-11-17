from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from dotenv import load_dotenv
from openai import OpenAI
import subprocess
import tempfile
import os
import shutil
import re


load_dotenv()
api_key = os.getenv("PERPLEXITY_API_KEY")
print(f"Loaded Perplexity API Key: {api_key[:10]}..." if api_key else "No API key found")

# Check for ffmpeg availability
FFMPEG_AVAILABLE = shutil.which("ffmpeg") is not None


# Initialize Perplexity client (uses OpenAI-compatible API)
try:
    perplexity_client = OpenAI(
        api_key=api_key,
        base_url="https://api.perplexity.ai"
    )
    PERPLEXITY_AVAILABLE = True if api_key else False
except Exception as e:
    print(f"⚠️  Perplexity API not available: {e}")
    PERPLEXITY_AVAILABLE = False


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
    if PERPLEXITY_AVAILABLE:
        print(f"✓ Perplexity API available (Hinglish translation enabled)")
    else:
        print(f"⚠️  WARNING: Perplexity API not available (set PERPLEXITY_API_KEY)")
    print("🚀 Whisper API is ready!")
    yield
    # Shutdown
    print("👋 Shutting down...")


app = FastAPI(
    title="Whisper.cpp Transcription API",
    description="Audio transcription using local whisper.cpp tiny model with Perplexity Hinglish translation",
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
            "-ar", "16000",
            "-ac", "1",
            "-c:a", "pcm_s16le",
            "-y",
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


def parse_subtitle_block(block: str, is_vtt: bool = False):
    """Parse a single subtitle block and return its components"""
    lines = block.strip().split('\n')
    if len(lines) < 3:
        return None

    # For VTT, skip the first line if it doesn't contain -->
    start_idx = 0
    if is_vtt and '-->' not in lines[0]:
        start_idx = 1

    # For SRT, the first line is the sequence number
    if not is_vtt:
        start_idx = 1

    if start_idx >= len(lines):
        return None

    timestamp_line = lines[start_idx]
    text_lines = lines[start_idx + 1:]
    text = '\n'.join(text_lines)

    return {
        'timestamp': timestamp_line,
        'text': text
    }


def translate_subtitles(subtitle_text: str, is_vtt: bool = False) -> str:
    """Translate subtitle text to Hinglish while preserving format - BATCH VERSION"""
    if not subtitle_text or not PERPLEXITY_AVAILABLE:
        return subtitle_text

    # Split into blocks
    separator = '\n\n'
    blocks = subtitle_text.split(separator)

    parsed_blocks = []
    header = None
    texts_to_translate = []
    text_indices = []  # Track which blocks need translation

    # First pass: parse all blocks and collect texts
    for i, block in enumerate(blocks):
        if not block.strip():
            continue

        # Keep VTT header
        if is_vtt and i == 0 and block.strip().startswith('WEBVTT'):
            header = block
            parsed_blocks.append({'type': 'header', 'content': block})
            continue

        parsed = parse_subtitle_block(block, is_vtt)
        if not parsed:
            parsed_blocks.append({'type': 'raw', 'content': block})
            continue

        # Store parsed block and mark for translation
        parsed_blocks.append({
            'type': 'subtitle',
            'timestamp': parsed['timestamp'],
            'text': parsed['text'],
            'original_block': block
        })
        texts_to_translate.append(parsed['text'])
        text_indices.append(len(parsed_blocks) - 1)

    # Batch translate all texts in ONE API call
    if texts_to_translate:
        print(f"🌐 Translating {len(texts_to_translate)} subtitle blocks in one batch...")
        
        # Create a numbered list for better parsing
        batch_text = "\n---SUBTITLE---\n".join(
            f"[{i+1}] {text}" for i, text in enumerate(texts_to_translate)
        )
        
        try:
            prompt = f"""DO NOT use internet search. Use only your internal knowledge for this translation task.

Convert the following subtitle texts to Hinglish (a natural mix of Hindi and English).

CRITICAL RULES:
1. ONLY translate words that are clearly Hindi/Urdu/regional language words to Devanagari script
2. Keep ALL English words in English - do NOT transliterate English words to Devanagari
3. If a word seems like it could be English (even if mispronounced in audio), keep it in English
4. Examples of what to do:
   - "do you have a peela shawl" → "do you have a पीला shawl"
   - "main kya talking about" → "मैं क्या talking about"
   - "it's very sundar" → "it's very सुंदर"
5. Common English words MUST stay in English: why, is, talking, have, do, what, where, when, how, etc.
6. If you're unsure whether a word is Hindi or English, keep it in English
7. Make it sound natural, like how people actually speak Hinglish in conversations
8. Preserve the numbering [1], [2], etc. for each subtitle
9. Separate each translated subtitle with ---SUBTITLE---
10. ONLY return the translated texts with their numbers, nothing else

Subtitles to convert:
{batch_text}"""

            completion = perplexity_client.chat.completions.create(
                model="sonar-pro",
                messages=[
                    {
                        "role": "system",
                        "content": "You are a translation assistant. Do not use internet search. Respond only with translations."
                    },
                    {
                        "role": "user",
                        "content": prompt
                    }
                ]
            )
            
            translated_batch = completion.choices[0].message.content.strip()
            
            # Parse the batch response
            translated_texts = []
            for part in translated_batch.split('---SUBTITLE---'):
                part = part.strip()
                if part:
                    # Remove the [N] prefix if present
                    text = re.sub(r'^\[\d+\]\s*', '', part)
                    translated_texts.append(text.strip())
            
            # Update the parsed blocks with translations
            for idx, text_idx in enumerate(text_indices):
                if idx < len(translated_texts):
                    parsed_blocks[text_idx]['text'] = translated_texts[idx]
                    
            print(f"✓ Batch translation complete ({len(translated_texts)} blocks)")
            
        except Exception as e:
            print(f"⚠️  Perplexity batch translation failed: {e}")
            # Keep original texts on failure

    # Reconstruct the subtitle file
    result_blocks = []
    
    for block_data in parsed_blocks:
        if block_data['type'] == 'header':
            if not is_vtt:  # Only add header for VTT
                continue
            result_blocks.append(block_data['content'])
        elif block_data['type'] == 'raw':
            result_blocks.append(block_data['content'])
        elif block_data['type'] == 'subtitle':
            if is_vtt:
                reconstructed = f"{block_data['timestamp']}\n{block_data['text']}"
            else:
                # For SRT, extract sequence number from original block
                seq_match = re.match(r'(\d+)\n', block_data['original_block'])
                if seq_match:
                    seq_num = seq_match.group(1)
                    reconstructed = f"{seq_num}\n{block_data['timestamp']}\n{block_data['text']}"
                else:
                    reconstructed = f"{block_data['timestamp']}\n{block_data['text']}"
            result_blocks.append(reconstructed)

    # Rejoin blocks
    result = separator.join(result_blocks)

    # Add back VTT header at the beginning if present
    if header and is_vtt:
        if not result.startswith('WEBVTT'):
            result = header + '\n\n' + result

    return result


@app.get("/")
async def root():
    return {
        "message": "Whisper.cpp Transcription API with Perplexity Hinglish",
        "status": "running",
        "model": "whisper-tiny",
        "ffmpeg_available": FFMPEG_AVAILABLE,
        "perplexity_available": PERPLEXITY_AVAILABLE,
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
        "ffmpeg_available": FFMPEG_AVAILABLE,
        "perplexity_available": PERPLEXITY_AVAILABLE
    }


@app.post("/transcribe")
async def transcribe_audio(
    file: UploadFile = File(...),
    language: str = "auto",
    translate_to_hinglish: bool = True
):
    """
    Accepts audio/video file, returns SRT & VTT subtitles as JSON.
    For MP4 files, ffmpeg must be installed.
    If language is not English and translate_to_hinglish=True, translates to Hinglish via Perplexity.
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

        output_prefix = tempfile.NamedTemporaryFile(delete=False, suffix='').name

        cmd = [
            WHISPER_EXECUTABLE,
            "-f", input_file,
            "-m", WHISPER_MODEL,
            "-l", language,
            "-osrt",
            "-ovtt",
            "-of", output_prefix,
        ]

        print(f"Command: {' '.join(cmd)}")

        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            check=True,
            cwd=".",
            timeout=300
        )

        if result.stdout:
            print(f"Whisper output: {result.stdout[:500]}")


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


        # Translate to Hinglish if not English
        translated = False
        if language != "en" and translate_to_hinglish and PERPLEXITY_AVAILABLE:
            print(f"🌐 Translating to Hinglish via Perplexity...")
            if srt_text:
                srt_text = translate_subtitles(srt_text, is_vtt=False)
            if vtt_text:
                vtt_text = translate_subtitles(vtt_text, is_vtt=True)
            translated = True
            print(f"✓ Translation complete")


        print(f"✅ Transcription complete!")


        return JSONResponse(content={
            "success": True,
            "filename": file.filename,
            "language": language,
            "srt": srt_text,
            "vtt": vtt_text,
            "converted": needs_conversion,
            "translated_to_hinglish": translated
        })


    except HTTPException:
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
    print("🎙️  Whisper.cpp FastAPI Server with Perplexity")
    print("=" * 50)
    uvicorn.run(app, host="0.0.0.0", port=8000)