/**
 * Music Manager - Handles yt-dlp with caching for performance
 */
const { spawn } = require('child_process');
const { createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const fs = require('fs');

class MusicManager {
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
        this.queues = new Map(); // guildId -> Song[]
        this.streamCache = new Map(); // url -> { streamUrl, expires }
        
        // Cache cleanup interval
        setInterval(() => this.cleanupCache(), 300000); // 5 min
    }
    
    // ====================
    // QUEUE MANAGEMENT
    // ====================
    getQueue(guildId) {
        if (!this.queues.has(guildId)) {
            this.queues.set(guildId, []);
        }
        return this.queues.get(guildId);
    }
    
    addToQueue(guildId, url, title, requestedBy) {
        const q = this.getQueue(guildId);
        if (q.length >= this.config.MAX_QUEUE_SIZE) {
            return -1; // Queue full
        }
        q.push({ url, title, requestedBy, addedAt: Date.now() });
        return q.length;
    }
    
    getNextFromQueue(guildId) {
        const q = this.getQueue(guildId);
        return q.shift();
    }
    
    clearQueue(guildId) {
        this.queues.set(guildId, []);
    }
    
    // ====================
    // STREAM URL CACHE
    // ====================
    getCachedStream(url) {
        const cached = this.streamCache.get(url);
        if (cached && cached.expires > Date.now()) {
            this.logger.debug(`📦 Cache hit: ${url}`);
            return cached.streamUrl;
        }
        this.streamCache.delete(url);
        return null;
    }
    
    setCachedStream(url, streamUrl) {
        this.streamCache.set(url, {
            streamUrl,
            expires: Date.now() + this.config.CACHE_TTL_MS
        });
    }
    
    cleanupCache() {
        const now = Date.now();
        for (const [url, data] of this.streamCache) {
            if (data.expires < now) {
                this.streamCache.delete(url);
            }
        }
    }
    
    // ====================
    // YT-DLP HELPERS
    // ====================
    async searchYouTube(query) {
        return new Promise((resolve) => {
            // Use cached search for common queries
            const cacheKey = `search:${query}`;
            const cached = this.getCachedStream(cacheKey);
            if (cached) {
                resolve(cached);
                return;
            }
            
            const proc = spawn('yt-dlp', [
                '--flat-playlist',
                '--print', '%(id)s',
                `ytsearch1:${query}`,
                '--no-warnings'
            ]);
            
            let output = '';
            proc.stdout.on('data', (d) => { output += d.toString(); });
            proc.on('close', (code) => {
                const videoId = output.trim();
                if (videoId) {
                    const result = `https://www.youtube.com/watch?v=${videoId}`;
                    this.setCachedStream(cacheKey, result);
                    resolve(result);
                } else {
                    resolve(null);
                }
            });
            proc.on('error', () => resolve(null));
        });
    }
    
    async getAudioStream(url) {
        const isYouTube = url.includes('youtube.com') || url.includes('youtu.be');
        
        // Not YouTube - return directly
        if (!isYouTube) {
            return url;
        }
        
        // Check cache first
        const cached = this.getCachedStream(url);
        if (cached) {
            return cached;
        }
        
        // Get from yt-dlp
        return new Promise((resolve, reject) => {
            const proc = spawn('yt-dlp', [
                '-f', 'bestaudio/best',
                '-g',
                '--no-playlist',
                '--no-warnings',
                '--socket-timeout', '10',
                url
            ]);
            
            let output = '';
            let errorOutput = '';
            
            proc.stdout.on('data', (d) => { output += d.toString(); });
            proc.stderr.on('data', (d) => { errorOutput += d.toString(); });
            
            proc.on('close', (code) => {
                const streamUrl = output.trim();
                if (streamUrl && !streamUrl.includes('ERROR')) {
                    this.setCachedStream(url, streamUrl);
                    resolve(streamUrl);
                } else {
                    reject(new Error(errorOutput || 'Failed to get stream URL'));
                }
            });
            proc.on('error', reject);
            
            // Timeout
            setTimeout(() => {
                proc.kill();
                reject(new Error('Stream URL timeout'));
            }, 15000);
        });
    }
    
    // ====================
    // PLAYBACK
    // ====================
    createAudioResource(streamUrl) {
        return createAudioResource(streamUrl, {
            inputType: 'unknown',
            ffmpegArguments: ['-af', 'volume=0.5']
        });
    }
    
    async playNext(guildId, voiceState, message = null) {
        const next = this.getNextFromQueue(guildId);
        if (!next) return;
        
        try {
            const streamUrl = await this.getAudioStream(next.url);
            const resource = this.createAudioResource(streamUrl);
            
            voiceState.player.on(AudioPlayerStatus.Idle, () => this.playNext(guildId, voiceState, message));
            voiceState.player.play(resource);
            
            if (message) {
                message.reply(`▶️ Now playing: ${next.title}`).catch(() => {});
            }
        } catch (e) {
            this.logger.error('Queue play error:', e.message);
            this.playNext(guildId, voiceState, message);
        }
    }
    
    async play(guildId, query, voiceState, message = null, isSearch = false) {
        this.logger.info(`🎵 play called: guildId=${guildId}, query=${query}`);
        
        let playUrl = query;
        let title = query;
        
        // Search if not a URL
        if (!query.match(/^https?:\/\//)) {
            playUrl = await this.searchYouTube(query);
            if (!playUrl) {
                message?.reply('❌ Could not find video').catch(() => {});
                return;
            }
            title = query;
        }
        
        // Add to queue if something is playing
        if (voiceState.player.state.status === AudioPlayerStatus.Playing) {
            const pos = this.addToQueue(guildId, playUrl, title, message?.author?.username);
            return;
        }
        
        // Play immediately
        try {
            const streamUrl = await this.getAudioStream(playUrl);
            const resource = this.createAudioResource(streamUrl);
            
            voiceState.player.on(AudioPlayerStatus.Idle, () => this.playNext(guildId, voiceState, message));
            voiceState.player.play(resource);
        } catch (e) {
            this.logger.error('Play error:', e.message);
            message?.reply(`❌ Error: ${e.message}`).catch(() => {});
        }
    }
}

module.exports = { MusicManager };
