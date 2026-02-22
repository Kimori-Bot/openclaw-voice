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
    // TRANSCRIPTION - Direct binary (fastest, no HTTP overhead)
    // ====================
    async transcribe(audioPath) {
        // Check cache
        const cached = this.transcriptionCache.get(audioPath);
        if (cached && Date.now() - cached.timestamp < 300000) {
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
        
        // Try whisper.cpp CLI directly (fastest - no HTTP overhead)
        try {
            this.logger.info(`📝 Trying whisper.cpp`);
            const result = await this.transcribeWithWhisperCpp(audioPath);
            if (result) {
                this.transcriptionCache.set(audioPath, { text: result, timestamp: Date.now() });
                return result;
            }
        } catch(e) {
            this.logger.info(`Whisper.cpp CLI error: ${e.message}`);
        }
        
        // Fallback to HTTP server
        try {
            this.logger.info(`📝 Trying FasterWhisper HTTP`);
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
    
    // Direct whisper.cpp binary - fastest possible
    async transcribeWithWhisperCpp(audioPath) {
        return new Promise((resolve, reject) => {
            const timestamp = Date.now();
            const outputFile = `/tmp/whisper-${timestamp}.txt`;
            
            this.logger.info(`📝 Running whisper on: ${audioPath}`);
            
            const proc = spawn('whisper-cli', [
                '-m', '/root/.whisper/ggml-tiny.bin',
                '-f', audioPath,
                '-otxt',
                '-of', `/tmp/whisper-${timestamp}`,
                '-t', '4',
                '-nth', '0.01',  // Lower no-speech threshold
                '-vt', '0.1'     // Lower VAD threshold
            ], { stdio: ['ignore', 'pipe', 'pipe'] });
            
            let stderr = '';
            
            proc.stderr.on('data', (data) => { 
                stderr += data.toString(); 
                this.logger.info(`📝 whisper stderr: ${data.toString().substring(0, 100)}`);
            });
            
            proc.on('close', (code) => {
                this.logger.info(`📝 whisper exited code: ${code}`);
                // Read output file
                try {
                    if (fs.existsSync(outputFile)) {
                        const text = fs.readFileSync(outputFile, 'utf8').trim();
                        fs.unlinkSync(outputFile);
                        this.logger.info(`📝 whisper output: "${text}"`);
                        if (text) resolve(text);
                        else reject(new Error('No transcription output'));
                    } else {
                        this.logger.info(`📝 whisper output file not found: ${outputFile}`);
                        reject(new Error('No output file created'));
                    }
                } catch(e) {
                    this.logger.info(`📝 whisper error: ${e.message}`);
                    reject(e);
                }
            });
            
            proc.on('error', (err) => {
                reject(err);
            });
            
            // Timeout
            setTimeout(() => {
                proc.kill();
                reject(new Error('whisper-cli timeout'));
            }, 15000);
        });
    }
    
    // ====================
    // AUDIO PROCESSING
    // ====================
    async processVoiceAudio(guildId, audioBuffer, userId) {
        this.logger.info(`📥 processVoiceAudio called: ${audioBuffer?.length || 0} bytes`);
        
        const vc = this.voiceManager.get(guildId);
        this.logger.info(`📥 VC state: ${vc ? 'exists' : 'null'}, isListening: ${vc?.isListening}`);
        
        if (!vc?.isListening) {
            this.logger.info(`📥 Skipping - not in listening mode`);
            return;
        }
        
        if (!audioBuffer || audioBuffer.length < 100) {
            this.logger.info(`📥 Skipping - audio too small (${audioBuffer?.length || 0} bytes)`);
            return;
        }
        
        // Audio is already decoded to PCM by voice.js using @discordjs/opus
        // Just convert sample rate for whisper
        const fs = require('fs');
        const tempDir = '/tmp/openclaw-audio';
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
        
        const pcmFile = `${tempDir}/speech-${guildId}-${Date.now()}.pcm`;
        const wavFile = `${tempDir}/speech-${guildId}-${Date.now()}.wav`;
        
        fs.writeFileSync(pcmFile, audioBuffer);
        
        this.logger.info(`📝 PCM file: ${pcmFile}, size: ${audioBuffer.length}`);
        
        // Convert to WAV for whisper with voice enhancement
        await new Promise((resolve) => {
            const ff = spawn('ffmpeg', [
                '-f', 's16le', '-ar', '48000', '-ac', '2',
                '-i', pcmFile,
                '-ar', '16000',
                '-ac', '1',
                // More aggressive voice band filter + noise gate + boost
                '-af', 'highpass=f=80,lowpass=f=7500,volume=4,compand=attacks=0:points=-80/-80|-6/-6|0/-3|6/0',
                '-y', wavFile
            ]);
            
            ff.on('close', (code) => {
                this.logger.info(`📝 ffmpeg exit code: ${code}`);
                try { fs.unlinkSync(pcmFile); } catch(e) {}
                resolve();
            });
            ff.on('error', (e) => {
                this.logger.info(`📝 ffmpeg error: ${e.message}`);
                resolve();
            });
        });
        
        // Transcribe
        this.logger.info(`📝 Starting transcription for ${wavFile}`);
        let text = await this.transcribe(wavFile);
        
        // Clean up noise markers from whisper
        text = text.replace(/\[.*?\]/g, '').replace(/\(.*?\)/g, '').trim();
        
        this.logger.info(`📝 Transcription result: "${text}"`);
        
        // Keep file for debugging if transcription failed
        if (!text) {
            const debugName = wavFile.replace('/tmp/', '/tmp/debug-');
            try { fs.renameSync(wavFile, debugName); } catch(e) {}
            this.logger.info(`📝 Saved debug file: ${debugName}`);
        } else {
            try { fs.unlinkSync(wavFile); } catch(e) {}
        }
        
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
        
        // Check wake word - strip all punctuation
        const normalized = text.toLowerCase().replace(/[,\.\s]+/g, ' ').trim();
        const hasWakeWord = this.wakeWords.some(w => 
            normalized.includes(w) || 
            normalized.startsWith('hey ' + w) ||
            normalized.startsWith('okay ' + w)
        );
        
        if (!this.config.ALWAYS_RESPOND && !hasWakeWord) {
            this.logger.info(`No wake word: "${text}"`);
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
