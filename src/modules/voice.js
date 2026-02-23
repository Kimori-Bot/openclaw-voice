/**
 * Voice Manager - Handles Discord voice connections with user-specific streams and VAD
 */
const {
    joinVoiceChannel,
    createAudioPlayer,
    VoiceConnectionStatus,
    AudioPlayerStatus,
    entersState
} = require('@discordjs/voice');

// VAD for voice activity detection
const VAD = require('webrtcvad');

class VoiceManager {
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
        this.connections = new Map(); // guildId -> VoiceState
        this.vadMode = parseInt(process.env.VAD_MODE) || 3; // 0-3, 3 is most aggressive
        this vad = new VAD(this.vadMode);
    }
    
    async join(guildId, channel, adapterCreator, onAudioReceived, textChannelId = null) {
        if (this.connections.has(guildId)) {
            const existing = this.connections.get(guildId);
            if (textChannelId && !existing.textChannelId) {
                existing.textChannelId = textChannelId;
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
        
        try {
            await entersState(connection, VoiceConnectionStatus.Ready, 10000);
        } catch (e) {
            this.logger.error('Voice connection not ready:', e.message);
        }
        
        const player = createAudioPlayer();
        connection.subscribe(player);
        
        const receiver = connection.receiver;
        this.logger.info('🎧 Voice receiver ready');
        
        // User-specific audio tracking
        const userStreams = new Map(); // userId -> { chunks, decoder, lastSpeech, isSpeaking }
        
        // Create Opus decoder for a specific user
        const createUserDecoder = (userId) => {
            return {
                decoder: new (require('opusscript'))(48000, 2),
                chunks: [],
                lastSpeech: Date.now(),
                isSpeaking: false,
                speechChunks: [],  // Only speech chunks (VAD detected)
                silenceCount: 0
            };
        };
        
        // Handle speaking events - track per user
        receiver.speaking.on('start', (userId) => {
            if (userId === connection.client?.user?.id) return;
            
            if (!userStreams.has(userId)) {
                userStreams.set(userId, createUserDecoder(userId));
            }
            
            const userState = userStreams.get(userId);
            userState.isSpeaking = true;
            userState.lastSpeech = Date.now();
            
            this.logger.info(`🔊 User ${userId} started speaking`);
        });
        
        receiver.speaking.on('end', (userId) => {
            if (userId === connection.client?.user?.id) return;
            
            const userState = userStreams.get(userId);
            if (userState) {
                userState.isSpeaking = false;
                this.logger.info(`🔇 User ${userId} stopped, chunks: ${userState.speechChunks.length}`);
                
                // Process accumulated speech
                if (userState.speechChunks.length > 0 && onAudioReceived) {
                    const combined = Buffer.concat(userState.speechChunks);
                    this.logger.info(`📤 Sending ${combined.length} bytes for user ${userId}`);
                    onAudioReceived(guildId, combined, userId, true); // isFinal = true
                }
                
                // Reset speech chunks but keep user state
                userState.speechChunks = [];
                userState.silenceCount = 0;
            }
        });
        
        // Subscribe to audio and apply VAD per user
        const setupUserAudio = (userId) => {
            if (userStreams.has(userId)) return;
            
            const userState = createUserDecoder(userId);
            userStreams.set(userId, userState);
            
            const stream = receiver.subscribe(userId, { mode: { type: 'opus' } });
            
            stream.on('data', (opusPacket) => {
                try {
                    const pcmBuffer = userState.decoder.decode(opusPacket);
                    if (!pcmBuffer || pcmBuffer.length < 320) return;
                    
                    userState.chunks.push(pcmBuffer);
                    
                    // Apply VAD - check if this chunk contains speech
                    // VAD expects 16-bit PCM, 16kHz mono
                    const vadChunk = this.convertForVAD(pcmBuffer);
                    const isSpeech = this.vad.isSpeech(vadChunk, 16);
                    
                    if (isSpeech) {
                        userState.speechChunks.push(pcmBuffer);
                        userState.lastSpeech = Date.now();
                        userState.silenceCount = 0;
                        
                        // Send interim result while speaking
                        if (userState.speechChunks.length >= 2 && onAudioReceived) {
                            const interim = Buffer.concat(userState.speechChunks);
                            onAudioReceived(guildId, interim, userId, false); // isFinal = false
                        }
                    } else {
                        userState.silenceCount++;
                        
                        // After X consecutive silent chunks, consider speech ended
                        if (userState.silenceCount > 10 && userState.speechChunks.length > 0 && onAudioReceived) {
                            const final = Buffer.concat(userState.speechChunks);
                            this.logger.info(`📤 Sending final (VAD silence) ${final.length} bytes for user ${userId}`);
                            onAudioReceived(guildId, final, userId, true);
                            userState.speechChunks = [];
                            userState.silenceCount = 0;
                        }
                    }
                } catch (e) {
                    this.logger.error(`Decode error for ${userId}: ${e.message}`);
                }
            });
            
            stream.on('error', (err) => {
                this.logger.error(`Audio stream error for ${userId}: ${err.message}`);
                userStreams.delete(userId);
            });
            
            stream.on('end', () => {
                userStreams.delete(userId);
            });
        };
        
        // Hook into speaking events to set up audio
        receiver.speaking.on('start', setupUserAudio);
        
        const state = {
            connection,
            player,
            receiver,
            channelId: channel.id,
            textChannelId: textChannelId,
            isListening: true,
            isRecording: false,
            recordingChunks: [],
            userStreams  // Track per-user streams
        };
        
        this.connections.set(guildId, state);
        
        connection.on(VoiceConnectionStatus.Destroyed, () => {
            this.cleanup(guildId);
        });
        
        this.logger.info(`🎤 Joined voice in ${guildId}`);
        return state;
    }
    
    // Convert 48kHz stereo to 16kHz mono for VAD
    convertForVAD(pcmBuffer) {
        const fs = require('fs');
        const { spawn } = require('child_process');
        const tempFile = `/tmp/vad-${Date.now()}.pcm`;
        
        // Quick downsample using ffmpeg
        return new Promise((resolve) => {
            const ff = spawn('ffmpeg', [
                '-f', 's16le', '-ar', '48000', '-ac', '2',
                '-i', 'pipe:0',
                '-ar', '16000', '-ac', '1',
                '-f', 's16le',
                '-y', tempFile
            ], { stdio: ['pipe', 'pipe', 'ignore'] });
            
            ff.stdin.write(pcmBuffer);
            ff.stdin.end();
            
            ff.on('close', () => {
                try {
                    const result = fs.readFileSync(tempFile);
                    fs.unlinkSync(tempFile);
                    resolve(result);
                } catch(e) {
                    resolve(Buffer.alloc(0));
                }
            });
        });
    }
    
    // Sync version for use in stream callbacks
    convertForVDASync(pcmBuffer) {
        // Simple downsampling: take every 3rd sample, convert stereo to mono
        // This is approximate but fast (no subprocess)
        const samples = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.length / 2);
        const mono16k = new Int16Array(Math.floor(samples.length / 3));
        
        for (let i = 0; i < mono16k.length; i++) {
            // Average left/right channels and downsample
            const idx = i * 3;
            mono16k[i] = Math.floor((samples[idx] + samples[idx + 1]) / 2);
        }
        
        return Buffer.from(mono16k.buffer);
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
        const state = this.connections.get(guildId);
        if (state?.userStreams) {
            for (const [userId, userState] of state.userStreams) {
                userState.chunks = [];
                userState.speechChunks = [];
            }
        }
        this.connections.delete(guildId);
    }
    
    setListening(guildId, isListening) {
        const state = this.connections.get(guildId);
        if (state) {
            state.isListening = isListening;
        }
    }
    
    // Get specific user's stream state
    getUserStream(guildId, userId) {
        const state = this.connections.get(guildId);
        return state?.userStreams?.get(userId);
    }
}

module.exports = { VoiceManager };
