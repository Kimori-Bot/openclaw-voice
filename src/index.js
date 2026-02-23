/**
 * OpenClaw Voice - Modular Structure
 * Performance optimized with caching and modular design
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    entersState,
    VoiceConnectionStatus,
    AudioPlayerStatus,
    VoiceReceiver,
    generateDependencyReport
} = require('@discordjs/voice');
const { unlink } = require('fs');
const fs = require('fs');
const { spawn, exec } = require('child_process');
const express = require('express');

// ============================================
// MODULAR IMPORTS
// ============================================
const { setupLogging } = require('./modules/logger');
const { VoiceManager } = require('./modules/voice');
const { MusicManager } = require('./modules/music');
const { TranscriptionManager } = require('./modules/transcription');
const { registerCommands, handleInteraction } = require('./modules/commands');
const { createApiServer } = require('./modules/api');

// ============================================
// INITIALIZATION
// ============================================
const logger = setupLogging();
logger.info('🤖 OpenClaw Voice Starting...');
logger.info('📦', generateDependencyReport());

// Config
const config = {
    TOKEN: process.env.DISCORD_TOKEN || process.env.DISCORD_BOT_TOKEN,
    OPENCLAW_API: process.env.OPENCLAW_API || 'http://localhost:8080',
    WHISPER_SERVER: process.env.WHISPER_SERVER || 'http://127.0.0.1:5001',
    WHISPER_MODEL: process.env.WHISPER_MODEL || 'small',
    STT_ENGINE: process.env.STT_ENGINE || 'local',
    ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY || '',
    TTS_ENGINE: process.env.TTS_ENGINE || 'elevenlabs',
    ELEVENLABS_VOICE_ID: process.env.ELEVENLABS_VOICE_ID || 'rachel',
    ELEVENLABS_MODEL: process.env.ELEVENLABS_MODEL || 'eleven_monolingual_v1',
    WAKE_WORD: process.env.WAKE_WORD || 'echo',
    ALWAYS_RESPOND: process.env.ALWAYS_RESPOND === 'true',
    // Performance tuning
    CACHE_TTL_MS: parseInt(process.env.CACHE_TTL_MS) || 3600000, // 1 hour default
    MAX_QUEUE_SIZE: parseInt(process.env.MAX_QUEUE_SIZE) || 100,
};

// Initialize managers
// Discord client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

const voiceManager = new VoiceManager(config, logger);
const musicManager = new MusicManager(config, logger);
const transcriptionManager = new TranscriptionManager(config, logger, voiceManager, musicManager, client);

// ============================================
// STARTUP
// ============================================
client.once('ready', async () => {
    logger.info(`✅ Logged in as ${client.user.tag}`);
    await registerCommands(client);
    logger.info('📢 Commands registered');

    // Health check interval
    setInterval(() => {
        logger.debug(`Active connections: ${voiceManager.getConnectionCount()}`);
    }, 60000);
});

// Connect managers to client
client.on('voiceStateUpdate', (oldState, newState) => {
    // Handle voice state changes
    if (oldState.channelId && !newState.channelId && oldState.id === client.user.id) {
        const guildId = oldState.guild.id;
        logger.info(`👋 Bot left voice channel in ${guildId}`);
        voiceManager.cleanup(guildId);
        musicManager.clearQueue(guildId);
    }

    // Debug: log all voice state changes
    if (oldState.channelId !== newState.channelId) {
        logger.info(`🔊 Voice state: ${oldState.member?.user?.username} moved from ${oldState.channelId} to ${newState.channelId}`);
    }
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isCommand()) return;
    
    const guildId = interaction.guildId;
    const vc = voiceManager.get(guildId);

    try {
        await handleInteraction(interaction, {
            config,
            client,
            voiceManager,
            musicManager,
            transcriptionManager,
            logger
        });
    } catch (err) {
        logger.error('Interaction error:', err.message);
        // Try to respond with error if interaction still valid
        if (err.message?.includes('Unknown interaction')) {
            return; // Interaction timed out, ignore
        }
        try {
            if (interaction.deferred) {
                await interaction.editReply(`❌ Error: ${err.message}`);
            } else {
                await interaction.reply(`❌ Error: ${err.message}`);
            }
        } catch (e) {
            // Interaction fully timed out
        }
    }
});

// Auto-join on message
client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;

    const member = message.member;
    const voiceChannel = member?.voice?.channel;
    const guildId = message.guild.id;

    // Auto-join
    if (voiceChannel && !voiceManager.has(guildId)) {
        try {
            await voiceManager.join(guildId, voiceChannel, message.guild.voiceAdapterCreator,
                (guildId, audioBuffer, userId) => {
                    transcriptionManager.processVoiceAudio(guildId, audioBuffer, userId);
                });
            await message.reply('🎤 Joined your voice channel!');
        } catch (e) {
            logger.error('Auto-join error:', e);
        }
    }
});

// Handle bot messages (from AI) - execute music commands
client.on('messageCreate', async (message) => {
    // Only handle messages from the bot itself that start with / commands
    if (!message.author.bot || message.author.id !== client.user.id) return;
    if (!message.guild) return;
    
    const content = message.content.trim();
    const guildId = message.guild.id;
    const vc = voiceManager.get(guildId);
    
    if (content.startsWith('/play ')) {
        const query = content.substring(6).trim();
        if (query && vc) {
            logger.info(`🎵 AI triggered play: "${query}"`);
            await musicManager.play(guildId, query, vc, null);
            // Delete the bot's message to keep chat clean
            try { await message.delete(); } catch {}
        }
    } else if (content === '/skip' || content.startsWith('/skip ')) {
        if (vc) {
            logger.info(`⏭️ AI triggered skip`);
            musicManager.playNext(guildId, vc);
            try { await message.delete(); } catch {}
        }
    } else if (content === '/stop' || content.startsWith('/stop ')) {
        logger.info(`⏹️ AI triggered stop`);
        musicManager.clearQueue(guildId);
        try { await message.delete(); } catch {}
    } else if (content === '/queue' || content.startsWith('/queue ')) {
        const q = musicManager.getQueue(guildId);
        const reply = q.length ? 'Queue: ' + q.map((s, i) => `${i+1}. ${s.title}`).join(', ') : 'Queue is empty';
        await message.reply(reply);
        // Delete the command after a few seconds
        setTimeout(() => { try { message.delete(); } catch {} }, 5000);
    }
});

// ============================================
// START
// ============================================
logger.info('🎤 Voice bot ready');

// Start API server
const app = express();
app.use(express.json());
createApiServer(app, { client, voiceManager, musicManager, transcriptionManager, logger });
app.listen(5000, () => logger.info('📢 API running on port 5000'));

client.login(config.TOKEN);
