/**
 * Commands Module - Slash command handler
 */
const { SlashCommandBuilder } = require('discord.js');
const { speak } = require('./tts');

const commands = [
    new SlashCommandBuilder().setName('join').setDescription('Join your voice channel'),
    new SlashCommandBuilder().setName('voice').setDescription('Join voice and start AI conversation'),
    new SlashCommandBuilder().setName('leave').setDescription('Leave voice channel'),
    new SlashCommandBuilder()
        .setName('play')
        .setDescription('Play a song from YouTube')
        .addStringOption(o => o.setName('query').setDescription('Song name or URL').setRequired(true)),
    new SlashCommandBuilder()
        .setName('search')
        .setDescription('AI-powered song search')
        .addStringOption(o => o.setName('query').setDescription('What kind of song?').setRequired(true)),
    new SlashCommandBuilder()
        .setName('stream')
        .setDescription('Stream from direct URL')
        .addStringOption(o => o.setName('url').setDescription('Audio URL').setRequired(true)),
    new SlashCommandBuilder().setName('queue').setDescription('Show queue'),
    new SlashCommandBuilder().setName('skip').setDescription('Skip song'),
    new SlashCommandBuilder().setName('stop').setDescription('Stop playing'),
    new SlashCommandBuilder().setName('clear').setDescription('Clear queue'),
    new SlashCommandBuilder().setName('listen').setDescription('Start voice conversation'),
    new SlashCommandBuilder().setName('stop_listen').setDescription('Stop listening'),
    new SlashCommandBuilder().setName('record').setDescription('Start recording audio to file'),
    new SlashCommandBuilder().setName('stop_record').setDescription('Stop recording and save file'),
    new SlashCommandBuilder()
        .setName('say')
        .setDescription('Speak text')
        .addStringOption(o => o.setName('text').setDescription('Text to speak').setRequired(true)),
    new SlashCommandBuilder().setName('help').setDescription('Show help'),
];

async function registerCommands(client) {
    await client.application.commands.set(commands);
}

