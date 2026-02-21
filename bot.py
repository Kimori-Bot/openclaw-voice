#!/usr/bin/env python3
"""
OpenClaw Voice - Discord Voice Bot
A flexible, name-agnostic voice bot for OpenClaw
"""
import os
import re
import asyncio
import logging
from pathlib import Path

import discord
from discord import app_commands
import subprocess
import requests
from gtts import gTTS
import tempfile

# Load environment
from dotenv import load_dotenv
load_dotenv()

# Configuration
BOT_TOKEN = os.getenv('DISCORD_BOT_TOKEN', '')
BOT_NAME = os.getenv('BOT_NAME', 'OpenClaw')
DEFAULT_VOLUME = float(os.getenv('DEFAULT_VOLUME', '0.8'))
NOTIFIER_PORT = int(os.getenv('NOTIFIER_PORT', '5000'))

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Discord intents
intents = discord.Intents.default()
intents.message_content = True
intents.voice_states = True

bot = discord.Client(intents=intents, activity=discord.Game(name=f"{BOT_NAME} Voice"))
tree = app_commands.CommandTree(bot)

# State
voice_clients = {}
current_source = {}

def get_voice_client(guild_id):
    """Get voice client for a guild"""
    return voice_clients.get(guild_id)

async def disconnect_voice(guild_id):
    """Disconnect voice client for a guild"""
    if guild_id in voice_clients:
        try:
            await voice_clients[guild_id].disconnect()
        except:
            pass
        del voice_clients[guild_id]
    if guild_id in current_source:
        del current_source[guild_id]

# ============== SLASH COMMANDS ==============

@tree.command(name="play", description="Play YouTube audio in voice channel")
async def play_command(interaction: discord.Interaction, query: str):
    """Play music from YouTube"""
    await interaction.response.defer()
    
    if not interaction.user.voice:
        await interaction.followup.send("❌ Join a voice channel first!")
        return
    
    try:
        await interaction.followup.send(f"🔍 Searching: {query}")
        
        # Get YouTube URL
        result = subprocess.run(
            ['yt-dlp', '-f', 'bestaudio', '--get-url', f'ytsearch1:{query}'],
            capture_output=True, text=True, timeout=30
        )
        
        url = result.stdout.strip().split('\n')[0]
        
        if not url or not url.startswith('http'):
            await interaction.followup.send("❌ Couldn't find that!")
            return
        
        # Disconnect existing
        await disconnect_voice(interaction.guild_id)
        
        # Connect
        vc = await interaction.user.voice.channel.connect()
        voice_clients[interaction.guild_id] = vc
        
        await interaction.followup.send("📡 Streaming...")
        
        # Play
        source = discord.FFmpegPCMAudio(
            url,
            options="-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5"
        )
        source = discord.PCMVolumeTransformer(source)
        source.volume = DEFAULT_VOLUME
        
        def after_playing(error):
            if error:
                logger.error(f"Playback error: {error}")
            asyncio.run_coroutine_threadsafe(
                disconnect_voice(interaction.guild_id), 
                bot.loop
            )
        
        vc.play(source, after=after_playing)
        await interaction.followup.send("🎵 Now playing!")
        
    except Exception as e:
        logger.error(f"Play error: {e}")
        await interaction.followup.send(f"❌ Error: {str(e)[:100]}")

@tree.command(name="stop", description="Stop playback and leave voice channel")
async def stop_command(interaction: discord.Interaction):
    """Stop music"""
    await interaction.response.defer()
    await disconnect_voice(interaction.guild_id)
    await interaction.followup.send("⏹️ Stopped!")

@tree.command(name="join", description="Join your voice channel")
async def join_command(interaction: discord.Interaction):
    """Join voice channel"""
    if not interaction.user.voice:
        await interaction.response.send_message("❌ Join a voice channel first!")
        return
    
    await disconnect_voice(interaction.guild_id)
    vc = await interaction.user.voice.channel.connect()
    voice_clients[interaction.guild_id] = vc
    await interaction.response.send_message(f"✅ Joined {interaction.user.voice.channel.name}!")

@tree.command(name="leave", description="Leave voice channel")
async def leave_command(interaction: discord.Interaction):
    """Leave voice channel"""
    await disconnect_voice(interaction.guild_id)
    await interaction.response.send_message("👋 Left!")

# ============== MESSAGE HANDLER ==============

@bot.event
async def on_message(message):
    """Handle messages (legacy commands for compatibility)"""
    if message.author.bot:
        return
    
    content = message.content.lower()
    # Strip mentions
    content = re.sub(r'<@!?\d+>', '', content).strip()
    
    # Legacy commands
    if content.startswith('play ') or content.startswith('yt '):
        # Find user in voice
        if message.author.voice:
            # Create a mock interaction-like response
            class MockInteraction:
                def __init__(self, msg):
                    self.user = msg.author
                    self.guild_id = msg.guild.id
                    self.guild = msg.guild
            await play_command_legacy(MockInteraction(message), content.split(' ', 1)[1])
        return
    
    if content in ['stop', 'leave']:
        await disconnect_voice(message.guild.id)
        await message.channel.send("⏹️ Stopped!")

