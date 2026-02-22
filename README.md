# OpenClaw Voice

A flexible Discord voice channel bot for OpenClaw - plays music, streams audio, and transcribes voice in real-time.

## Architecture

- **Bot**: Node.js (discord.js + @discordjs/voice)
- **STT**: whisper.cpp CLI (local, direct binary execution)
- **TTS**: gTTS (free Google TTS)
- **Audio Decoding**: opusscript for Discord Opus packets

## Features

- **Music Streaming**: Play YouTube audio in voice channels
- **Voice Conversation**: AI-powered voice chat with wake word detection
- **Real-time Transcription**: Local whisper.cpp with voice activity detection
- **Slash Commands**: Full Discord command support
- **Recording**: Capture voice audio to files for debugging

## Quick Start

```bash
# Install Node dependencies
npm install

# Configure
cp .env.example .env
# Edit .env with your bot token and settings

# Download whisper tiny model (if not present)
mkdir -p ~/.whisper 
wget -O ~/.whisper/ggml-tiny.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin

# Start the bot (uses systemd service)
systemctl start openclaw-voice

# Or run directly
node src/index.js
```

## Configuration (.env)

```env
# Required
DISCORD_BOT_TOKEN=your_discord_bot_token

# Voice conversation
WAKE_WORD=echo
ALWAYS_RESPOND=false

# STT (whisper.cpp - uses CLI directly, no server needed)
STT_ENGINE=local
WHISPER_MODEL=tiny

# TTS (gTTS is default - free)
TTS_ENGINE=local

# Optional: ElevenLabs for better TTS
# TTS_ENGINE=elevenlabs
# ELEVENLABS_API_KEY=your_key
# ELEVENLABS_VOICE_ID=rachel
```

## Commands

| Command | Description |
|---------|-------------|
| `/join` | Join your voice channel |
| `/leave` | Leave voice channel |
| `/play <query>` | Play YouTube audio |
| `/search <query>` | AI-powered song search |
| `/stream <url>` | Play from direct URL |
| `/queue` | Show queue |
| `/skip` | Skip song |
| `/stop` | Stop playback |
| `/listen` | Start voice conversation |
| `/stop_listen` | Stop listening |
| `/record` | Start recording audio |
| `/stop_record` | Stop and save recording |
| `/say <text>` | Text to speech |
| `/help` | Show help |

## Voice Conversation

1. Join a voice channel
2. Use `/listen` to start transcription
3. Say the wake word ("echo") followed by your message
   - Example: "hey echo, what's the weather?"
4. Bot will respond with TTS

### Wake Word

Default wake word is `echo`. Say "hey echo" or "okay echo" to trigger.

Set `ALWAYS_RESPOND=true` in .env to respond to all speech without wake word.

## Recording

Use `/record` to start capturing audio and `/stop_record` to save. Files are saved to `/tmp/openclaw-recordings/`.

Useful for debugging audio capture issues.

## Troubleshooting

### Bot not hearing you
- Check `/tmp/openclaw-recordings/` for recorded audio
- Verify your microphone is working in Discord
- Make sure you're not muted

### Transcription not working
- Check logs: `journalctl -u openclaw-voice -n 50`
- Try recording and playing back the audio
- Verify whisper model exists at `~/.whisper/ggml-tiny.bin`

### Bot keeps getting kicked
- Ensure the bot has permission to stay in voice channels
- Check Discord server settings

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
```

## Systemd Service

The bot includes a systemd service for production use:

```bash
# Install
sudo cp openclaw-voice.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable openclaw-voice

# Control
sudo systemctl start openclaw-voice
sudo systemctl stop openclaw-voice
sudo systemctl restart openclaw-voice
sudo journalctl -u openclaw-voice -f
```

## License

MIT
