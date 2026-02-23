/**
 * Audio Pipeline - Single FFmpeg process for music + TTS mixing
 * Creates a persistent FFmpeg process that can accept TTS audio while music plays
 */
const { spawn } = require('child_process');
const { createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const fs = require('fs');
const path = require('path');

class AudioPipeline {
    constructor(logger) {
        this.logger = logger;
        this.pipelines = new Map(); // guildId -> { ffmpeg, musicProc, ttsProc, voiceState }
    }
    
    // Start pipeline with music
    async start(guildId, voiceState, musicUrl) {
        if (this.pipelines.has(guildId)) {
            this.stop(guildId);
        }
        
        this.logger?.info(`🎛️ Starting audio pipeline for guild ${guildId}`);
        
        // Create named pipes for music and TTS inputs
        const pipeDir = `/tmp/openclaw-pipeline-${guildId}`;
        const musicPipe = `${pipeDir}-music`;
        const ttsPipe = `${pipeDir}-tts`;
        
        try {
            fs.mkdirSync(pipeDir, { recursive: true });
            if (fs.existsSync(musicPipe)) fs.unlinkSync(musicPipe);
            if (fs.existsSync(ttsPipe)) fs.unlinkSync(ttsPipe);
            fs.mkfifoSync(musicPipe, { mode: 0o666 });
            fs.mkfifoSync(ttsPipe, { mode: 0o666 });
        } catch (e) {
            this.logger?.error(`Failed to create pipes: ${e.message}`);
            // Fall back to simpler approach
            return this.startSimple(guildId, voiceState, musicUrl);
        }
        
        // Start music stream to pipe
        const musicProc = spawn('ffmpeg', [
            '-re', '-i', musicUrl,
            '-f', 's16le', '-ar', '48000', '-ac', '2',
            musicPipe
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        
        // Start with silence on TTS pipe (will be replaced with actual TTS)
        const silenceProc = spawn('ffmpeg', [
            '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
            '-f', 's16le', '-ar', '48000', '-ac', '2',
            ttsPipe
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        
        // Main FFmpeg: mix music (40%) + TTS (200%)
        const ffmpegArgs = [
            '-i', musicPipe,
            '-i', ttsPipe,
            '-filter_complex', 
            '[0:a]volume=0.4[music];[1:a]volume=2.0[tts];[music][tts]amix=inputs=2:duration=longest:dropout_transition=0[aout]',
            '-map', '[aout]',
            '-f', 's16le', '-ar', '48000', '-ac', '2',
            '-'
        ];
        
        const ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
        
        ffmpeg.stderr.on('data', (d) => {
            const msg = d.toString();
            if (msg.toLowerCase().includes('error') && !msg.includes('404')) {
                this.logger?.error(`pipeline: ${msg.substring(0, 150)}`);
            }
        });
        
        ffmpeg.on('exit', (code) => {
            this.logger?.info(`pipeline ffmpeg exited: ${code}`);
        });
        
        // Create audio resource
        const resource = createAudioResource(ffmpeg.stdout, {
            inputType: 'raw',
            sampleRate: 48000,
            channels: 2
        });
        
        voiceState.player.play(resource);
        
        this.pipelines.set(guildId, {
            ffmpeg,
            musicProc,
            silenceProc,
            musicUrl,
            pipeDir,
            musicPipe,
            ttsPipe,
            voiceState,
            isTTSPlaying: false
        });
        
        this.logger?.info(`🎛️ Audio pipeline started`);
    }
    
    // Fallback: simple approach without pipes
    async startSimple(guildId, voiceState, musicUrl) {
        this.logger?.info(`🎵 Using simple playback`);
        
        const musicProc = spawn('ffmpeg', [
            '-re', '-i', musicUrl,
            '-af', 'volume=0.4',
            '-f', 's16le', '-ar', '48000', '-ac', '2', '-'
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        
        const resource = createAudioResource(musicProc.stdout, {
            inputType: 'raw',
            sampleRate: 48000,
            channels: 2
        });
        
        voiceState.player.play(resource);
        
        this.pipelines.set(guildId, {
            ffmpeg: musicProc,
            musicProc,
            musicUrl,
            voiceState,
            isSimple: true
        });
    }
    
    // Play TTS through the pipeline
    async playTTS(guildId, ttsFile) {
        const p = this.pipelines.get(guildId);
        if (!p) return;
        
        // If simple mode, can't do much
        if (p.isSimple) {
            this.logger?.info(`🎤 Simple mode - TTS will replace music`);
            return;
        }
        
        this.logger?.info(`🎤 Feeding TTS to pipeline`);
        
        // Kill silence process
        if (p.silenceProc) {
            p.silenceProc.kill();
            p.silenceProc = null;
        }
        
        // Feed TTS to TTS pipe
        const ttsProc = spawn('ffmpeg', [
            '-re', '-i', ttsFile,
            '-stream_loop', '50',
            '-f', 's16le', '-ar', '48000', '-ac', '2',
            p.ttsPipe
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        
        p.ttsProc = ttsProc;
        p.isTTSPlaying = true;
        
        ttsProc.on('exit', () => {
            this.logger?.info(`🎤 TTS process ended`);
        });
    }
    
    // Stop TTS, return to music only
    async stopTTS(guildId) {
        const p = this.pipelines.get(guildId);
        if (!p || !p.isTTSPlaying || p.isSimple) return;
        
        this.logger?.info(`🎤 Stopping TTS, resuming music`);
        
        // Kill TTS process
        if (p.ttsProc) {
            p.ttsProc.kill();
            p.ttsProc = null;
        }
        
        // Restart silence on TTS pipe
        p.silenceProc = spawn('ffmpeg', [
            '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
            '-f', 's16le', '-ar', '48000', '-ac', '2',
            p.ttsPipe
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        
        p.isTTSPlaying = false;
    }
    
    // Stop everything
    stop(guildId) {
        const p = this.pipelines.get(guildId);
        if (!p) return;
        
        p.ffmpeg?.kill();
        p.musicProc?.kill();
        p.silenceProc?.kill();
        p.ttsProc?.kill();
        
        if (p.pipeDir) {
            try {
                fs.rmSync(p.pipeDir, { recursive: true, force: true });
            } catch {}
        }
        
        this.pipelines.delete(guildId);
        this.logger?.info(`🎛️ Pipeline stopped`);
    }
    
    get(guildId) {
        return this.pipelines.get(guildId);
    }
}

module.exports = { AudioPipeline };
