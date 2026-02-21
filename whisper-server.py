#!/usr/bin/env python3
"""
Whisper transcription server for OpenClaw Voice Bot
Listens on localhost:5001 for audio files and returns transcribed text
"""
import sys
import os
import json
import asyncio
from pathlib import Path

# Activate venv
venv_path = Path("/workspace/whisper-env")
if venv_path.exists():
    sys.path.insert(0, str(venv_path / "lib" / f"python{sys.version_info.major}.{sys.version_info.minor}" / "site-packages"))

from faster_whisper import WhisperModel
from aiohttp import web

# Load model (tiny for speed, can upgrade to base/small)
print("Loading Whisper model...")
model = WhisperModel("small", device="cpu", compute_type="int8")
print("Model loaded!")

transcription_buffer = {}  # guildId -> {"text": "", "last_update": timestamp}

async def transcribe_handler(request):
    """Receive audio data and transcribe"""
    data = await request.json()
    guild_id = data.get("guild_id", "default")
    audio_data = data.get("audio")  # base64 encoded audio
    
    # For now, handle file path if provided
    audio_path = data.get("path")
    
    try:
        if audio_path and os.path.exists(audio_path):
            segments, info = model.transcribe(audio_path, language="en")
            text = " ".join([s.text for s in segments])
            return web.json_response({"text": text, "language": info.language})
        else:
            return web.json_response({"text": "", "error": "No audio provided"})
    except Exception as e:
        return web.json_response({"text": "", "error": str(e)})

async def buffer_text_handler(request):
    """Add text to buffer and check if sentence is complete"""
    data = await request.json()
    guild_id = data.get("guild_id", "default")
    new_text = data.get("text", "")
    silence_threshold_ms = data.get("silence_threshold", 1500)  # 1.5 seconds default
    
    current_time = asyncio.get_event_loop().time()
    
    if guild_id not in transcription_buffer:
        transcription_buffer[guild_id] = {"text": "", "last_update": 0, "sent_to_ai": False}
    
    buffer = transcription_buffer[guild_id]
    time_since_update = (current_time - buffer["last_update"]) * 1000
    
    # If been silent long enough and there's text, mark as ready
    if time_since_update > silence_threshold_ms and buffer["text"].strip():
        buffer["sent_to_ai"] = True
    
    # Update buffer with new text
    if new_text:
        buffer["text"] = buffer["text"] + " " + new_text if buffer["text"] else new_text
        buffer["sent_to_ai"] = False
    
    buffer["last_update"] = current_time
    
    return web.json_response({
        "buffer": buffer["text"],
        "ready": buffer["sent_to_ai"],
        "silence_ms": time_since_update
    })

async def get_buffer_handler(request):
    """Get current buffer and optionally clear it"""
    guild_id = request.query.get("guild_id", "default")
    clear = request.query.get("clear", "false").lower() == "true"
    
    buffer = transcription_buffer.get(guild_id, {"text": "", "last_update": 0, "sent_to_ai": False})
    
    if clear:
        transcription_buffer[guild_id] = {"text": "", "last_update": 0, "sent_to_ai": False}
    
    return web.json_response({
        "buffer": buffer["text"],
        "sent_to_ai": buffer["sent_to_ai"]
    })

async def index(request):
    return web.Response(text="Whisper transcription service running")

app = web.Application()
app.router.add_get("/", index)
app.router.add_post("/transcribe", transcribe_handler)
app.router.add_post("/buffer", buffer_text_handler)
app.router.add_get("/buffer", get_buffer_handler)

if __name__ == "__main__":
    print("Starting Whisper server on port 5001...")
    web.run_app(app, host="127.0.0.1", port=5001)
