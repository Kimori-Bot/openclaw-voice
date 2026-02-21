---
name: openclaw-voice
description: Discord voice bot with VAD, OpenClaw AI integration, TTS, and interrupt handling. Pure Node.js.
metadata:
  openclaw:
    emoji: "🎤"
    requires:
      bins: ["node", "npm", "ffmpeg", "whisper"]
      env:
        - DISCORD_TOKEN
        - DISCORD_GUILD_ID
        - OPENCLAW_API
        - OPENCLAW_GATEWAY_PASSWORD
        - WAKE_WORD (default: "kimori")
        - RESPONSE_MODE (default: "ai")
        - TTS_ENGINE (default: "gtts")
    context:
      voice:
        # This context is automatically injected when AI is called from voice
        in_voice_channel: boolean
        members_in_channel: string[]
        currently_playing: string | null
        queue_length: number
        capabilities: string[]
---

# OpenClaw Voice Skill

Discord voice bot with Voice Activity Detection (VAD), AI-powered conversations via OpenClaw, TTS playback, and interrupt handling. **Pure Node.js rewrite.**

## Architecture

```
User speaks in voice
  → Discord speaking events (VAD)
  → Gather voice context (members, playing, queue)
  → Send to OpenClaw via /v1/chat/completions with voice context
  → OpenClaw AI processes (knows it's in voice, can play music, etc.)
  → Response → gTTS/ElevenLabs → Play audio
  → Interrupt handling for natural conversation
```

## Voice Context

When the AI receives a voice message, it automatically gets context about:

```json
{
  "in_voice_channel": true,
  "members_in_channel": ["Kevin", "OtherUser"],
  "currently_playing": "Song Name by Artist",
  "queue_length": 5,
  "capabilities": [
    "play music (say 'play <song name>' to play a song)",
    "skip song (say 'skip' to skip)",
    "search for streams",
    "control playback",
    "general conversation"
  ]
}
```

The AI uses this to understand it's in a voice chat and can respond accordingly (e.g., "Sure, let me play that song!").

## Setup

### 1. Install Dependencies

```bash
# Core dependencies
apt install -y ffmpeg

# For transcription (voice-to-text)
pip install openai-whisper --break-system-packages
# Or on Mac: brew install whisper

# Clone and setup the bot
git clone https://github.com/kimoribot/openclaw-voice.git
cd openclaw-voice
npm install
cp .env.example .env
```

### 2. Discord Bot Setup

1. Go to https://discord.com/developers/applications
2. Create application → Bot
3. Enable **Server Members Intent** (required for voice)
4. Enable **Message Content Intent**
5. Generate OAuth2 URL: `bot` + `voice channels` scopes
6. Copy token

### 2. OpenClaw Setup (Required for AI)

Enable the Chat Completions endpoint:

```bash
openclaw config patch --json '{"gateway":{"http":{"endpoints":{"chatCompletions":{"enabled":true}}}}}'
```

Get the gateway password from your `openclaw.json`:
```bash
grep -A2 '"auth"' /root/.openclaw/openclaw.json
```

### 3. Install Voice Bot

```bash
git clone https://github.com/kimoribot/openclaw-voice.git
cd openclaw-voice
npm install
cp .env.example .env
```

### 4. Configure .env

```env
# Discord
DISCORD_TOKEN=your_discord_bot_token
DISCORD_GUILD_ID=your_server_id

# OpenClaw Integration (REQUIRED)
OPENCLAW_API=http://localhost:18789
OPENCLAW_GATEWAY_PASSWORD=your_gateway_password

# TTS (default: gTTS - free)
TTS_ENGINE=gtts
# Or for better voice (requires API key):
# TTS_ENGINE=elevenlabs
# ELEVENLABS_API_KEY=your_key
# TTS_VOICE=21m00Tcm4TlvDq8ikWAM

# Server
PORT=5000

# Voice Settings
WAKE_WORD=kimori          # Wake word to trigger response (or "echo" to repeat everything)
RESPONSE_MODE=ai          # "ai" = AI response, "echo" = repeat user speech
ALWAYS_RESPOND=false      # If true, always respond even without wake word
```

### 5. Run

```bash
npm start
```

## Commands

