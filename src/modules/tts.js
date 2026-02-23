/**
 * TTS Module - Text to Speech with caching
 */
const { spawn } = require('child_process');
const { createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const fs = require('fs');

const ttsCache = new Map(); // text hash -> audio buffer

async function speak(text, guildId, voiceManager, musicManager, config, logger) {
    const vc = voiceManager.get(guildId);
    if (!vc) return;
    
    // Strip emojis and Discord-specific characters for TTS
    text = text
        .replace(/<:[a-zA-Z0-9_]+:\d+>/g, '')
        .replace(/[\u{1F300}-\u{1F9FF}]/gu, '')
        .replace(/[\u{2600}-\u{26FF}]/gu, '')
        .replace(/[\u{2700}-\u{27BF}]/gu, '')
        .replace(/[🎵🎶🎤🔊🔇⏸️⏹️⏭️⏮️➡️⬅️⬆️⬇️💀😂🤣❤️👍🔥✨]/g, '')
        .replace(/[\*\_\`\~\`]/g, '')
        .trim();
    
    if (!text) return;
    
    // Check cache
    const cacheKey = `${guildId}:${text}`;
    let audioBuffer = ttsCache.get(cacheKey);
    
    // Generate if not cached
    if (!audioBuffer) {
        audioBuffer = await generateTTS(text, config, logger);
        if (audioBuffer) {
            ttsCache.set(cacheKey, audioBuffer);
            if (ttsCache.size > 100) {
                const firstKey = ttsCache.keys().next().value;
                ttsCache.delete(firstKey);
            }
        }
    }
    
    if (!audioBuffer) return;
    
    // Save to temp file
    const tempFile = `/tmp/openclaw-tts-${guildId}-${Date.now()}.mp3`;
    fs.writeFileSync(tempFile, audioBuffer);
    
    // Play TTS through pipeline if available
    if (musicManager?.playTTS) {
        logger?.info(`🎤 Playing TTS through pipeline`);
        await musicManager.playTTS(guildId, tempFile);
        
        // Auto-stop TTS after 8 seconds
        setTimeout(() => {
            if (musicManager?.unduck) {
                musicManager.unduck(guildId);
            }
            try { fs.unlinkSync(tempFile); } catch(e) {}
        }, 8000);
    } else {
        // Fallback: direct play
        const resource = createAudioResource(tempFile);
        vc.player.play(resource);
    }
}

async function generateTTS(text, config, logger) {
    logger.info(`🎤 TTS request: engine=${config.TTS_ENGINE}, has_key=${!!config.ELEVENLABS_API_KEY}, voice=${config.ELEVENLABS_VOICE_ID}`);
    
    // Try ElevenLabs first
    if (config.TTS_ENGINE === 'elevenlabs' && config.ELEVENLABS_API_KEY) {
        try {
            const voiceId = config.ELEVENLABS_VOICE_ID || 'rachel';
            logger.info(`🎤 Calling ElevenLabs API with voice: ${voiceId}`);
            
            const response = await fetch(
                `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'xi-api-key': config.ELEVENLABS_API_KEY
                    },
                    body: JSON.stringify({
                        text: text,
                        model_id: 'eleven_monolingual_v1',
                        voice_settings: {
                            stability: 0.5,
                            similarity_boost: 0.8
                        }
                    })
                }
            );
            
            if (!response.ok) {
                throw new Error(`ElevenLabs API error: ${response.status}`);
            }
            
            const buffer = await response.arrayBuffer();
            logger.info(`🎤 ElevenLabs success: ${buffer.byteLength} bytes`);
            return Buffer.from(buffer);
        } catch (e) {
            logger.error(`ElevenLabs error: ${e.message}`);
        }
    }
    
    // Fallback to gTTS
    logger.info(`🎤 Using gTTS`);
    return new Promise((resolve, reject) => {
        const lang = config.TTS_LANG || 'en';
        const proc = spawn('gtts-cli', ['-l', lang, text], { stdio: ['ignore', 'pipe', 'pipe'] });
        
        let data = [];
        proc.stdout.on('data', (chunk) => data.push(chunk));
        proc.on('close', (code) => {
            if (code === 0) {
                resolve(Buffer.concat(data));
            } else {
                resolve(null);
            }
        });
        proc.on('error', () => resolve(null));
    });
}

module.exports = { speak };
