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
        this.radioMode = new Map(); // guildId -> { query, lastFetch }
        
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
    
    // Search for multiple videos (for radio mode)
    async searchYouTubeMultiple(query, count = 5) {
        return new Promise((resolve) => {
            const cacheKey = `search:${query}:${count}`;
            const cached = this.getCachedStream(cacheKey);
            if (cached) {
                resolve(JSON.parse(cached));
                return;
            }
            
            const proc = spawn('yt-dlp', [
                '--flat-playlist',
                '--print', '%(id)s',
                `ytsearch${count}:${query}`,
                '--no-warnings'
            ]);
            
            let output = '';
            proc.stdout.on('data', (d) => { output += d.toString(); });
            proc.on('close', (code) => {
                const videoIds = output.trim().split('\n').filter(Boolean);
                const results = videoIds.map(id => `https://www.youtube.com/watch?v=${id}`);
                if (results.length > 0) {
                    this.setCachedStream(cacheKey, JSON.stringify(results));
                    resolve(results);
                } else {
                    resolve([]);
                }
            });
            proc.on('error', () => resolve([]));
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
    
    async playNext(guildId, voiceState, message = null, isRadio = false) {
        const next = this.getNextFromQueue(guildId);
        if (!next) {
            // Check if in radio mode and need more songs
            const radio = this.radioMode.get(guildId);
            if (radio) {
                this.logger.info(`📻 Radio mode: fetching more tracks for ${radio.query}`);
                const urls = await this.searchYouTubeMultiple(radio.query, 8);
                for (const url of urls) {
                    this.addToQueue(guildId, url, radio.query, 'radio');
                }
                if (urls.length > 0) {
                    this.playNext(guildId, voiceState, message, true);
                    return;
                }
            }
            return;
        }
        
        // If queue is getting low and we're in radio mode, fetch more
        if (isRadio || this.radioMode.has(guildId)) {
            const queue = this.getQueue(guildId);
            if (queue.length < 3) {
                const radio = this.radioMode.get(guildId);
                if (radio) {
                    this.logger.info(`📻 Radio mode: pre-fetching more tracks`);
                    const urls = await this.searchYouTubeMultiple(radio.query, 8);
                    for (const url of urls) {
                        this.addToQueue(guildId, url, radio.query, 'radio');
                    }
                }
            }
        }
        
        try {
            const streamUrl = await this.getAudioStream(next.url);
            const resource = this.createAudioResource(streamUrl);
            
            // Handle errors - try to restart with fresh stream
            voiceState.player.on('error', async (err) => {
                this.logger.error(`🎵 Queue player error: ${err.message}, trying to restart...`);
                try {
                    const freshStream = await this.getAudioStream(next.url);
                    const freshResource = this.createAudioResource(freshStream);
                    voiceState.player.play(freshResource);
                } catch (e) {
                    this.logger.error(`🎵 Queue restart failed: ${e.message}`);
                }
            });
            
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
        
        // Detect radio mode (query contains "radio" or "mix")
        const isRadio = query.toLowerCase().includes('radio') || query.toLowerCase().includes('mix');
        
        // Search if not a URL
        if (!query.match(/^https?:\/\//)) {
            if (isRadio) {
                // Radio mode: search for multiple videos
                this.logger.info(`📻 Radio mode detected for: ${query}`);
                const urls = await this.searchYouTubeMultiple(query, 8);
                if (urls.length === 0) {
                    message?.reply('❌ Could not find radio station').catch(() => {});
                    return;
                }
                // Enable radio mode
                this.radioMode.set(guildId, { query, lastFetch: Date.now() });
                // Queue all the URLs
                for (const url of urls) {
                    this.addToQueue(guildId, url, query, message?.author?.username);
                }
                // Play first one
                const firstUrl = urls[0];
                const streamUrl = await this.getAudioStream(firstUrl);
                const resource = this.createAudioResource(streamUrl);
                
                voiceState.player.on('error', async (err) => {
                    this.logger.error(`🎵 Radio player error: ${err.message}`);
                });
                
                voiceState.player.on(AudioPlayerStatus.Idle, () => this.playNext(guildId, voiceState, message, true));
                voiceState.player.play(resource);
                message?.reply(`📻 Starting radio: ${query} (${urls.length} tracks queued)`).catch(() => {});
                return;
            } else {
                playUrl = await this.searchYouTube(query);
                if (!playUrl) {
                    message?.reply('❌ Could not find video').catch(() => {});
                    return;
                }
                title = query;
            }
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
            
            // Handle errors - try to restart with fresh stream
            voiceState.player.on('error', async (err) => {
                this.logger.error(`🎵 Player error: ${err.message}, trying to restart...`);
                // Try to get fresh stream and replay
                try {
                    const freshStream = await this.getAudioStream(playUrl);
                    const freshResource = this.createAudioResource(freshStream);
                    voiceState.player.play(freshResource);
                } catch (e) {
                    this.logger.error(`🎵 Restart failed: ${e.message}`);
                }
            });
            
            voiceState.player.on(AudioPlayerStatus.Idle, () => this.playNext(guildId, voiceState, message));
            voiceState.player.play(resource);
        } catch (e) {
            this.logger.error('Play error:', e.message);
            message?.reply(`❌ Error: ${e.message}`).catch(() => {});
        }
    }
}

module.exports = { MusicManager };
