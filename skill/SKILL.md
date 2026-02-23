---
name: openclaw-voice
description: Discord voice bot with whisper.cpp transcription, OpenClaw AI integration, gTTS, and wake word detection.
metadata:
  openclaw:
    emoji: "🎤"
    requires:
      bins: ["node", "npm", "ffmpeg"]
      npm: ["discord.js", "@discordjs/voice", "express", "opusscript"]
---

# OpenClaw Voice

Discord voice bot with voice transcription, AI conversation via OpenClaw, and gTTS. Uses whisper.cpp CLI for local transcription and OpenClaw agent CLI for context-aware responses.

## Architecture

```
User speaks in voice
  → Discord speaking events
  → Capture Opus audio → opusscript decode → PCM
  → whisper.cpp CLI transcription
  → Check wake word (unless ALWAYS_RESPOND=true)
  → Send to OpenClaw via 'openclaw agent' CLI (session reuse = context!)
  → Response → gTTS → Play audio
```

## Key Features

- **Session Reuse**: Uses `openclaw agent --channel discord --session-id <guildId>` for persistent context
- **Wake Word Detection**: Only responds when wake word detected (configurable)
- **Local Transcription**: whisper.cpp CLI (no external API)
- **Proper Opus Decoding**: Uses opusscript to decode Discord's Opus packets
- **Recording**: Capture audio to files for debugging

## Platform Support

This skill works on Linux, macOS, and Windows.

## Setup

### 1. Install Dependencies

**All Platforms:**
```bash
# Core dependencies
- Node.js 18+
- npm
- ffmpeg

# Install Node dependencies
cd openclaw-voice
npm install
```

**Linux (systemd):**
```bash
# Install service
sudo cp openclaw-voice.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable openclaw-voice
```

### 2. Download Whisper Model

```bash
mkdir -p ~/.whisper
wget -O ~/.whisper/ggml-tiny.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin
```

### 3. Configure .env

```bash
cp .env.example .env
```

```env
# Discord
DISCORD_BOT_TOKEN=your_discord_bot_token

# Voice Settings  
WAKE_WORD=echo              # Wake word (comma-separated: echo,kimori)
ALWAYS_RESPOND=false        # If true, respond to everything

# STT (whisper.cpp CLI)
STT_ENGINE=local
WHISPER_MODEL=tiny

# TTS (gTTS is default)
TTS_ENGINE=local

# Optional: ElevenLabs for better TTS
# TTS_ENGINE=elevenlabs
# ELEVENLABS_API_KEY=your_key
# ELEVENLABS_VOICE_ID=rachel
```

### 4. Run

**Linux (systemd):**
```bash
sudo systemctl start openclaw-voice
sudo systemctl status openclaw-voice
```

**Direct:**
```bash
node src/index.js
```

## Commands

| Command | Description |
|---------|-------------|
| `/join` | Join your voice channel |
| `/leave` | Leave voice channel |
| `/play [query]` | Search YouTube and play |
| `/search [query]` | AI search for streams |
| `/stream [url]` | Play direct audio URL |
| `/queue` | Show queue |
| `/skip` | Skip song |
| `/stop` | Stop and clear |
| `/listen` | Start voice conversation |
| `/stop_listen` | Stop listening |
| `/record` | Start recording |
| `/stop_record` | Stop and save recording |
| `/say [text]` | Speak text via TTS |
| `/help` | Show help |

## AI Integration (OpenClaw)

The bot integrates with OpenClaw for AI-powered voice conversations. When users speak in voice chat, it's transcribed and sent to OpenClaw for processing.

### REST API (Port 5000)

AI can control the bot via REST API using `exec` tool with curl:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/play` | POST | Play a song |
| `/queue/:guildId` | GET | Get current queue |
| `/skip/:guildId` | POST | Skip current song |
| `/stop/:guildId` | POST | Stop and clear queue |
| `/leave/:guildId` | POST | Leave voice channel |
| `/nowplaying/:guildId` | GET | Get now playing |
| `/reset/:guildId` | POST | Reset AI session |
| `/health` | GET | Health check |

#### Examples

**Play a song:**
```bash
curl -X POST http://localhost:5000/play \
  -H "Content-Type: application/json" \
  -d '{"url": "song name or YouTube URL", "guild_id": "DISCORD_GUILD_ID"}'
```

**Get queue:**
```bash
curl http://localhost:5000/queue/DISCORD_GUILD_ID
```

**Skip song:**
```bash
curl -X POST http://localhost:5000/skip/DISCORD_GUILD_ID
```

**Stop playback:**
```bash
curl -X POST http://localhost:5000/stop/DISCORD_GUILD_ID
```

**Leave voice:**
```bash
curl -X POST http://localhost:5000/leave/DISCORD_GUILD_ID
```

**Get now playing:**
```bash
curl http://localhost:5000/nowplaying/DISCORD_GUILD_ID
```

**Reset AI session (fresh identity):**
```bash
curl -X POST http://localhost:5000/reset/DISCORD_GUILD_ID
```

**Health check:**
```bash
curl http://localhost:5000/health
```

**Note:** Always include `guild_id` in requests. The bot must be in a voice channel in that guild.

## Voice Conversation

1. Join a voice channel
2. Use `/listen` to start transcription
3. Say the wake word ("echo") followed by your message
   - Example: "hey echo, what's the weather?"
4. Bot will respond with TTS

### Wake Word

Default wake word is `echo`. Say "hey echo" or "okay echo" to trigger.

Wake word variations:
- "echo" (the configured wake word)
- "hey echo"
- "okay echo"

Set `ALWAYS_RESPOND=true` in .env to respond to all speech without wake word.

## Recording

Use `/record` to start capturing audio and `/stop_record` to save. Files are saved to `/tmp/openclaw-recordings/`.

Useful for debugging audio capture issues.

## Troubleshooting

```bash
# Check bot logs
journalctl -u openclaw-voice -n 50

# Check recordings
ls -la /tmp/openclaw-recordings/

# Test whisper CLI
whisper-cli -m ~/.whisper/ggml-tiny.bin -f /tmp/test.wav -otxt

# Test OpenClaw
openclaw agent --channel discord --session-id 123 --message "hello"
```

## Files

- Bot: `src/index.js`
- Voice manager: `src/modules/voice.js`
- Transcription: `src/modules/transcription.js`
- Config: `.env`
- Service: `openclaw-voice.service`
