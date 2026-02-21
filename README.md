# OpenClaw Voice

A flexible Discord voice channel bot for OpenClaw - plays music, streams audio, and can be triggered by OpenClaw to send voice notifications.

## Features

- **Music Streaming**: Play YouTube audio in voice channels
- **Voice Notifications**: OpenClaw can trigger voice announcements (builds complete, reminders, etc.)
- **Configurable Bot Name**: Works with any bot name (not Kimori-specific)
- **Native Commands**: Full Discord slash command support

## Quick Start

```bash
# Install dependencies
pip install -r requirements.txt

# Configure
cp .env.example .env
# Edit .env with your bot token and settings

# Run
python3 bot.py
```

## Configuration (.env)

```env
DISCORD_BOT_TOKEN=your_token_here
BOT_NAME=OpenClaw
DEFAULT_VOLUME=0.8
```

## Commands

- `/play <query>` - Play YouTube audio
- `/stop` - Stop playback
- `/join` - Join your voice channel
- `/leave` - Leave voice channel

## OpenClaw Integration

Trigger voice notifications from OpenClaw:

```bash
curl -X POST http://localhost:5000/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Kevin, your build is done!", "channel_id": "123456789"}'
```

## Docker

```bash
docker build -t openclaw-voice .
docker run -d --env-file .env openclaw-voice
```

## License

MIT
