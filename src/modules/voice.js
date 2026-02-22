/**
 * Voice Manager - Handles Discord voice connections
 */
const {
    joinVoiceChannel,
    createAudioPlayer,
    VoiceConnectionStatus,
    AudioPlayerStatus
} = require('@discordjs/voice');

class VoiceManager {
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
        this.connections = new Map(); // guildId -> VoiceState
    }
    
    async join(guildId, channel, adapterCreator) {
        if (this.connections.has(guildId)) {
            return this.connections.get(guildId);
        }
        
        const connection = joinVoiceChannel({
            channelId: channel.id,
            guildId: guildId,
            adapterCreator,
            selfDeaf: false,
            selfMute: false
        });
        
        const player = createAudioPlayer();
        connection.subscribe(player);
        
        const state = {
            connection,
            player,
            channelId: channel.id,
            isListening: true
        };
        
        this.connections.set(guildId, state);
        
        connection.on(VoiceConnectionStatus.Destroyed, () => {
            this.cleanup(guildId);
        });
        
        this.logger.info(`🎤 Joined voice in ${guildId}`);
        return state;
    }
    
    get(guildId) {
        return this.connections.get(guildId);
    }
    
    has(guildId) {
        return this.connections.has(guildId);
    }
    
    getConnectionCount() {
        return this.connections.size;
    }
    
    cleanup(guildId) {
        this.connections.delete(guildId);
    }
    
    setListening(guildId, isListening) {
        const state = this.connections.get(guildId);
        if (state) {
            state.isListening = isListening;
        }
    }
}

module.exports = { VoiceManager };