async def play_command_legacy(message, query):
    """Legacy play command for message-based commands"""
    if not message.user.voice:
        await message.channel.send("❌ Join a voice channel first!")
        return
    
    try:
        await message.channel.send(f"🔍 Searching: {query}")
        
        result = subprocess.run(
            ['yt-dlp', '-f', 'bestaudio', '--get-url', f'ytsearch1:{query}'],
            capture_output=True, text=True, timeout=30
        )
        
        url = result.stdout.strip().split('\n')[0]
        
        if not url or not url.startswith('http'):
            await message.channel.send("❌ Couldn't find it!")
            return
        
        await disconnect_voice(message.guild_id)
        
        vc = await message.user.voice.channel.connect()
        voice_clients[message.guild_id] = vc
        
        await message.channel.send("📡 Streaming...")
        
        source = discord.FFmpegPCMAudio(
            url,
            options="-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5"
        )
        source = discord.PCMVolumeTransformer(source)
        source.volume = DEFAULT_VOLUME
        
        def after_playing(error):
            if error:
                logger.error(f"Playback error: {error}")
            asyncio.run_coroutine_threadsafe(
                disconnect_voice(message.guild_id), 
                bot.loop
            )
        
        vc.play(source, after=after_playing)
        await message.channel.send("🎵 Now playing!")
        
    except Exception as e:
        logger.error(f"Play error: {e}")
        await message.channel.send(f"❌ Error: {str(e)[:100]}")

# ============== VOICE NOTIFIER API ==============

async def speak_in_channel(channel_id: int, text: str):
    """Speak text in a voice channel"""
    try:
        # Find the channel
        channel = bot.get_channel(int(channel_id))
        if not channel:
            logger.error(f"Channel {channel_id} not found")
            return False
        
        if not isinstance(channel, discord.VoiceChannel):
            logger.error(f"Channel {channel_id} is not a voice channel")
            return False
        
        # Generate TTS
        with tempfile.NamedTemporaryFile(suffix='.mp3', delete=False) as f:
            tts = gTTS(text=text, lang='en')
            tts.save(f.name)
            temp_file = f.name
        
        # Connect and play
        vc = await channel.connect()
        voice_clients[channel.guild.id] = vc
        
        source = discord.FFmpegPCMAudio(temp_file)
        source = discord.PCMVolumeTransformer(source)
        source.volume = DEFAULT_VOLUME
        
        def after_playing(error):
            if error:
                logger.error(f"TTS error: {error}")
            asyncio.run_coroutine_threadsafe(
                disconnect_voice(channel.guild.id), 
                bot.loop
            )
            # Clean up temp file
            try:
                os.unlink(temp_file)
            except:
                pass
        
        vc.play(source, after=after_playing)
        logger.info(f"TTS playing in channel {channel_id}: {text}")
        return True
        
    except Exception as e:
        logger.error(f"TTS error: {e}")
        return False

# Simple HTTP server for notifier (quick implementation)
from aiohttp import web
from aiohttp.web import TCPSite

async def notify_handler(request):
    """Handle notification requests from OpenClaw"""
    try:
        data = await request.json()
        message = data.get('message', '')
        channel_id = data.get('channel_id')
        
        if not message:
            return web.json_response({'error': 'No message provided'}, status=400)
        
        if channel_id:
            success = await speak_in_channel(int(channel_id), message)
        else:
            # Try to find an active voice channel
            success = False
            for vc in voice_clients.values():
                if vc.channel:
                    success = await speak_in_channel(vc.channel.id, message)
                    break
        
        if success:
            return web.json_response({'status': 'playing'})
        else:
            return web.json_response({'error': 'No voice channel available'}, status=400)
            
    except Exception as e:
        logger.error(f"Notify error: {e}")
        return web.json_response({'error': str(e)}, status=500)

async def status_handler(request):
    """Health check endpoint"""
    return web.json_response({
        'status': 'ok',
        'bot_name': BOT_NAME,
        'active_voice_connections': len(voice_clients)
    })

# ============== EVENTS ==============

@bot.event
async def on_ready():
    """Bot ready"""
    logger.info(f"✅ Logged in as {bot.user} ({BOT_NAME})")
    await tree.sync()
    logger.info("Slash commands synced")
    
    # Start notifier server
    app = web.Application()
    app.router.add_post('/notify', notify_handler)
    app.router.add_get('/status', status_handler)
    
    runner = web.AppRunner(app)
    await runner.setup()
    
    site = TCPSite(runner, 'localhost', NOTIFIER_PORT)
    await site.start()
    
    logger.info(f"📢 Notifier API running on http://localhost:{NOTIFIER_PORT}")

# ============== MAIN ==============

if __name__ == '__main__':
    if not BOT_TOKEN:
        logger.error("DISCORD_BOT_TOKEN not set in .env")
        exit(1)
    
    bot.run(BOT_TOKEN)