| Command | Description |
|---------|-------------|
| `/join` | Join your voice channel |
| `/leave` | Leave voice channel |
| `/play [query]` | Search YouTube and play a song |
| `/search [query]` | AI web search for any stream (radio, YouTube, Twitch, etc.) |
| `/stream [url]` | Play a direct audio stream URL |
| `/queue` | Show current queue |
| `/skip` | Skip current song |
| `/stop` | Stop playing and clear queue |
| `/clear` | Clear the queue |
| `/listen` | Start AI voice conversation (VAD + OpenClaw) |
| `/stop_listen` | Stop listening |
| `/say [text]` | Speak text via TTS |
| `/help` | Show help |

## Audio Sources

The bot supports multiple audio sources:

- **YouTube** - Videos and music via `/play`
- **Direct URLs** - Any direct audio stream (MP3, OGG, etc.) via `/stream`
- **Web Search** - AI searches the entire web for streams via `/search`

### /search Command

The `/search` command uses OpenClaw AI to search the entire web for any playable audio:
- YouTube videos
- Radio stations (iHeartRadio, TuneIn, etc.)
- Twitch streams
- Direct audio URLs
- Any other streaming audio

Example: `/search lofi hip hop radio` - AI finds a live radio stream

## REST API

```bash
# Health check
curl http://localhost:5000/health

# Debug info
curl http://localhost:5000/debug

# Speak text
curl -X POST http://localhost:5000/speak \
  -H "Content-Type: application/json" \
  -d '{"guild_id": "123", "text": "Hello!"}'

# Start listening (VAD)
curl -X POST http://localhost:5000/listen \
  -H "Content-Type: application/json" \
  -d '{"guild_id": "123"}'

# Stop listening
curl -X POST http://localhost:5000/stop_listen \
  -H "Content-Type: application/json" \
  -d '{"guild_id": "123"}'
```

## OpenClaw Integration

### How It Works

1. User joins voice and runs `/listen`
2. Bot detects when user starts/stops speaking (via Discord's speaking events)
3. Audio captured → sent to OpenClaw via `/v1/chat/completions`
4. OpenClaw processes → returns response
5. Response → TTS → played to voice channel

### Communication Protocol

```javascript
// Bot → OpenClaw (POST /v1/chat/completions)
{
  model: "openclaw",
  messages: [
    { role: "system", content: "You are Kimori, a helpful AI assistant." },
    { role: "user", content: "[User spoke in voice - respond naturally]" }
  ],
  max_tokens: 200
}

// OpenClaw → Bot
{
  choices: [{ message: { content: "Hello! How can I help?" } }]
}
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENCLAW_API` | Yes | OpenClaw gateway URL (e.g., `http://localhost:18789`) |
| `OPENCLAW_GATEWAY_PASSWORD` | If auth mode=password | Gateway password |
| `OPENCLAW_GATEWAY_TOKEN` | If auth mode=token | Gateway token |
| `OPENCLAW_API_KEY` | If using API key | Direct API key |
| `OPENCLAW_SESSION` | No | Session name (default: main) |

#### Auth Modes

OpenClaw supports different auth configurations. Use the one matching your setup:

**Password mode (default):**
```env
OPENCLAW_GATEWAY_PASSWORD=your_password
```

**Token mode:**
```env
OPENCLAW_GATEWAY_TOKEN=your_token
```

**No auth (local/dev):**
```env
# Leave auth vars empty
OPENCLAW_API=http://localhost:18789
```

## TTS Options

### gTTS (Default - Free)
```env
TTS_ENGINE=gtts
```
- Free, no API key needed
- Robotic but reliable
- Uses Google Translate

### ElevenLabs (Premium)
```env
TTS_ENGINE=elevenlabs
ELEVENLABS_API_KEY=your_api_key
TTS_VOICE=21m00Tcm4TlvDq8ikWAM
```
- Natural voice quality
- 10k chars free/month

## Troubleshooting

```bash
# Check if bot is running
curl http://localhost:5000/health

# Test OpenClaw API directly
curl -X POST http://localhost:18789/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_PASSWORD' \
  -H 'Content-Type: application/json' \
  -d '{"model": "openclaw", "messages": [{"role": "user", "content": "hi"}]}'

# View logs
tail -f /tmp/openclaw-voice.log
```

### Common Issues

- **Bot not joining voice**: Check Discord permissions (Connect, Speak)
- **No AI responses**: 
  1. Run: `curl http://localhost:5000/debug` to check config
  2. Test OpenClaw API directly (see above)
  3. Verify `OPENCLAW_GATEWAY_PASSWORD` is correct
- **TTS not working**: Check `TTS_ENGINE` setting
