/**
 * Transcription Manager - Handles voice transcription with optimized caching
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

class TranscriptionManager {
    constructor(config, logger, voiceManager) {
        this.config = config;
        this.logger = logger;
        this.voiceManager = voiceManager;
        
        this.transcriptionState = new Map(); // guildId -> { buffer, lastUpdate, processing, silenceTimer }
        this.wakeWords = (config.WAKE_WORD || 'echo').split(',').map(w => w.trim().toLowerCase()).filter(Boolean);
        
        // Cache for transcriptions
        this.transcriptionCache = new Map(); // path -> { text, timestamp }
    }
    
    // ====================
    // TRANSCRIPTION
    // ====================
    async transcribe(audioPath) {
        // Check cache
        const cached = this.transcriptionCache.get(audioPath);
        if (cached && Date.now() - cached.timestamp < 300000) { // 5 min cache
            return cached.text;
        }
        
        // Try ElevenLabs first if configured
        if (this.config.STT_ENGINE === 'elevenlabs' && this.config.ELEVENLABS_API_KEY) {
            try {
                const audioData = fs.readFileSync(audioPath);
                const FormData = require('form-data');
                const form = new FormData();
                form.append('file', new Blob([audioData]), 'audio.wav');
                form.append('model_id', 'scribe');
                
                const response = await fetch('https://api.elevenlabs.io/v1/scribe', {
                    method: 'POST',
                    headers: { 'xi-api-key': this.config.ELEVENLABS_API_KEY },
                    body: form
                });
                
                if (response.ok) {
                    const result = await response.json();
                    const text = result.text;
                    this.transcriptionCache.set(audioPath, { text, timestamp: Date.now() });
                    return text;
                }
            } catch(e) {
                this.logger.debug(`ElevenLabs STT error: ${e.message}`);
            }
        }
        
        // Try whisper.cpp server (fastest - direct C++ implementation)
        try {
            const FormData = require('form-data');
            const form = new FormData();
            form.append('file', fs.createReadStream(audioPath));
            form.append('response_format', 'text');
            
            const response = await fetch(this.config.WHISPER_SERVER + '/inference', {
                method: 'POST',
                body: form,
                signal: AbortSignal.timeout(15000)
            });
            
            if (response.ok) {
                const text = await response.text();
                const cleaned = text.replace(/["\n]/g, ' ').trim();
                this.transcriptionCache.set(audioPath, { text: cleaned, timestamp: Date.now() });
                return cleaned;
            }
        } catch(e) {
            this.logger.debug(`Whisper.cpp error: ${e.message}`);
        }
        
        // Fallback to FasterWhisper HTTP server
        try {
            const response = await fetch(this.config.WHISPER_SERVER + '/transcribe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: audioPath }),
                signal: AbortSignal.timeout(10000)
            });
            
            if (response.ok) {
                const result = await response.json();
                this.transcriptionCache.set(audioPath, { text: result.text, timestamp: Date.now() });
                return result.text;
            }
        } catch(e) {
            this.logger.debug(`FasterWhisper fallback error: ${e.message}`);
        }
        
        return '';
    }
    
    // ====================
    // AUDIO PROCESSING
    // ====================
    async processVoiceAudio(guildId, audioBuffer, userId) {
        const vc = this.voiceManager.get(guildId);
        if (!vc?.isListening) return;
        
        if (!audioBuffer || audioBuffer.length < 2000) return;
        
        // Save to temp file
        const tempDir = '/tmp/openclaw-audio';
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
        
        const pcmFile = `${tempDir}/speech-${guildId}-${Date.now()}.pcm`;
        const wavFile = `${tempDir}/speech-${guildId}-${Date.now()}.wav`;
        
        fs.writeFileSync(pcmFile, audioBuffer);
        
        // Convert to WAV
        await new Promise((resolve) => {
            const ff = spawn('ffmpeg', [
                '-f', 's16le', '-ar', '48000', '-ac', '2',
                '-i', pcmFile,
                '-af', 'volume=4',
                '-y', wavFile
            ]);
            ff.on('close', () => {
                try { fs.unlinkSync(pcmFile); } catch(e) {}
                resolve();
            });
            ff.on('error', () => resolve());
        });
        
        // Transcribe
        const text = await this.transcribe(wavFile);
        try { fs.unlinkSync(wavFile); } catch(e) {}
        
        if (!text) return;
        
        // Update buffer
        this.updateBuffer(guildId, text);
    }
    
    updateBuffer(guildId, text) {
        if (!this.transcriptionState.has(guildId)) {
            this.transcriptionState.set(guildId, {
                buffer: '',
                lastUpdate: Date.now(),
                processing: false,
                silenceTimer: null
            });
        }
        
        const state = this.transcriptionState.get(guildId);
        state.buffer = state.buffer ? state.buffer + ' ' + text : text;
        state.lastUpdate = Date.now();
        
        // Clear old timer
        if (state.silenceTimer) {
            clearTimeout(state.silenceTimer);
        }
        
        // Set new timer for processing
        const SILENCE_THRESHOLD_MS = 1500;
        
        state.silenceTimer = setTimeout(async () => {
            await this.processBuffer(guildId);
        }, SILENCE_THRESHOLD_MS);
    }
    
    async processBuffer(guildId) {
        const state = this.transcriptionState.get(guildId);
        if (!state || !state.buffer || state.processing) return;
        
        const text = state.buffer.trim();
        if (text.length < 2) {
            state.processing = false;
            return;
        }
        
        // Check wake word
        const normalized = text.toLowerCase().replace(/^[,\.\s]+|[,\.\s]+$/g, '');
        const hasWakeWord = this.wakeWords.some(w => 
            normalized.includes(w) || 
('            normalized.startsWithhey ' + w) ||
            normalized.startsWith('okay ' + w)
        );
        
        if (!this.config.ALWAYS_RESPOND && !hasWakeWord) {
            this.logger.debug(`No wake word: "${text}"`);
            state.processing = false;
            return;
        }
        
        state.processing = true;
        state.buffer = '';
        
        // Clean text
        let cleanText = text;
        this.wakeWords.forEach(w => {
            cleanText = cleanText.replace(new RegExp(w, 'gi'), '');
            cleanText = cleanText.replace(new RegExp('hey\\s*' + w, 'gi'), '');
            cleanText = cleanText.replace(new RegExp('okay\\s*' + w, 'gi'), '');
        });
        cleanText = cleanText.replace(/^[,\.\s]+/, '').trim() || text;
        
        // Send to OpenClaw
        this.logger.info(`Sending to AI: "${cleanText}"`);
        const response = await this.sendToOpenClaw(cleanText, guildId);
        
        // Speak response
        if (response && !response.startsWith('Error:') && response.length < 500) {
            const { speak } = require('./tts');
            await speak(response, guildId, this.voiceManager, this.config, this.logger);
        }
        
        state.processing = false;
    }
    
    async sendToOpenClaw(text, guildId) {
        return new Promise((resolve) => {
            const proc = spawn('openclaw', [
                'agent',
                '--channel', 'discord',
                '--session-id', `discord-${guildId}`,
                '--message', text,
                '--timeout', '30'
            ], { stdio: ['ignore', 'pipe', 'pipe'] });
            
            let output = '';
            let error = '';
            
            proc.stdout.on('data', (data) => { output += data.toString(); });
            proc.stderr.on('data', (data) => { error += data.toString(); });
            
            proc.on('close', (code) => {
                if (code === 0 && output.trim()) {
                    resolve(output.trim());
                } else {
                    this.logger.error('OpenClaw error:', error || 'No output');
                    resolve('Error: Could not get response');
                }
            });
            
            proc.on('error', (e) => {
                resolve('Error: ' + e.message);
            });
            
            setTimeout(() => {
                proc.kill();
                resolve('Error: Timeout');
            }, 30000);
        });
    }
}

module.exports = { TranscriptionManager };
