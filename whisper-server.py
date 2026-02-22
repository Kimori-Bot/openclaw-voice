#!/usr/bin/env python3
"""
Whisper transcription server for OpenClaw Voice Bot
Supports both file-based and streaming transcription for real-time processing
"""
import sys
import os
import asyncio
from pathlib import Path

# Activate venv
venv_path = Path("/workspace/whisper-env")
if venv_path.exists():
    sys.path.insert(0, str(venv_path / "lib" / f"python{sys.version_info.major}.{sys.version_info.minor}" / "site-packages"))

from faster_whisper import WhisperModel
from aiohttp import web
import asyncio
import queue
import threading

# Load model - tiny is fastest for real-time
model_size = os.environ.get('WHISPER_MODEL', 'tiny')
print(f"Loading Whisper model: {model_size}...")
model = WhisperModel(model_size, device="cpu", compute_type="int8")
print(f"Model loaded: {model_size}!")

# Streaming transcription state
stream_state = {}  # stream_id -> {"segments": [], "processing": False}

async def transcribe_handler(request):
    """File-based transcription (legacy)"""
    data = await request.json()
    audio_path = data.get("path")
    
    try:
        if audio_path and os.path.exists(audio_path):
            segments, info = model.transcribe(audio_path, language="en")
            text = " ".join([s.text for s in segments])
            return web.json_response({"text": text, "language": info.language})
        return web.json_response({"text": "", "error": "No audio provided"})
    except Exception as e:
        return web.json_response({"text": "", "error": str(e)})

async def stream_start_handler(request):
    """Start a new streaming transcription"""
    data = await request.json()
    stream_id = data.get("stream_id", "default")
    
    stream_state[stream_id] = {
        "segments": [],
        "text": "",
        "processing": False
    }
    
    return web.json_response({"status": "started", "stream_id": stream_id})

async def stream_audio_handler(request):
    """Add audio chunks to stream and get partial results"""
    data = await request.json()
    stream_id = data.get("stream_id", "default")
    audio_base64 = data.get("audio")  # base64 encoded audio chunk
    
    if stream_id not in stream_state:
        return web.json_response({"error": "Stream not started"}, status=400)
    
    # For now, accumulate chunks and transcribe when we have enough
    # True streaming would require more complex buffer management
    state = stream_state[stream_id]
    
    # Decode base64 audio (simple approach - could optimize)
    if audio_base64:
        import base64
        audio_bytes = base64.b64decode(audio_base64)
        
        # Save to temp file
        temp_file = f"/tmp/stream_{stream_id}_{asyncio.get_event_loop().time()}.wav"
        with open(temp_file, 'wb') as f:
            f.write(audio_bytes)
        
        # Transcribe
        try:
            segments, info = model.transcribe(temp_file, language="en", 
                                              beam_size=1,  # Faster
                                              vad_filter=True)  # Voice activity detection
            text = " ".join([s.text for s in segments])
            state["text"] = text
            os.unlink(temp_file)
        except Exception as e:
            return web.json_response({"text": "", "error": str(e)})
    
    return web.json_response({
        "text": state["text"],
        "stream_id": stream_id
    })

async def stream_result_handler(request):
    """Get current transcription result"""
    stream_id = request.query.get("stream_id", "default")
    
    if stream_id in stream_state:
        return web.json_response({
            "text": stream_state[stream_id]["text"],
            "stream_id": stream_id
        })
    return web.json_response({"text": ""})

async def stream_end_handler(request):
    """End streaming transcription"""
    data = await request.json()
    stream_id = data.get("stream_id", "default")
    
    if stream_id in stream_state:
        final_text = stream_state[stream_id]["text"]
        del stream_state[stream_id]
        return web.json_response({"text": final_text})
    
    return web.json_response({"text": ""})

async def index(request):
    return web.Response(text="Whisper transcription service running (streaming supported)")

app = web.Application()
app.router.add_get("/", index)
app.router.add_post("/transcribe", transcribe_handler)
app.router.add_post("/stream/start", stream_start_handler)
app.router.add_post("/stream/audio", stream_audio_handler)
app.router.add_get("/stream/result", stream_result_handler)
app.router.add_post("/stream/end", stream_end_handler)

if __name__ == "__main__":
    print("Starting Whisper server on port 5001 (streaming enabled)...")
    web.run_app(app, host="127.0.0.1", port=5001)
