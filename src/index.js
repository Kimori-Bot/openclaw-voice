/**
 * OpenClaw Voice - Organized Structure
 * Commands: /play (YouTube search), /search (OpenClaw AI search), /stream (direct URL), /listen (voice conversation)
 */
require('dotenv').config();

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
const { createReadStream, createWriteStream, unlink } = require('fs');
const { pipeline } = require('stream/promises');
const { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');

// Setup logging to file with timestamps + JSON
const LOG_FILE = '/tmp/openclaw-voice.log';
const originalLog = console.log;
const originalError = console.error;

function formatLog(level, ...args) {
    const timestamp = new Date().toISOString();
    const message = args.join(' ');
    const logEntry = JSON.stringify({ timestamp, level, message }) + '\n';

    // Console output (human readable)
    if (level === 'ERROR') {
        originalError(`[${timestamp}] ERROR:`, ...args);
    } else {
        originalLog(`[${timestamp}]`, ...args);
    }

    // File output (JSON)
    fs.appendFileSync(LOG_FILE, logEntry);

    return logEntry;
}

console.log = (...args) => formatLog('INFO', ...args);
console.error = (...args) => formatLog('ERROR', ...args);

console.log('🤖 OpenClaw Voice Starting...');
console.log('📦', generateDependencyReport());

// === CONFIG ===
const config = {
    TOKEN: process.env.DISCORD_TOKEN || process.env.DISCORD_BOT_TOKEN,
    OPENCLAW_API: process.env.OPENCLAW_API || 'http://localhost:8080',
    WHISPER_SERVER: process.env.WHISPER_SERVER || 'http://127.0.0.1:5001',
    SILENCE_THRESHOLD_MS: 1500,
    WAKE_WORD: process.env.WAKE_WORD || 'kimori',
    RESPONSE_MODE: process.env.RESPONSE_MODE || 'ai', // 'ai' = respond with AI, 'echo' = just repeat
    ALWAYS_RESPOND: process.env.ALWAYS_RESPOND === 'true',
};

// === UTILITIES ===

/**
 * Convert raw Opus packets to WAV using FFmpeg
 */
async function convertOpusToWav(opusBuffer) {
    return new Promise((resolve, reject) => {
        const inputFile = `/tmp/opus_input_${Date.now()}.ogg`;
        const outputFile = `/tmp/opus_output_${Date.now()}.wav`;

        console.log(`📝 Converting ${opusBuffer.length} bytes of Opus to WAV`);

        // Write raw opus packets to temp file as Ogg container
        fs.writeFileSync(inputFile, opusBuffer);

        // Use ogg format for Opus in Ogg container
        const ffmpeg = spawn('ffmpeg', [
            '-hide_banner',
            '-f', 'ogg',           // input format (Ogg container)
            '-i', inputFile,       // input file
            '-acodec', 'pcm_s16le', // output codec
            '-ar', '48000',        // sample rate
            '-ac', '2',            // channels
            '-y',                  // overwrite output
            outputFile              // output file
        ]);

        let stderr = '';
        ffmpeg.stderr.on('data', (d) => { stderr += d.toString(); });

        ffmpeg.on('close', (code) => {
            try { fs.unlinkSync(inputFile); } catch(e) {}

            console.log(`📝 ffmpeg exited with code ${code}`);
            if (code !== 0) {
                console.log(`📝 ffmpeg stderr: ${stderr.slice(-500)}`);
                reject(new Error(`ffmpeg exited with code ${code}`));
                return;
            }

            try {
                const wavData = fs.readFileSync(outputFile);
                fs.unlinkSync(outputFile);
                console.log(`📝 Generated WAV: ${wavData.length} bytes`);
                resolve(wavData);
            } catch(e) {
                reject(e);
            }
        });

        ffmpeg.on('error', (err) => {
            console.error(`📝 ffmpeg error: ${err.message}`);
            try { fs.unlinkSync(inputFile); } catch(e) {}
            reject(err);
        });
    });
}

// === STATE ===
const voiceConnections = new Map(); // guildId -> VoiceState
const queues = new Map(); // guildId -> Song[]
const transcriptionState = new Map(); // guildId -> { buffer, lastUpdate, processing, silenceTimer }

// === SLASH COMMANDS ===
const commands = [
    new SlashCommandBuilder().setName('join').setDescription('Join your voice channel'),
    new SlashCommandBuilder().setName('voice').setDescription('Join voice and start AI conversation'),
    new SlashCommandBuilder().setName('leave').setDescription('Leave voice channel'),
    new SlashCommandBuilder()
        .setName('play')
        .setDescription('Play a song from YouTube (searches YouTube)')
        .addStringOption(o => o.setName('query').setDescription('Song name or YouTube URL').setRequired(true)),
    new SlashCommandBuilder()
        .setName('search')
        .setDescription('AI-powered song search via OpenClaw')
        .addStringOption(o => o.setName('query').setDescription('What kind of song?').setRequired(true)),
    new SlashCommandBuilder()
        .setName('stream')
        .setDescription('Stream audio from a direct URL (mp3, etc)')
        .addStringOption(o => o.setName('url').setDescription('Direct audio URL').setRequired(true)),
    new SlashCommandBuilder()
        .setName('queue')
        .setDescription('Show the current queue'),
    new SlashCommandBuilder()
        .setName('skip')
        .setDescription('Skip the current song'),
    new SlashCommandBuilder()
        .setName('stop')
        .setDescription('Stop playing'),
    new SlashCommandBuilder()
        .setName('clear')
        .setDescription('Clear the queue'),
    new SlashCommandBuilder()
        .setName('listen')
        .setDescription('Start voice conversation mode'),
    new SlashCommandBuilder()
        .setName('stop_listen')
        .setDescription('Stop listening'),
    new SlashCommandBuilder()
        .setName('record')
        .setDescription('Start recording voice audio'),
    new SlashCommandBuilder()
        .setName('stop_record')
        .setDescription('Stop recording and post audio'),
    new SlashCommandBuilder()
        .setName('say')
        .setDescription('Speak text in voice')
        .addStringOption(o => o.setName('text').setDescription('Text to speak').setRequired(true)),
    new SlashCommandBuilder()
        .setName('help')
        .setDescription('Show help'),
];

// === DISCORD CLIENT ===
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

// ===============================
// QUEUE MANAGEMENT
// ===============================
function getQueue(guildId) {
    if (!queues.has(guildId)) queues.set(guildId, []);
    return queues.get(guildId);
}

function addToQueue(guildId, url, title, requestedBy) {
    const q = getQueue(guildId);
    q.push({ url, title, requestedBy });
    return q.length;
}

function getNextFromQueue(guildId) {
    const q = getQueue(guildId);
    return q.shift();
}

function clearQueue(guildId) {
    queues.set(guildId, []);
}

// ===============================
// MUSIC PLAYBACK
// ===============================
async function searchYouTube(query) {
    return new Promise((resolve) => {
        const proc = spawn('yt-dlp', ['--flat-playlist', '--print', '%(id)s', `ytsearch1:${query}`]);
        let output = '';
        proc.stdout.on('data', (d) => { output += d.toString(); });
        proc.stderr.on('data', (d) => { console.log('yt-dlp stderr:', d.toString()); });
        proc.on('close', (code) => {
            const videoId = output.trim();
            if (videoId) {
                resolve(`https://www.youtube.com/watch?v=${videoId}`);
            } else {
                resolve(null);
            }
        });
        proc.on('error', (err) => {
            console.error('yt-dlp error:', err);
            resolve(null);
        });
    });
}

// Get audio stream URL using yt-dlp
async function getAudioStream(url) {
    // Check if it's NOT YouTube - if so, return URL directly (it's already a stream URL)
    const isYouTube = url.includes('youtube.com') || url.includes('youtu.be');
    if (!isYouTube) {
        console.log(`🌊 Direct stream URL (not YouTube): ${url}`);
        return url;
    }

    // It's YouTube - use yt-dlp to get the stream URL
    return new Promise((resolve, reject) => {
        const proc = spawn('yt-dlp', [
            '-f', 'bestaudio/best',
            '-g',  // Get direct URL
            '--no-playlist',
            url
        ]);
        let output = '';
        let errorOutput = '';

        proc.stdout.on('data', (d) => { output += d.toString(); });
        proc.stderr.on('data', (d) => { errorOutput += d.toString(); });

        proc.on('close', (code) => {
            const streamUrl = output.trim();
            if (streamUrl && !streamUrl.includes('ERROR')) {
                resolve(streamUrl);
            } else {
                reject(new Error(errorOutput || 'Failed to get stream URL'));
            }
        });
        proc.on('error', (err) => {
            reject(err);
        });
    });
}

async function playNext(guildId, message = null) {
    const vc = voiceConnections.get(guildId);
    if (!vc?.player) return;

    const next = getNextFromQueue(guildId);
    if (!next) return;

    try {
        // Get stream URL using yt-dlp
        const streamUrl = await getAudioStream(next.url);
        const resource = createAudioResource(streamUrl, {
            inputType: 'unknown',
            ffmpegArguments: ['-af', 'volume=0.5']
        });

        vc.player.on(AudioPlayerStatus.Idle, () => playNext(guildId, message));
        vc.player.play(resource);

        if (message) message.reply(`▶️ Now playing: ${next.title}`);
    } catch (e) {
        console.error('Queue play error:', e.message);
        playNext(guildId, message);
    }
}

async function playMusic(url, guildId, message = null, isSearch = false) {
    const vc = voiceConnections.get(guildId);
    console.log(`🎵 playMusic called: guildId=${guildId}, url=${url}, vc=${vc ? 'exists' : 'null'}`);

    if (!vc?.player) {
        console.log('❌ No voice connection or player');
        message?.reply('❌ Not in voice channel!');
        return;
    }

    try {
        let playUrl = url;
        let title = url;

        // If not a direct URL, search YouTube
        if (!url.match(/^https?:\/\//)) {
            // Skip "Searching..." message since ensureVoice already sent "Joined!"
            playUrl = await searchYouTube(url);
            console.log(`🔍 YouTube search result: ${playUrl}`);
            if (!playUrl) {
                console.log('❌ Could not find video');
                return;
            }
            title = url;
        } else if (isSearch) {
            // AI search result
            title = url;
        }

        // Check if something is playing
        if (vc.player.state.status === AudioPlayerStatus.Playing) {
            const pos = addToQueue(guildId, playUrl, title, message?.author?.username);
            // Don't reply if already replied (ensureVoice handles it)
            return;
        }

        // Play immediately
        console.log(`🎵 Starting playback: ${playUrl}`);

        // Get stream URL using yt-dlp
        console.log(`🎵 Starting playback: ${playUrl}`);
        let streamUrl;
        try {
            streamUrl = await getAudioStream(playUrl);
            console.log(`🔗 Stream URL: ${streamUrl}`);
        } catch (streamErr) {
            console.error('Stream URL error:', streamErr.message);
            if (message?.deferred) {
                await message.editReply(`❌ Error: ${streamErr.message}`);
            } else {
                await message?.reply(`❌ Error: ${streamErr.message}`);
            }
            return;
        }

        // Create audio resource from stream URL using FFmpeg
        const resource = createAudioResource(streamUrl, {
            inputType: 'unknown',
            ffmpegArguments: ['-af', 'volume=0.5']
        });

        vc.player.on(AudioPlayerStatus.Idle, () => playNext(guildId, message));
        vc.player.play(resource);

        // Don't reply if already replied (ensureVoice handles responses)
    } catch (e) {
        console.error('Play error:', e.message);
        // Don't reply if already replied
    }
}

// ===============================
// TTS
// ===============================
async function textToSpeech(text) {
    return new Promise((resolve, reject) => {
        const tempFile = `/tmp/openclaw-tts-${Date.now()}.mp3`;
        const gtts = spawn('gtts-cli', [text, '--output', tempFile]);

        gtts.on('close', () => {
            try {
                const data = readFileSync(tempFile);
                unlinkSync(tempFile);
                resolve(data);
            } catch (e) { reject(e); }
        });
        gtts.on('error', reject);
    });
}

async function speak(text, guildId) {
    const vc = voiceConnections.get(guildId);
    if (!vc) return;

    try {
        const audioBuffer = await textToSpeech(text);
        const tempFile = `/tmp/openclaw-tts-${guildId}-${Date.now()}.mp3`;
        writeFileSync(tempFile, audioBuffer);

        const resource = createAudioResource(tempFile);
        vc.player.play(resource);

        vc.player.on(AudioPlayerStatus.Idle, () => {
            try { unlinkSync(tempFile); } catch (e) {}
        });
    } catch (e) {
        console.error('TTS error:', e.message);
    }
}

// ===============================
// OPENCLAW AI
// ===============================
// Store conversation history per guild for context
const conversationHistory = new Map(); // guildId -> [{role, content}]

async function sendToOpenClaw(text, guildId, voiceChannelId) {
    // Get or initialize conversation history for this guild
    if (!conversationHistory.has(guildId)) {
        // Build initial context
        const guild = client.guilds.cache.get(guildId);
        const voiceState = guild?.voiceStates?.cache;
        const members = voiceState?.filter(vc => vc.channelId)?.map(vc => vc.member?.displayName).filter(Boolean) || [];
        
        const systemPrompt = `You are Kimori, a helpful AI assistant talking to users in a Discord voice channel.

## IMPORTANT: How Voice Works
- You CANNOT directly control the music player - you are SEPARATE from it
- When users want to play music, they must use Discord slash commands like /play
- Guide users: "Say /play [song name] in chat to play music"
- Do NOT say you can play music - tell them to use the /play command
- You can hear what users say in voice chat and respond via TTS

## Your Capabilities (via slash commands)
- /play [song] - Play YouTube music (users must type this in Discord chat)
- /search [query] - Search for streams/radio
- /skip - Skip current song
- /queue - See what's playing

## Response Guidelines
- NO EMOJIS - They don't translate well to speech
- Keep responses short (voice conversation)
- Be conversational and natural
- If asked to play music, tell them: "Type /play [song name] in chat to play music"
- If asked what you can do, explain the slash commands
- Do NOT pretend you can control the bot - you're an AI assistant in the voice chat`;

        conversationHistory.set(guildId, [
            { role: 'system', content: systemPrompt }
        ]);
    }
    
    const history = conversationHistory.get(guildId);
    
    // Add user message
    history.push({ role: 'user', content: text });
    
    // Keep history manageable (last 10 messages)
    if (history.length > 12) {
        history.splice(1, history.length - 12); // Keep system + last 10
    }
    
    // Use openclaw agent CLI for session-based responses
    // Use voice channel ID for unique session context per voice channel
    const sessionLabel = `discord:voice-${guildId}-${voiceChannelId}`;
    return new Promise((resolve) => {
        const proc = spawn('openclaw', [
            'agent',
            '--session', sessionLabel,
            '--message', text,
            '--timeout', '30'
        ], {
            stdio: ['ignore', 'pipe', 'pipe']
        });
        
        let output = '';
        let error = '';
        
        proc.stdout.on('data', (data) => {
            output += data.toString();
        });
        
        proc.stderr.on('data', (data) => {
            error += data.toString();
        });
        
        proc.on('close', (code) => {
            if (code === 0 && output.trim()) {
                // Add AI response to history
                history.push({ role: 'assistant', content: output.trim() });
                resolve(output.trim());
            } else {
                console.log('OpenClaw agent error:', error || 'No output');
                resolve('Error: Could not get response');
            }
        });
        
        proc.on('error', (e) => {
            console.log('OpenClaw spawn error:', e.message);
            resolve('Error: ' + e.message);
        });
        
        // Timeout after 30 seconds
        setTimeout(() => {
            proc.kill();
            resolve('Error: Timeout');
        }, 30000);
    });
}

// ===============================
// VOICE TRANSCRIPTION
// ===============================
// Voice Transcription using Python whisper CLI
// Voice Transcription using Python whisper CLI

async function transcribeAudio(audioPath) {
    console.log(`🎤 Transcribing: ${audioPath}`);

    // Use whisper server if available
    try {
        const response = await fetch(config.WHISPER_SERVER + '/transcribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: audioPath })
        });

        if (response.ok) {
            const result = await response.json();
            console.log(`📝 Transcription: ${result.text}`);
            return { text: result.text };
        }
    } catch(e) {
        console.log(`⚠️ Whisper server error: ${e.message}`);
    }

    // Fallback: try CLI if available
    const whisperExists = (() => {
        try {
            return require('child_process').execSync('which whisper', { stdio: 'ignore' });
        } catch(e) { return null; }
    })();

    if (!whisperExists) {
        console.log('⚠️ Whisper not available - skipping transcription');
        return { text: '' };
    }

    // CLI fallback - spawn and run whisper
    return new Promise((resolve) => {
        const proc = spawn('whisper', ['--model', 'base', '--language', 'English', '--output_format', 'json', audioPath]);
        let output = '';
        let errorOutput = '';

        proc.stdout.on('data', (d) => { output += d.toString(); });
        proc.stderr.on('data', (d) => { errorOutput += d.toString(); });

        proc.on('close', (code) => {
            if (code === 0) {
                const jsonPath = audioPath.replace('.wav', '.json');
                try {
                    const result = JSON.parse(readFileSync(jsonPath, 'utf-8'));
                    const text = result?.text || '';
                    console.log(`📝 Transcription: ${text}`);
                    try { unlinkSync(jsonPath); } catch(e) {}
                    resolve({ text });
                } catch (e) {
                    resolve({ text: output.trim() || 'No transcription' });
                }
            } else {
                console.error(`❌ Whisper error: ${errorOutput}`);
                resolve({ text: '', error: errorOutput });
            }
        });
        proc.on('error', (e) => {
            console.error(`❌ Whisper error: ${e.message}`);
            resolve({ text: '', error: e.message });
        });
    });
}

async function processVoiceAudio(guildId, audioBuffer, userId) {
    const vc = voiceConnections.get(guildId);
    if (!vc?.isListening) return;

    if (!audioBuffer || audioBuffer.length < 2000) return;

    // Save and convert to WAV
    const tempDir = '/tmp/openclaw-audio';
    if (!existsSync(tempDir)) mkdirSync(tempDir, { recursive: true });

    const pcmFile = `${tempDir}/speech-${guildId}-${Date.now()}.pcm`;
    const wavFile = `${tempDir}/speech-${guildId}-${Date.now()}.wav`;
    console.log(`💾 Saving ${audioBuffer.length} bytes to ${pcmFile}`);
    writeFileSync(pcmFile, audioBuffer);

    // Convert to WAV
    console.log(`🔄 Converting to WAV...`);
    await new Promise((resolve) => {
        const ff = spawn('ffmpeg', ['-f', 's16le', '-ar', '48000', '-ac', '2', '-i', pcmFile, '-af', 'volume=4', '-y', wavFile]);
        ff.on('close', () => {
            console.log(`✅ Converted to WAV: ${wavFile}`);
            try { unlinkSync(pcmFile); } catch(e) {} resolve();
        });
        ff.on('error', (e) => { console.error(`❌ ffmpeg error: ${e.message}`); resolve(); });
    });

    // Transcribe
    const result = await transcribeAudio(wavFile);
    try { unlinkSync(wavFile); } catch(e) {}

    if (!result.text) return;

    const text = result.text.trim();
    console.log(`📝 Transcribed: "${text}"`);

    // Update buffer
    if (!transcriptionState.has(guildId)) {
        transcriptionState.set(guildId, { buffer: '', lastUpdate: Date.now(), processing: false, silenceTimer: null });
    }
    const state = transcriptionState.get(guildId);

    state.buffer = state.buffer ? state.buffer + ' ' + text : text;
    state.lastUpdate = Date.now();

    // Clear old timer, set new one
    if (state.silenceTimer) clearTimeout(state.silenceTimer);

    state.silenceTimer = setTimeout(async () => {
        if (state.buffer && !state.processing) {
            // Check if text is meaningful (not blank/empty)
            const finalText = state.buffer.trim();
            if (!finalText || finalText.length < 2) {
                console.log('📝 Empty transcription, skipping');
                state.processing = false;
                return;
            }

            // Check wake word (unless ALWAYS_RESPOND is enabled)
            // Strip punctuation and normalize for better detection
            const normalizedText = finalText.toLowerCase().replace(/^[,\.\s]+|[,\.\s]+$/g, '').replace(/\s+/g, ' ');
            const wakeLower = config.WAKE_WORD.toLowerCase();
            const hasWakeWord = normalizedText.includes(wakeLower) ||
                               normalizedText.includes('echo') ||
                               normalizedText.includes('hey kimori') ||
                               normalizedText.includes('okay kimori') ||
                               normalizedText.includes('hey openclaw') ||
                               normalizedText.includes('ok kimori') ||
                               normalizedText.startsWith(wakeLower) ||
                               normalizedText.startsWith('echo');

            if (!config.ALWAYS_RESPOND && !hasWakeWord) {
                console.log(`📝 No wake word detected ("${finalText}"), skipping AI response`);
                state.processing = false;
                return;
            }

            // Remove wake word from text for cleaner prompt
            const cleanText = normalizedText
                .replace(new RegExp(config.WAKE_WORD.toLowerCase(), 'g'), '')
                .replace(/hey\s*kimori/gi, '')
                .replace(/okay\s*kimori/gi, '')
                .replace(/hey\s*openclaw/gi, '')
                .replace(/^\s*[,.]+\s*/, '')
                .trim() || finalText;

            state.processing = true;
            state.buffer = '';

            console.log(`📝 Sending to AI: "${cleanText}"`);

            // Get voice channel ID for session isolation
            const voiceChannelId = voiceConnections.get(guildId)?.channelId || 'general';
            const response = await sendToOpenClaw(cleanText, guildId, voiceChannelId);
            console.log(`🤖 AI response: ${response.substring(0, 100)}...`);

            // Speak the response
            if (response && !response.startsWith('Error:') && response.length < 500) {
                await speak(response, guildId);
            }

            state.processing = false;
        }
    }, config.SILENCE_THRESHOLD_MS);
}

// ===============================
// VOICE RECEIVER
// ===============================
let Opus;
try {
    const opusModule = require('@discordjs/opus');
    Opus = opusModule.OpusEncoder;
    console.log('📦 Using @discordjs/opus for decoding');
} catch (e) {
    console.log('📦 @discordjs/opus not available, using opusscript fallback');
    try {
        Opus = require('opusscript');
    } catch (e2) {
        console.error('❌ No Opus library available!', e2.message);
    }
}

// Recording state
const recordingState = new Map(); // guildId -> { recording: bool, chunks: [], userId: null }

function setupVoiceReceiver(guildId, connection) {
    const receiver = connection.receiver;
    const userBuffers = new Map(); // userId -> { chunks: [], timeout: null }

    console.log(`🎤 Setting up voice receiver for guild ${guildId}`);

    // Initialize recording state for this guild
    if (!recordingState.has(guildId)) {
        recordingState.set(guildId, { recording: false, chunks: [], userId: null });
    }

    receiver.speaking.on('start', (userId) => {
        console.log(`🔊 Speaking started: user ${userId}`);
        if (!userBuffers.has(userId)) {
            userBuffers.set(userId, { chunks: [], timeout: null });
        }
        const ub = userBuffers.get(userId);
        if (ub.timeout) clearTimeout(ub.timeout);

        // Get recording state
        const recState = recordingState.get(guildId);
        console.log(`📡 Recording state: ${recState?.recording}, chunks so far: ${recState?.chunks?.length || 0}`);

        if (!receiver.subscriptions.has(userId)) {
            console.log(`📡 Subscribing to audio for user ${userId}`);

            // Create decoder using OpusEncoder (can decode Opus packets)
            if (!Opus) {
                console.error('❌ Opus not available, cannot decode audio');
                return;
            }
            const decoder = new Opus(48000, 2);

            const stream = receiver.subscribe(userId, {
                mode: { type: 'opus' }
            });

            if (stream) {
                // For raw opus packets, we don't need to decode - just collect them
                // The receiver.subscribe with opus mode gives us opus packets directly
                console.log(`📡 Subscribed to stream for user ${userId}, recording=${recState?.recording}`);

                stream.on('data', (opusPacket) => {
                    console.log(`📡 Received ${opusPacket.length} byte packet`);

                    // Decode Opus to PCM
                    let pcmBuffer;
                    try {
                        pcmBuffer = decoder.decode(opusPacket);
                    } catch(e) {
                        console.error(`❌ Decode error: ${e.message}`);
                        return;
                    }

                    if (userBuffers.has(userId)) {
                        userBuffers.get(userId).chunks.push(pcmBuffer);
                    }
                    // Also add to recording if active
                    const recState = recordingState.get(guildId);
                    if (recState && recState.recording) {
                        recState.chunks.push(pcmBuffer);
                        console.log(`📡 Recording chunk: total ${recState.chunks.length}`);
                    }
                });
                stream.on('end', () => console.log(`📡 Stream ended for user ${userId}`));
                stream.on('error', (e) => console.error(`📡 Stream error: ${e.message}`));
            }
        }
    });

    receiver.speaking.on('end', (userId) => {
        console.log(`🔇 Speaking ended: user ${userId}`);
        const ub = userBuffers.get(userId);
        if (!ub) return;

        ub.timeout = setTimeout(() => {
            if (ub.chunks.length > 0) {
                console.log(`📝 Processing ${ub.chunks.length} audio chunks for user ${userId}`);
                processVoiceAudio(guildId, Buffer.concat(ub.chunks), userId);
                ub.chunks = [];
            }
        }, config.SILENCE_THRESHOLD_MS);
    });
}

// ===============================
// MESSAGE HANDLER (AUTO-JOIN)
// ===============================
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!message.guild) return;

    const member = message.member;
    const voiceChannel = member?.voice?.channel;
    const guildId = message.guild.id;

    // Auto-join if user is in voice
    if (voiceChannel && !voiceConnections.has(guildId)) {
        try {
            const connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: guildId,
                adapterCreator: message.guild.voiceAdapterCreator,
                selfDeaf: false, selfMute: false
            });

            const player = createAudioPlayer();
            connection.subscribe(player);
            setupVoiceReceiver(guildId, connection);

            voiceConnections.set(guildId, { connection, player, channelId: voiceChannel.id, isListening: true });

            connection.on(VoiceConnectionStatus.Destroyed, () => {
                voiceConnections.delete(guildId);
                queues.delete(guildId);
                transcriptionState.delete(guildId);
            });

            await message.reply('🎤 Joined your voice channel!');
        } catch (e) {
            console.error('Join error:', e);
        }
    }

    // Process commands
    const content = message.content.toLowerCase().trim();
    const vc = voiceConnections.get(guildId);

    if (content === 'listen') {
        if (vc) { vc.isListening = true; await message.reply('👂 Listening started!'); }
    } else if (content === 'stop listening') {
        if (vc) { vc.isListening = false; await message.reply('🛑 Stopped listening.'); }
    } else if (content.startsWith('play ')) {
        const query = message.content.slice(5);
        await playMusic(query, guildId, message);
    } else if (content.startsWith('search ')) {
        const query = message.content.slice(7);
        await playMusic(query, guildId, message, true);
    } else if (content.startsWith('say ')) {
        const text = message.content.slice(4);
        await speak(text, guildId);
        await message.reply(`🗣️ Said: ${text}`);
    } else if (content.startsWith('stream ')) {
        const url = message.content.slice(7);
        await playMusic(url, guildId, message);
    }
});

