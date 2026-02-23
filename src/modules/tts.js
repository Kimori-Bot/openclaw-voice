/**
 * TTS Module - Text to Speech with caching
 */
const { spawn } = require('child_process');
const { createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const fs = require('fs');

const ttsCache = new Map(); // text hash -> audio buffer

async function speak(text, guildId, voiceManager, config, logger) {
    const vc = voiceManager.get(guildId);
    if (!vc) return;
    
    // Strip emojis and Discord-specific characters for TTS
    text = text
        .replace(/<:[a-zA-Z0-9_]+:\d+>/g, '') // Discord emoji :name:id
        .replace(/[\u{1F300}-\u{1F9FF}]/gu, '') // Unicode emojis
        .replace(/[\u{2600}-\u{26FF}]/gu, '') // Misc symbols
        .replace(/[\u{2700}-\u{27BF}]/gu, '') // Dingbats
        .replace(/[🎵🎶🎤🔊🔇⏸️⏹️⏭️⏮️➡️⬅️⬆️⬇️💀😂🤣❤️👍🔥✨]/g, '') // Music/common emojis
        .replace(/[\*\_\`\~\`]/g, '') // Markdown
        .trim();
    
    if (!text) return;
    
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
                        text,
                        model_id: config.ELEVENLABS_MODEL || 'eleven_turbo_v2',
                        voice_settings: {
                            stability: parseFloat(config.ELEVENLABS_STABILITY) || 0.5,
                            similarity_boost: parseFloat(config.ELEVENLABS_SIMILARITY) || 0.75
                        }
                    })
                }
            );
            
            if (response.ok) {
                logger.info(`🎤 ElevenLabs success, audio size: ${response.headers.get('content-length')}`);
                return Buffer.from(await response.arrayBuffer());
            } else {
                const err = await response.text();
                logger.info(`🎤 ElevenLabs error: ${response.status} - ${err}`);
            }
        } catch(e) {
            logger.info(`🎤 ElevenLabs exception: ${e.message}`);
        }
    }
    
    // Fallback to gTTS
    logger.info(`🎤 Falling back to gTTS`);
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

// Play wake word acknowledgment sound
async function playAcknowledgment(guildId, voiceManager, logger) {
    const vc = voiceManager.get(guildId);
    if (!vc || !vc.connection) return;
    
    // Try multiple acknowledgment options
    const ackOptions = [
        '/workspace/openclaw-voice/sounds/mhm.mp3',
        '/workspace/openclaw-voice/sounds/acknowledged.mp3'
    ];
    
    for (const soundPath of ackOptions) {
        if (fs.existsSync(soundPath)) {
            try {
                const resource = createAudioResource(soundPath);
                // Create a temporary player for acknowledgment
                const ackPlayer = createAudioPlayer();
                vc.connection.subscribe(ackPlayer);
                ackPlayer.play(resource);
                
                ackPlayer.on(AudioPlayerStatus.Idle, () => {
                    ackPlayer.stop();
                });
                
                logger.debug(`🔔 Played acknowledgment: ${soundPath}`);
                return;
            } catch (e) {
                logger.debug(`Failed to play ${soundPath}: ${e.message}`);
            }
        }
    }
    
    // Fallback: quick TTS "mhm"
    try {
        const tempFile = `/tmp/openclaw-ack-${Date.now()}.mp3`;
        const gtts = spawn('gtts-cli', ['mhm', '--output', tempFile, '--lang', 'en']);
        
        gtts.on('close', () => {
            if (fs.existsSync(tempFile)) {
                try {
                    const resource = createAudioResource(tempFile);
                    const ackPlayer = createAudioPlayer();
                    vc.connection.subscribe(ackPlayer);
                    ackPlayer.play(resource);
                    
                    ackPlayer.on(AudioPlayerStatus.Idle, () => {
                        ackPlayer.stop();
                        try { fs.unlinkSync(tempFile); } catch(e) {}
                    });
                } catch(e) {}
            }
        });
    } catch (e) {
        logger.debug(`Ack fallback failed: ${e.message}`);
    }
}

module.exports = { speak, playAcknowledgment };
