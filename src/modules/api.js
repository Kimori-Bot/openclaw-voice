/**
 * API Module - Express REST API
 */
function createApiServer(app, deps) {
    const { client, voiceManager, musicManager, transcriptionManager, logger } = deps;
    
    app.get('/health', (req, res) => {
        res.json({ 
            status: 'ok', 
            guilds: client.guilds.cache.size,
            connections: voiceManager.getConnectionCount()
        });
    });
    
    app.post('/join', async (req, res) => {
        const { guild_id, channel_id, user_id } = req.body;
        
        if (!guild_id) {
            return res.status(400).json({ error: 'guild_id required' });
        }
        
        try {
            const guild = client.guilds.cache.get(guild_id);
            if (!guild) {
                return res.status(404).json({ error: 'Guild not found' });
            }
            
            let targetChannel = channel_id;
            if (!targetChannel && user_id) {
                try {
                    const member = await guild.members.fetch(user_id);
                    targetChannel = member?.voice?.channelId;
                } catch(e) {}
            }
            
            if (!targetChannel) {
                return res.status(400).json({ error: 'No voice channel found' });
            }
            
            const channel = guild.channels.cache.get(targetChannel);
            const deps = req.app.get('deps');
            const transcriptionManager = deps?.transcriptionManager;
            
            const vc = await voiceManager.join(guild_id, channel, guild.voiceAdapterCreator,
                (guildId, audioBuffer, userId) => {
                    if (transcriptionManager) {
                        transcriptionManager.processVoiceAudio(guildId, audioBuffer, userId);
                    }
                });
            
            res.json({ status: 'joined', channel_id: targetChannel });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    
    app.post('/play', async (req, res) => {
        const { url, guild_id } = req.body;
        
        if (!url || !guild_id) {
            return res.status(400).json({ error: 'url and guild_id required' });
        }
        
        const vc = voiceManager.get(guild_id);
        if (!vc) {
            return res.status(400).json({ error: 'Not in voice channel' });
        }
        
        await musicManager.play(guild_id, url, vc);
        res.json({ status: 'playing', url });
    });
    
    app.get('/queue/:guildId', (req, res) => {
        const { guildId } = req.params;
        const queue = musicManager.getQueue(guildId);
        res.json({ queue });
    });
    
    // Reset session/identity for a guild
    app.post('/reset/:guildId', (req, res) => {
        const { guildId } = req.params;
        if (transcriptionManager) {
            transcriptionManager.resetSession(guildId);
        }
        res.json({ status: 'reset', guildId, message: 'Session reset' });
    });
    
    // Skip current song
    app.post('/skip/:guildId', (req, res) => {
        const { guildId } = req.params;
        const vc = voiceManager.get(guildId);
        if (vc && musicManager) {
            musicManager.playNext(guildId, vc);
            res.json({ status: 'skipped' });
        } else {
            res.status(400).json({ error: 'Not in voice channel' });
        }
    });
    
    // Stop and clear queue
    app.post('/stop/:guildId', (req, res) => {
        const { guildId } = req.params;
        if (musicManager) {
            musicManager.clearQueue(guildId);
        }
        res.json({ status: 'stopped' });
    });
    
    // Leave voice channel
    app.post('/leave/:guildId', (req, res) => {
        const { guildId } = req.params;
        voiceManager.cleanup(guildId);
        if (musicManager) {
            musicManager.clearQueue(guildId);
        }
        res.json({ status: 'left' });
    });
    
    // Get now playing
    app.get('/nowplaying/:guildId', (req, res) => {
        const { guildId } = req.params;
        const queue = musicManager?.getQueue(guildId) || [];
        res.json({ nowPlaying: queue[0] || null, queueLength: queue.length });
    });
}

module.exports = { createApiServer };
