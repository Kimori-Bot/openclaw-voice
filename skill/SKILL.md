---
name: voice-music
description: Control music playback in Discord voice channels via the OpenClaw Voice Bot API
metadata: { "openclaw": { "emoji": "🎵", "requires": { "env": ["VOICE_API_PORT"] } } }
---

# Voice Music

Control music playback in Discord voice channels via the OpenClaw Voice Bot API.

## Configuration

Set environment variable `VOICE_API_PORT` (default: `5000`)

## Available Commands

### Play Music

```bash
curl -s -X POST http://localhost:$VOICE_API_PORT/play \
  -H "Content-Type: application/json" \
  -d '{"url": "song name or YouTube URL", "guild_id": "DISCORD_GUILD_ID"}'
```

Example:
```bash
curl -s -X POST http://localhost:5000/play \
  -H "Content-Type: application/json" \
  -d '{"url": "Tame Impala", "guild_id": "1234567890"}'
```

### Get Queue

```bash
curl -s http://localhost:$VOICE_API_PORT/queue/DISCORD_GUILD_ID
```

### Skip Song

Currently handled via /skip slash command.

### Stop Playback

Currently handled via /stop slash command.

## Usage Notes

- `guild_id` is the Discord server/guild ID
- The voice bot must be connected to a voice channel in that guild
- Use YouTube search or direct YouTube URLs