// ===============================
// SLASH COMMANDS
// ===============================
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isCommand()) return;

    const { commandName, member, guild } = interaction;
    const guildId = interaction.guildId;
    const vc = voiceConnections.get(guildId);

    // Auto-join helper
    const ensureVoice = async () => {
        try {
            if (vc) {
                // Already in voice - defer then reply
                await interaction.deferReply();
                await interaction.editReply('🎤 Ready in voice!');
                return vc;
            }

            // Need to join - defer the reply first
            await interaction.deferReply();

            if (!member?.voice?.channel) {
                await interaction.editReply('❌ Join a voice channel first!');
                return null;
            }

            const connection = joinVoiceChannel({
                channelId: member.voice.channel.id,
                guildId: guildId,
                adapterCreator: guild.voiceAdapterCreator,
                selfDeaf: false, selfMute: false
            });

            const player = createAudioPlayer();
            connection.subscribe(player);
            setupVoiceReceiver(guildId, connection);

            const newVc = { connection, player, channelId: member.voice.channel.id, isListening: true };
            voiceConnections.set(guildId, newVc);

            connection.on(VoiceConnectionStatus.Destroyed, () => {
                voiceConnections.delete(guildId);
                queues.delete(guildId);
            });

            await interaction.editReply('🎤 Joined!');
            return newVc;
        } catch (e) {
            console.error('ensureVoice error:', e.message);
            try {
                await interaction.editReply(`❌ Error: ${e.message}`);
            } catch(e2) {}
            return null;
        }
    };

    switch (commandName) {
        case 'join':
            // ensureVoice handles the response
            await ensureVoice();
            break;

        case 'voice':
            // Join voice and start listening automatically
            const voiceVc = await ensureVoice();
            if (voiceVc) {
                voiceVc.isListening = true;
                // ensureVoice already replied, just update status
                console.log(`👂 Listening enabled for guild ${guildId}`);
            }
            break;

        case 'leave':
            if (vc) {
                vc.connection.destroy();
                voiceConnections.delete(guildId);
                queues.delete(guildId);
                await interaction.reply('👋 Left!');
            } else {
                await interaction.reply('❌ Not in voice!');
            }
            break;

        case 'play':
            const pvc = await ensureVoice();
            if (pvc) {
                const query = interaction.options.getString('query');
                await playMusic(query, guildId, interaction);
            }
            break;

        case 'search':
            const svc = await ensureVoice();
            if (svc) {
                const query = interaction.options.getString('query');
                console.log(`🔍 AI search for: ${query}`);
                const result = await sendToOpenClaw(`Find a live stream, radio station, or audio URL for "${query}". Search the entire web - it can be YouTube, Twitch, a radio station (like iHeartRadio, TuneIn), or any direct audio stream URL. Just give me a direct playable URL or "none" if you can't find one.`, guildId);
                console.log(`🔍 AI result: ${result}`);

                // If AI didn't find anything useful
                if (!result || result.includes('none') || result.length < 10) {
                    await interaction.editReply(`❌ Could not find a stream for "${query}"`);
                    return;
                }

                await playMusic(result, guildId, interaction, true);
            }
            break;

        case 'stream':
            const stvc = await ensureVoice();
            if (stvc) {
                const url = interaction.options.getString('url');
                await playMusic(url, guildId, interaction);
            }
            break;

        case 'queue':
            const q = getQueue(guildId);
            if (q.length === 0) {
                await interaction.reply('🎵 Queue is empty');
            } else {
                await interaction.reply('🎵 **Queue:**\n' + q.map((s, i) => `${i+1}. ${s.title}`).join('\n'));
            }
            break;

        case 'skip':
            if (vc?.player) {
                vc.player.stop();
                await interaction.reply('⏭️ Skipped!');
                // Manually trigger playNext since stop() may not trigger Idle
                setTimeout(() => playNext(guildId), 500);
            } else {
                await interaction.reply('❌ Nothing playing');
            }
            break;

        case 'stop':
            if (vc?.player) {
                vc.player.stop();
                clearQueue(guildId);
                await interaction.reply('⏹️ Stopped and cleared queue!');
            }
            break;

        case 'clear':
            clearQueue(guildId);
            await interaction.reply('🗑️ Queue cleared!');
            break;

        case 'listen':
            if (vc) { vc.isListening = true; await interaction.reply('👂 Listening started!'); }
            else await interaction.reply('❌ Join voice first!');
            break;

        case 'stop_listen':
            if (vc) { vc.isListening = false; await interaction.reply('🛑 Stopped listening.'); }
            break;

        case 'record':
            if (vc) {
                if (!recordingState.has(guildId)) {
                    recordingState.set(guildId, { recording: false, chunks: [], userId: null });
                }
                recordingState.get(guildId).recording = true;
                recordingState.get(guildId).chunks = [];
                await interaction.reply('🔴 Recording started! Use /stop_record to stop.');
            } else {
                await interaction.reply('❌ Join voice first!');
            }
            break;

        case 'stop_record':
            if (vc) {
                const recState = recordingState.get(guildId);
                console.log(`📹 Stop recording: ${recState?.chunks?.length || 0} chunks`);
                if (recState && recState.chunks.length > 0) {
                    await interaction.reply('⏹️ Processing recording...');

                    console.log(`📹 Converting ${recState.chunks.length} chunks (${Buffer.concat(recState.chunks).length} bytes)`);

                    // Convert opus packets to WAV
                    const wavBuffer = await convertOpusToWav(Buffer.concat(recState.chunks));

                    // Send to Discord
                    const attachment = { attachment: wavBuffer, name: 'recording.wav' };
                    await interaction.channel.send({ files: [attachment] });

                    recState.chunks = [];
                    recState.recording = false;
                } else {
                    await interaction.reply('❌ No audio recorded.');
                }
            } else {
                await interaction.reply('❌ Not in voice!');
            }
            break;

        case 'say':
            const text = interaction.options.getString('text');
            await speak(text, guildId);
            await interaction.reply(`🗣️ Said: ${text}`);
            break;

        case 'help':
            await interaction.reply({ embeds: [new EmbedBuilder()
                .setTitle('🤖 OpenClaw Voice Commands')
                .addFields(
                    { name: '/play [song]', value: 'Search & play from YouTube' },
                    { name: '/search [query]', value: 'AI-powered song search' },
                    { name: '/stream [url]', value: 'Play from direct URL' },
                    { name: '/queue', value: 'Show queue' },
                    { name: '/skip', value: 'Skip song' },
                    { name: '/stop', value: 'Stop playing' },
                    { name: '/clear', value: 'Clear queue' },
                    { name: '/listen', value: 'Start voice conversation' },
                    { name: '/say [text]', value: 'Speak text' }
                )
            ]});
            break;
    }
});

// ===============================
// STARTUP
// ===============================
client.once('ready', async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    await client.application.commands.set(commands);
    console.log('📢 Commands registered');
});

client.login(config.TOKEN);

// Express API
const app = express();
app.use(express.json());

app.get('/health', (req, res) => {
    res.json({ status: 'ok', guilds: client.guilds.cache.size, connections: Array.from(voiceConnections.keys()) });
});

app.post('/play', async (req, res) => {
    const { url, guild_id } = req.body;
    if (!url || !guild_id) return res.status(400).json({ error: 'url and guild_id required' });
    await playMusic(url, guild_id);
    res.json({ status: 'playing', url });
});

// Initialize
console.log('🎤 Voice bot ready');

app.listen(5000, () => console.log('📢 API running on 5000'));
