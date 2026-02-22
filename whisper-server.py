#!/usr/bin/env python3
"""
Whisper transcription server - Real-time streaming with VAD
Optimized for low-latency transcription using FasterWhisper chunked processing
"""
import sys
import os
import asyncio
import base64
from pathlib import Path
from collections import defaultdict

# Activate venv
venv_path = Path("/workspace/whisper-env")
if venv_path.exists():
    sys.path.insert(0, str(venv_path / "lib" / f"python{sys.version_info.major}.{sys.version_info.minor}" / "site-packages"))

from faster_whisper import WhisperModel
from aiohttp import web
import numpy as np

# Load tiny model for speed
model_size = os.environ.get('WHISPER_MODEL', 'tiny')
print(f"Loading Whisper model: {model_size}...")
model = WhisperModel(model_size, device="cpu", compute_type="int8")
print(f"Model loaded: {model_size}!")

# Streaming state per stream_id
class StreamState:
    def __init__(self, stream_id):
        self.stream_id = stream_id
        self.audio_chunks = []  # Accumulate audio chunks
        self.last_result = ""
        self.partial_result = ""
        
streams = {}

async def index(request):
    return web.Response(text="Whisper streaming service (real-time)")

async def stream_start(request):
    """Start a new streaming session"""
    data = await request.json()
    stream_id = data.get("stream_id", "default")
    
    streams[stream_id] = StreamState(stream_id)
    print(f"Stream started: {stream_id}")
    
    return web.json_response({"status": "started", "stream_id": stream_id})

async def stream_audio(request):
    """Process incoming audio chunk and return transcription"""
    try:
        data = await request.json()
    except:
        return web.json_response({"error": "Invalid JSON"}, status=400)
    
    stream_id = data.get("stream_id", "default")
    audio_base64 = data.get("audio", "")
    
    if stream_id not in streams:
        return web.json_response({"error": "Stream not started"}, status=400)
    
    state = streams[stream_id]
    
    if not audio_base64:
        return web.json_response({"text": state.partial_result, "stream_id": stream_id})
    
    try:
        # Decode base64 audio
        audio_bytes = base64.b64decode(audio_base64)
        
        # Save to temp file
        temp_file = f"/tmp/stream_{stream_id}.wav"
        with open(temp_file, 'wb') as f:
            f.write(audio_bytes)
        
        # Transcribe with VAD for speech detection
        # Use chunk_length=30 for streaming, vad_filter for silence detection
        segments, info = model.transcribe(
            temp_file,
            language="en",
            chunk_length=30,  # Process in 30s chunks
            beam_size=1,       # Faster decoding
            vad_filter=True,   # Voice activity detection
            vad_parameters=dict(min_silence_duration_ms=500)
        )
        
        # Collect all segment text
        segment_texts = []
        async for segment in segments:
            segment_texts.append(segment.text)
        
        result_text = " ".join(segment_texts).strip()
        state.partial_result = result_text
        
        # Cleanup
        os.unlink(temp_file)
        
        return web.json_response({
            "text": result_text,
            "language": info.language if hasattr(info, 'language') else "en",
            "stream_id": stream_id
        })
        
    except Exception as e:
        print(f"Transcription error: {e}")
        return web.json_response({"text": state.partial_result, "error": str(e)})

async def stream_result(request):
    """Get current transcription result"""
    stream_id = request.query.get("stream_id", "default")
    
    if stream_id in streams:
        return web.json_response({
            "text": streams[stream_id].partial_result,
            "stream_id": stream_id
        })
    return web.json_response({"text": ""})

async def stream_end(request):
    """End streaming session and return final result"""
    data = await request.json()
    stream_id = data.get("stream_id", "default")
    
    if stream_id in streams:
        final = streams[stream_id].partial_result
        del streams[stream_id]
        print(f"Stream ended: {stream_id}")
        return web.json_response({"text": final})
    
    return web.json_response({"text": ""})

async def transcribe_legacy(request):
    """Legacy file-based transcription"""
    data = await request.json()
    audio_path = data.get("path")
    
    if not audio_path or not os.path.exists(audio_path):
        return web.json_response({"text": "", "error": "File not found"})
    
    try:
        segments, info = model.transcribe(
            audio_path, 
            language="en",
            beam_size=1,
            vad_filter=True
        )
        text = " ".join([s.text for s in segments])
        return web.json_response({"text": text, "language": info.language})
    except Exception as e:
        return web.json_response({"text": "", "error": str(e)})

# WebSocket for true streaming
from aiohttp import web, WSMsgType as WSMessageType

async def ws_transcribe(request):
    """WebSocket endpoint for real-time streaming"""
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    
    stream_id = request.query.get("stream_id", "ws_default")
    state = StreamState(stream_id)
    streams[stream_id] = state
    
    print(f"WebSocket stream started: {stream_id}")
    
    try:
        async for msg in ws:
            if msg.type == WSMessageType.TEXT:
                try:
                    data = msg.json()
                    audio_base64 = data.get("audio", "")
                    
                    if audio_base64:
                        audio_bytes = base64.b64decode(audio_base64)
                        temp_file = f"/tmp/ws_{stream_id}.wav"
                        with open(temp_file, 'wb') as f:
                            f.write(audio_bytes)
                        
                        # Quick transcription
                        segments, _ = model.transcribe(
                            temp_file,
                            language="en",
                            chunk_length=30,
                            beam_size=1,
                            vad_filter=True
                        )
                        
                        texts = [s.text async for s in segments]
                        result = " ".join(texts).strip()
                        state.partial_result = result
                        
                        os.unlink(temp_file)
                        
                        await ws.send_json({"text": result, "stream_id": stream_id})
                    elif data.get("get_result"):
                        await ws.send_json({"text": state.partial_result})
                        
                except Exception as e:
                    await ws.send_json({"error": str(e)})
                    
            elif msg.type == WSMessageType.ERROR:
                break
                
    finally:
        if stream_id in streams:
            del streams[stream_id]
        print(f"WebSocket stream ended: {stream_id}")
    
    return ws

app = web.Application()
app.router.add_get("/", index)
app.router.add_post("/transcribe", transcribe_legacy)
app.router.add_post("/stream/start", stream_start)
app.router.add_post("/stream/audio", stream_audio)
app.router.add_get("/stream/result", stream_result)
app.router.add_post("/stream/end", stream_end)
app.router.add_get("/ws", ws_transcribe)
app.router.add_post("/ws", ws_transcribe)

if __name__ == "__main__":
    print("Starting Whisper server on port 5001 (real-time streaming)...")
    web.run_app(app, host="127.0.0.1", port=5001)
