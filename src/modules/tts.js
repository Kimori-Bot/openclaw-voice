/**
 * TTS Module - Text to Speech with caching
 */
const { spawn } = require('child_process');
const { createAudioResource } = require('@discordjs/voice');
const fs = require('fs');

const ttsCache = new Map(); // text hash -> audio buffer

async function speak(text, guildId, voiceManager, config, logger) {
    const vc = voiceManager.get(guildId);
    if (!vc) return;
    
    // Check cache
    const cacheKey = `${guildId}:${text}`;
    let audioBuffer = ttsCache.get(cacheKey);
    
    // Generate if not cached
    if (!audioBuffer) {
        audioBuffer = await generateTTS(text, config, logger);
        if (audioBuffer) {
            // Cache it
            ttsCache.set(cacheKey, audioBuffer);
            
            // Cleanup old cache entries
            if (ttsCache.size > 100) {
                const firstKey = ttsCache.keys().next().value;
                ttsCache.delete(firstKey);
            }
        }
    }
    
    if (!audioBuffer) return;
    
    // Save and play
    const tempFile = `/tmp/openclaw-tts-${guildId}-${Date.now()}.mp3`;
    fs.writeFileSync(tempFile, audioBuffer);
    
    const resource = createAudioResource(tempFile);
    vc.player.play(resource);
    
    // Cleanup after playing
    vc.player.once(AudioPlayerStatus.Idle, () => {
        try { fs.unlinkSync(tempFile); } catch(e) {}
    });
}

async function generateTTS(text, config, logger) {
    // Try ElevenLabs first
    if (config.TTS_ENGINE === 'elevenlabs' && config.ELEVENLABS_API_KEY) {
        try {
            const response = await fetch(
                `https://api.elevenlabs.io/v1/text-to-speech/${config.ELEVENLABS_VOICE_ID || 'rachel'}`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'xi-api-key': config.ELEVENLABS_API_KEY
                    },
                    body: JSON.stringify({
                        text,
                        model_id: config.ELEVENLABS_MODEL || 'eleven_monolingual_v1',
                        voice_settings: {
                            stability: parseFloat(config.ELEVENLABS_STABILITY) || 0.5,
                            similarity_boost: parseFloat(config.ELEVENLABS_SIMILARITY) || 0.75
                        }
                    })
                }
            );
            
            if (response.ok) {
                return Buffer.from(await response.arrayBuffer());
            }
        } catch(e) {
            logger.debug('ElevenLabs TTS error:', e.message);
        }
    }
    
    // Fallback to gTTS
    return new Promise((resolve) => {
        const tempFile = `/tmp/openclaw-tts-${Date.now()}.mp3`;
        const gtts = spawn('gtts-cli', [text, '--output', tempFile]);
        
        gtts.on('close', () => {
            try {
                const data = fs.readFileSync(tempFile);
                fs.unlinkSync(tempFile);
                resolve(data);
            } catch(e) { resolve(null); }
        });
        gtts.on('error', () => resolve(null));
    });
}

module.exports = { speak };