async function handleInteraction(interaction, deps) {
    const { config, client, voiceManager, musicManager, transcriptionManager, logger } = deps;
    const { commandName, member, guild, options } = interaction;
    const guildId = interaction.guildId;
    
    const ensureVoice = async () => {
        await interaction.deferReply();
        
        let vc = voiceManager.get(guildId);
        if (vc) {
            await interaction.editReply('🎤 Ready!');
            return vc;
        }
        
        if (!member?.voice?.channel) {
            await interaction.editReply('❌ Join a voice channel first!');
            return null;
        }
        
        try {
            vc = await voiceManager.join(guildId, member.voice.channel, guild.voiceAdapterCreator, 
                (guildId, audioBuffer, userId) => {
                    transcriptionManager.processVoiceAudio(guildId, audioBuffer, userId);
                });
            await interaction.editReply('🎤 Joined!');
            return vc;
        } catch (e) {
            await interaction.editReply(`❌ Error: ${e.message}`);
            return null;
        }
    };
    
    switch (commandName) {
        case 'join':
        case 'voice':
            await ensureVoice();
            if (commandName === 'voice') {
                voiceManager.setListening(guildId, true);
            }
            break;
            
        case 'leave':
            if (voiceManager.has(guildId)) {
                voiceManager.cleanup(guildId);
                musicManager.clearQueue(guildId);
                await interaction.reply('👋 Left!');
            } else {
                await interaction.reply('❌ Not in voice!');
            }
            break;
            
        case 'play':
            const vc1 = await ensureVoice();
            if (vc1) {
                const query = options.getString('query');
                await musicManager.play(guildId, query, vc1, interaction);
            }
            break;
            
        case 'search':
            const vc2 = await ensureVoice();
            if (vc2) {
                const query = options.getString('query');
                const result = await sendToAI(`Find a live stream, radio station, or audio URL for "${query}". Just give me a direct playable URL or "none" if you can't find one.`, guildId, logger);
                
                if (!result || result.includes('none') || result.length < 10) {
                    await interaction.editReply(`❌ Could not find a stream for "${query}"`);
                    return;
                }
                
                await musicManager.play(guildId, result, vc2, interaction, true);
            }
            break;
            
        case 'stream':
            const vc3 = await ensureVoice();
            if (vc3) {
                const url = options.getString('url');
                await musicManager.play(guildId, url, vc3, interaction);
            }
            break;
            
        case 'queue':
            const q = musicManager.getQueue(guildId);
            if (q.length === 0) {
                await interaction.reply('🎵 Queue is empty');
            } else {
                await interaction.reply('🎵 **Queue:**\n' + q.map((s, i) => `${i+1}. ${s.title}`).join('\n'));
            }
            break;
            
        case 'skip':
            const vcSkip = voiceManager.get(guildId);
            if (vcSkip?.player) {
                vcSkip.player.stop();
                await interaction.reply('⏭️ Skipped!');
                setTimeout(() => musicManager.playNext(guildId, vcSkip), 500);
            } else {
                await interaction.reply('❌ Nothing playing');
            }
            break;
            
        case 'stop':
            const vcStop = voiceManager.get(guildId);
            if (vcStop?.player) {
                vcStop.player.stop();
                musicManager.clearQueue(guildId);
                await interaction.reply('⏹️ Stopped!');
            }
            break;
            
        case 'clear':
            musicManager.clearQueue(guildId);
            await interaction.reply('🗑️ Queue cleared!');
            break;
            
        case 'listen':
            if (voiceManager.has(guildId)) {
                voiceManager.setListening(guildId, true);
                await interaction.reply('👂 Listening started!');
            } else {
                await interaction.reply('❌ Join voice first!');
            }
            break;
            
        case 'stop_listen':
            voiceManager.setListening(guildId, false);
            await interaction.reply('🛑 Stopped listening.');
            break;
            
        case 'record':
            if (voiceManager.has(guildId)) {
                voiceManager.setRecording(guildId, true);
                await interaction.reply('🔴 Recording started! Use /stop_record to stop.');
            } else {
                await interaction.reply('❌ Join voice first!');
            }
            break;
            
        case 'stop_record':
            if (voiceManager.has(guildId)) {
                await interaction.deferReply();
                const filePath = voiceManager.setRecording(guildId, false);
                
                // Wait for file to be ready
                await new Promise(r => setTimeout(r, 1500));
                
                if (filePath) {
                    await interaction.editReply({ 
                        content: `💾 Recording saved!`,
                        files: [filePath]
                    });
                } else {
                    await interaction.editReply('❌ No recording to save.');
                }
            } else {
                await interaction.reply('❌ Not in voice!');
            }
            break;
            
        case 'say':
            const text = options.getString('text');
            await speak(text, guildId, voiceManager, config, logger);
            await interaction.reply(`🗣️ Said: ${text}`);
            break;
            
        case 'help':
            await interaction.reply({ embeds: [new (require('discord.js').EmbedBuilder)()
                .setTitle('🤖 OpenClaw Voice Commands')
                .addFields(
                    { name: '/play [song]', value: 'Play from YouTube' },
                    { name: '/search [query]', value: 'AI song search' },
                    { name: '/stream [url]', value: 'Play direct URL' },
                    { name: '/queue', value: 'Show queue' },
                    { name: '/skip', value: 'Skip song' },
                    { name: '/stop', value: 'Stop' },
                    { name: '/clear', value: 'Clear queue' },
                    { name: '/listen', value: 'Voice conversation' },
                    { name: '/say [text]', value: 'Speak text' }
                )
            ]});
            break;
    }
}

// Helper for AI search
async function sendToAI(query, guildId, logger) {
    const { spawn } = require('child_process');
    
    return new Promise((resolve) => {
        const proc = spawn('openclaw', [
            'agent', '--channel', 'discord',
            '--session-id', `discord-${guildId}-search`,
            '--message', query, '--timeout', '30'
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        
        let output = '';
        proc.stdout.on('data', (d) => { output += d.toString(); });
        proc.on('close', () => { resolve(output.trim()); });
        proc.on('error', () => resolve(''));
        setTimeout(() => { proc.kill(); resolve(''); }, 30000);
    });
}

module.exports = { registerCommands, handleInteraction };
