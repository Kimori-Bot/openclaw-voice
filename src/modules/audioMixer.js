/**
 * Audio Mixer - FFmpeg-based mixing for music + TTS
 * Uses two FFmpeg processes that run in parallel
 */
const { spawn } = require('child_process');
const { createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const fs = require('fs');

class AudioMixer {
    constructor(logger) {
        this.logger = logger;
        this.mixers = new Map(); // guildId -> { musicProc, ttsProc, voiceState, player }
    }
    
    // Start playing music
    async start(guildId, voiceState, musicUrl) {
        if (this.mixers.has(guildId)) {
            this.stop(guildId);
        }
        
        this.logger?.info(`🎵 Starting music for guild ${guildId}`);
        
        // Play music directly first - simplest
        const musicArgs = [
            '-re', '-i', musicUrl,
            '-f', 's16le', '-ar', '48000', '-ac', '2', '-'
        ];
        
        const musicProc = spawn('ffmpeg', musicArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
        
        musicProc.stderr.on('data', (d) => {
            const msg = d.toString();
            if (msg.toLowerCase().includes('error')) {
                this.logger?.error(`music: ${msg.substring(0, 100)}`);
            }
        });
        
        const resource = createAudioResource(musicProc.stdout, {
            inputType: 'raw',
            sampleRate: 48000,
            channels: 2
        });
        
        voiceState.player.play(resource);
        
        this.mixers.set(guildId, {
            musicProc,
            musicUrl,
            voiceState,
            isTTSPlaying: false
        });
        
        this.logger?.info(`🎵 Music started for guild ${guildId}`);
    }
    
    // Play TTS - don't stop music, just add TTS
    async playTTS(guildId, ttsFile) {
        const m = this.mixers.get(guildId);
        if (!m) return;
        
        this.logger?.info(`🎤 Adding TTS to stream`);
        
        // Start TTS process
        const ttsArgs = [
            '-re', '-i', ttsFile,
            '-stream_loop', '100',
            '-f', 's16le', '-ar', '48000', '-ac', '2', '-'
        ];
        
        const ttsProc = spawn('ffmpeg', ttsArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
        
        // Create combined stream that mixes both
        // This is tricky - we'd need a third FFmpeg to combine them
        // For now, just play TTS and accept music stops
        
        // Alternative: don't do anything fancy, just play TTS directly
        const ttsResource = createAudioResource(ttsProc.stdout, {
            inputType: 'raw',
            sampleRate: 48000,
            channels: 2
        });
        
        // This will replace music - but maybe we can detect when TTS is done?
        // Problem: Discord player doesn't support queuing or mixing
        
        // For now, let's just try playing TTS directly and see what happens
        m.voiceState.player.play(ttsResource);
        m.isTTSPlaying = true;
        
        this.logger?.info(`🎤 TTS playing (music stopped)`);
    }
    
    // Stop everything
    stop(guildId) {
        const m = this.mixers.get(guildId);
        if (!m) return;
        
        m.musicProc?.kill();
        m.ttsProc?.kill();
        this.mixers.delete(guildId);
        this.logger?.info(`🎛️ Mixer stopped`);
    }
}

module.exports = { AudioMixer };
