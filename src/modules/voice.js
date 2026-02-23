/**
 * Voice Manager - Handles Discord voice connections
 */
const {
    joinVoiceChannel,
    createAudioPlayer,
    VoiceConnectionStatus,
    AudioPlayerStatus,
    entersState
} = require('@discordjs/voice');

// Import Opus for decoding - use opusscript which is available
const Opus = require('opusscript');

class VoiceManager {
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
        this.connections = new Map(); // guildId -> VoiceState
    }
    
    async join(guildId, channel, adapterCreator, onAudioReceived, textChannelId = null) {
        if (this.connections.has(guildId)) {
            const existing = this.connections.get(guildId);
            // Update text channel if provided
            if (textChannelId && !existing.textChannelId) {
                existing.textChannelId = textChannelId;
                this.connections.set(guildId, existing);
            }
            return existing;
        }
        
        const connection = joinVoiceChannel({
            channelId: channel.id,
            guildId: guildId,
            adapterCreator,
            selfDeaf: false,
            selfMute: false
        });
        
        // Wait for connection to be ready before setting up receiver
        try {
            await entersState(connection, VoiceConnectionStatus.Ready, 10000);
            this.logger.debug('Voice connection ready');
        } catch (e) {
            this.logger.error('Voice connection not ready:', e.message);
        }
        
        const player = createAudioPlayer();
        connection.subscribe(player);
        
        // Use the built-in receiver from the connection
        const receiver = connection.receiver;
        
        this.logger.info('🎧 Voice receiver ready');
        
        // Use the working approach - decode Opus with @discordjs/opus
        const userAudioStreams = new Map();
        
        // Create Opus decoder
        const decoder = new Opus(48000, 2);
        
        // Subscribe to audio for a user and decode Opus -> PCM
        const createStreamForUser = (userId) => {
            if (userAudioStreams.has(userId)) return;
            
            // Subscribe in Opus mode
            const stream = receiver.subscribe(userId, {
                mode: { type: 'opus' }
            });
            
            userAudioStreams.set(userId, stream);
            
            stream.on('data', (opusPacket) => {
                // Decode Opus to PCM
                let pcmBuffer;
                try {
                    pcmBuffer = decoder.decode(opusPacket);
                    if (pcmBuffer) {
                        state.audioChunks.push(pcmBuffer);
                        
                        if (state.isRecording && state.recordingChunks) {
                            state.recordingChunks.push(pcmBuffer);
                        }
                    }
                } catch(e) {
                    this.logger.error(`Decode error: ${e.message}`);
                }
            });
            
            stream.on('end', () => {
                userAudioStreams.delete(userId);
            });
            
            stream.on('error', (err) => {
                this.logger.error(`Audio stream error for ${userId}: ${err.message}`);
                userAudioStreams.delete(userId);
            });
        };
        
        // When anyone starts speaking, subscribe to their stream
        receiver.speaking.on('start', (userId) => {
            if (userId === connection.client?.user?.id) return;
            this.logger.info(`🔊 Speaking start: user ${userId}`);
            createStreamForUser(userId);
        });
        
        // Process audio when speaking ends
        receiver.speaking.on('end', (userId) => {
            if (userId === connection.client?.user?.id) return;
            this.logger.info(`🔇 Speaking end: user ${userId}, chunks: ${state.audioChunks.length}`);
            
            setTimeout(async () => {
                if (state.audioChunks.length > 0) {
                    const combined = Buffer.concat(state.audioChunks);
                    state.audioChunks = [];
                    
                    this.logger.info(`📥 Processing ${combined.length} bytes`);
                    
                    if (combined.length > 48000 && onAudioReceived) {
                        await onAudioReceived(guildId, combined, userId);
                    }
                }
            }, 3000);
        });
        
        const state = {
            connection,
            player,
            receiver,
            channelId: channel.id,
            textChannelId: textChannelId,
            isListening: true,
            isRecording: false,
            recordingChunks: [],
            audioChunks: []
        };
        
        this.connections.set(guildId, state);
        
        // Check connection events
        connection.on('debug', (msg) => {
            this.logger.debug(`Connection debug: ${msg}`);
        });
        
        connection.on(VoiceConnectionStatus.Destroyed, () => {
            this.cleanup(guildId);
        });
        
        this.logger.info(`🎤 Joined voice in ${guildId}`);
        return state;
    }
    
    get(guildId) {
        return this.connections.get(guildId);
    }
    
    has(guildId) {
        return this.connections.has(guildId);
    }
    
    getConnectionCount() {
        return this.connections.size;
    }
    
    cleanup(guildId) {
        this.connections.delete(guildId);
    }
    
    setListening(guildId, isListening) {
        const state = this.connections.get(guildId);
        if (state) {
            state.isListening = isListening;
        }
    }
    
    setRecording(guildId, start) {
        const fs = require('fs');
        const path = require('path');
        const { spawn } = require('child_process');
        
        const recordingDir = '/tmp/openclaw-recordings';
        if (!fs.existsSync(recordingDir)) {
            fs.mkdirSync(recordingDir, { recursive: true });
        }
        
        const state = this.connections.get(guildId);
        if (!state) return null;
        
        if (start) {
            state.isRecording = true;
            state.recordingChunks = [];
            state.recordingStartTime = Date.now();
            state.audioChunks = [];
            this.logger.info(`🔴 Recording started in ${guildId}`);
            return true;
        } else {
            // Use recording chunks (which now have decoded PCM)
            const chunksToSave = state.recordingChunks.length > 0 ? state.recordingChunks : state.audioChunks;
            
            if (chunksToSave && chunksToSave.length > 0) {
                const combined = Buffer.concat(chunksToSave);
                const filePath = path.join(recordingDir, `recording-${guildId}-${state.recordingStartTime}.wav`);
                
                this.logger.info(`💾 Saving recording: ${combined.length} bytes (PCM)`);
                
                // Save as raw PCM first
                const rawPath = filePath.replace('.wav', '.pcm');
                fs.writeFileSync(rawPath, combined);
                
                // Convert to WAV
                spawn('ffmpeg', [
                    '-f', 's16le', '-ar', '48000', '-ac', '2',
                    '-i', rawPath,
                    '-ar', '16000', '-ac', '1',
                    '-y', filePath
                ], { stdio: ['ignore', 'pipe', 'pipe'] }).on('close', () => {
                    this.logger.info(`💾 Recording saved to ${filePath}`);
                    try { fs.unlinkSync(rawPath); } catch(e) {}
                });
                
                state.isRecording = false;
                state.recordingChunks = [];
                return filePath;
            }
            state.isRecording = false;
            return null;
        }
    }
}

module.exports = { VoiceManager };
