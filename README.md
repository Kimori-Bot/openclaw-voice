# OpenClaw Voice

A flexible Discord voice channel bot for OpenClaw - plays music, streams audio, and transcribes voice in real-time.

## Architecture

- **Bot**: Node.js (discord.js + @discordjs/voice)
- **STT**: FasterWhisper (local, real-time streaming with VAD)
- **TTS**: ElevenLabs (or gTTS fallback)

## Features

- **Music Streaming**: Play YouTube audio in voice channels
- **Voice Conversation**: AI-powered voice chat with wake word detection
- **Real-time Transcription**: Local whisper with VAD (no cloud costs)
- **Slash Commands**: Full Discord command support

## Quick Start

```bash
# Install Node dependencies
npm install

# Configure
cp .env.example .env
# Edit .env with your bot token and settings

# Start whisper.cpp server (fastest STT)
# Download tiny model if not present:
# mkdir -p ~/.whisper && wget -O ~/.whisper/ggml-tiny.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin
whisper-server --model /root/.whisper/ggml-tiny.bin --port 5001 &

# Start the bot
node src/index.js
```

## Configuration (.env)

```env
DISCORD_BOT_TOKEN=your_token_here
TTS_ENGINE=elevenlabs
STT_ENGINE=local
WHISPER_MODEL=tiny
ELEVENLABS_API_KEY=your_key
```

## Commands

- `/play <query>` - Play YouTube audio
- `/search <query>` - AI-powered song search
- `/stream <url>` - Play from direct URL
- `/queue` - Show queue
- `/skip` - Skip song
- `/stop` - Stop playback
- `/join` - Join voice channel
- `/leave` - Leave voice channel
- `/listen` - Start voice conversation
- `/say <text>` - Text to speech

## STT Options

### whisper.cpp (Default - Fastest)
- C++ implementation, no Python overhead
- Built-in server on port 5001
- Tiny model for real-time speed
- Start: `whisper-server --model /path/to/ggml-tiny.bin --port 5001`

### FasterWhisper (Fallback)
- Python implementation
- Set `WHISPER_SERVER=http://127.0.0.1:5002` (different port)

## TTS Options

### ElevenLabs (Default)
- Set `TTS_ENGINE=elevenlabs`
- Natural voice output

### gTTS (Fallback)
- Set `TTS_ENGINE=local`
- Free, Google TTS

## API

```bash
# Health check
curl http://localhost:5000/health

# Join voice
curl -X POST http://localhost:5000/join \
  -H "Content-Type: application/json" \
  -d '{"guild_id": "123", "channel_id": "456"}'

# Play audio
curl -X POST http://localhost:5000/play \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/audio.mp3", "guild_id": "123"}'

# Whisper transcription
curl -X POST http://127.0.0.1:5001/transcribe \
  -H "Content-Type: application/json" \
  -d '{"path": "/path/to/audio.wav"}'
```

## License

MIT
