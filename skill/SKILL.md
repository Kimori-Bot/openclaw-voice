---
name: openclaw-voice
description: Discord voice bot with FasterWhisper transcription, OpenClaw AI integration via agent CLI, TTS, and wake word detection.
metadata:
  openclaw:
    emoji: "🎤"
    requires:
      bins: ["node", "npm", "ffmpeg", "python3"]
      npm: ["discord.js", "@discordjs/voice", "express"]
      pip: ["faster-whisper", "aiohttp"]
---

# OpenClaw Voice

Discord voice bot with voice transcription, AI conversation via OpenClaw, and TTS. Uses local FasterWhisper for transcription and OpenClaw agent CLI for context-aware responses.

## Architecture

```
User speaks in voice
  → Discord speaking events (VAD)
  → Capture audio → FasterWhisper transcription
  → Check wake word (unless ALWAYS_RESPOND=true)
  → Send to OpenClaw via 'openclaw agent' CLI (session reuse = context!)
  → Response → gTTS → Play audio
```

## Key Features

- **Session Reuse**: Uses `openclaw agent --channel discord --to <guildId>` for persistent context
- **Wake Word Detection**: Only responds when wake word detected (configurable)
- **Local Transcription**: FasterWhisper (no external API)
- **No Emojis**: System prompt instructs AI to avoid emojis (don't translate well to speech)

## Setup

### 1. Install Dependencies

```bash
# Core
apt install -y ffmpeg nodejs npm

# Transcription (FasterWhisper - runs as local server)
pip install faster-whisper aiohttp

# Clone
git clone https://github.com/kimoribot/openclaw-voice.git
cd openclaw-voice
npm install
```

### 2. Configure .env

```bash
cp .env.example .env
# Edit .env with your settings
```

```env
# Discord
DISCORD_BOT_TOKEN=your_discord_bot_token
DISCORD_GUILD_ID=your_server_id

# OpenClaw
OPENCLAW_API=http://localhost:18789
OPENCLAW_GATEWAY_PASSWORD=your_gateway_password

# Voice Settings  
WAKE_WORD=echo              # Wake word (comma-separated: echo,kimori)
ALWAYS_RESPOND=false        # If true, respond to everything
RESPONSE_MODE=ai            # "ai" = AI, "echo" = repeat speech
WHISPER_MODEL=medium       # tiny, base, small, medium, large
WHISPER_AUTOSTART=true     # Auto-start whisper server
DISCORD_CHANNEL_ID=        # Optional: specific channel for AI
```

### 3. Run

**Option A: Direct**
```bash
node src/index.js
```

**Option B: Systemd Service (recommended for production)**
```bash
# Copy service file
sudo cp openclaw-voice.service /etc/systemd/system/

# Edit path in service file if different
sudo nano /etc/systemd/system/openclaw-voice.service

# Enable and start
sudo systemctl daemon-reload
sudo systemctl enable openclaw-voice
sudo systemctl start openclaw-voice

# Check status
sudo systemctl status openclaw-voice

# Restart after updates
sudo systemctl restart openclaw-voice
```

**Option C: Auto-start with bot (default)**
The bot will auto-start the whisper server if `WHISPER_AUTOSTART=true` (default).

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
| `/voice` | Start AI voice conversation |
| `/say [text]` | Speak text via TTS |

## How Voice Conversation Works

1. User says wake word + message in voice (e.g., "Kimori, what's the weather?")
2. Bot captures audio, transcribes with FasterWhisper
3. Wake word detected → sends to OpenClaw
4. OpenClaw processes via `openclaw agent` (reuses session per channel!)
5. Response spoken via TTS

### Wake Word Variations
- Configured WAKE_WORD (default: "kimori")
- "hey kimori"
- "okay kimori"
- "hey openclaw"

### IMPORTANT: Music Control

The AI cannot directly control music. When users ask to play music:
- AI responds: "Type /play [song name] in chat to play music"
- Users must use slash commands in Discord text chat

This is by design - the AI is a *helper* in voice, not the music bot controller.

## REST API

```bash
# Health
curl http://localhost:5000/health

# Speak
curl -X POST http://localhost:5000/speak \
  -H "Content-Type: application/json" \
  -d '{"guild_id": "123", "text": "Hello!"}'
```

## Troubleshooting

```bash
# Check whisper server
curl -X POST http://localhost:5001/transcribe \
  -H "Content-Type: application/json" \
  -d '{"path": "/tmp/test.wav"}'

# Check bot
curl http://localhost:5000/health

# Test OpenClaw
openclaw agent --channel discord --to 1474223195786711113 --message "hello"
```

## Files

- Bot: `src/index.js`
- Whisper server: `whisper-server.py`
- Config: `.env`
