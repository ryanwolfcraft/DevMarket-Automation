import {
    SlashCommandBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
    ComponentType,
    AttachmentBuilder,
} from 'discord.js';
import { errorEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { handleInteractionError } from '../../utils/errorHandler.js';

// ─── Config ───────────────────────────────────────────────────────────────────

const HIRABLE_LOGS_CHANNEL_NAME = 'hirable-logs';

const DESTINATION_CHANNELS = {
    scripting:   'hirable-scripter',
    builder:     'hirable-builder',
    ui_designer: 'hirable-ui-designer',
    animator:    'hirable-animator',
};

const ROLE_LABELS = {
    scripting:   'Scripting',
    builder:     'Builder',
    ui_designer: 'UI Designer',
    animator:    'Animator',
};

const ROLE_COLORS = {
    scripting:   0x5865f2,
    builder:     0xfaa61a,
    ui_designer: 0xeb459e,
    animator:    0x57f287,
};

const COLOR_PENDING  = 0x4f545c;
const COLOR_APPROVED = 0x57f287;
const COLOR_REJECTED = 0xed4245;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generatePostId() {
    return `${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 5).toUpperCase()}`;
}

function nowTime() {
    return new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

/**
 * Enhanced channel finder. 
 * Checks cache first, then fetches if necessary to prevent "Configuration Error".
 */
async function findChannel(guild, channelName) {
    // 1. Try finding in cache
    let channel = guild.channels.cache.find(c => c.name === channelName && c.isTextBased());
    
    // 2. If not in cache, force a fetch (Titan/Discord.js cache issues)
    if (!channel) {
        const fetchedChannels = await guild.channels.fetch();
        channel = fetchedChannels.find(c => c.name === channelName && c.isTextBased());
    }
    
    return channel ?? null;
}

async function fetchImageAttachment(data, filename = 'portfolio.png') {
    if (!data.hasImage || !data.imageUrl) return null;
    try {
        const res = await fetch(data.imageUrl);
        const buffer = Buffer.from(await res.arrayBuffer());
        return new AttachmentBuilder(buffer, { name: filename });
    } catch (err) {
        logger.warn('Could not fetch hirable portfolio image', { error: err.message });
        return null;
    }
}

// ─── Embed Builders ───────────────────────────────────────────────────────────

function buildPublicEmbed(data, submitter, postId) {
    const roleLabel = ROLE_LABELS[data.role] ?? data.role;
    const roleColor = ROLE_COLORS[data.role]  ?? COLOR_APPROVED;

    const descParts = [
        data.about,
        '',
        `**Portfolio / Examples**\n${data.portfolio || 'None provided'}`,
        '',
        `**Availability**\n${data.availability}`,
        '',
        `**Rate / Compensation**\n${data.rate}`,
        '',
        `**Contact**\n<@${submitter.id}>`,
    ];

    const embed = new EmbedBuilder()
        .setAuthor({ name: submitter.username, iconURL: submitter.displayAvatarURL({ size: 64 }) })
        .setTitle(`${submitter.username} — Available for ${roleLabel}`)
        .setDescription(descParts.join('\n'))
        .setColor(roleColor)
        .setFooter({ text: `Post ID: (${postId}) • Approved • Today at ${nowTime()}` });

    if (data.hasImage) embed.setImage('attachment://portfolio.png');
    return embed;
}

function buildLogEmbed(data, submitter, postId, status = 'pending', reviewerTag = null) {
    const colorMap  = { pending: COLOR_PENDING, approved: COLOR_APPROVED, rejected: COLOR_REJECTED };
    const statusMap = { pending: 'Pending Review', approved: 'Approved', rejected: 'Rejected' };
    const roleLabel = ROLE_LABELS[data.role] ?? data.role;

    const embed = new EmbedBuilder()
        .setAuthor({ name: submitter.username, iconURL: submitter.displayAvatarURL({ size: 64 }) })
        .setTitle(`Hirable Submission — ${submitter.username}`)
        .setColor(colorMap[status] ?? COLOR_PENDING)
        .addFields(
            { name: 'Role',          value: roleLabel,                                     inline: true  },
            { name: 'Submitted By',  value: `<@${submitter.id}> (${submitter.tag})`,         inline: true  },
            { name: 'Status',        value: statusMap[status] ?? 'Pending Review',           inline: true  },
            { name: 'About / Skills',value: data.about.slice(0, 1024),                       inline: false },
            { name: 'Portfolio',     value: data.portfolio || 'None provided',               inline: false },
            { name: 'Availability',  value: data.availability,                               inline: true  },
            { name: 'Rate',          value: data.rate,                                       inline: true  },
        )
        .setTimestamp()
        .setFooter({ text: `Post ID: (${postId})${reviewerTag ? ` • Reviewed by ${reviewerTag}` : ''}` });

    if (data.hasImage) embed.setImage('attachment://portfolio.png');
    return embed;
}

function buildApprovalButtons(postId, disabled = false) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`hirable_approve_${postId}`)
            .setLabel('Approve')
            .setStyle(ButtonStyle.Success)
            .setDisabled(disabled),
        new ButtonBuilder()
            .setCustomId(`hirable_reject_${postId}`)
            .setLabel('Reject')
            .setStyle(ButtonStyle.Danger)
            .setDisabled(disabled),
    );
}

// ─── Command ──────────────────────────────────────────────────────────────────

export default {
    data: new SlashCommandBuilder()
        .setName('hirable')
        .setDescription('List yourself as available for hire on a project.')
        .setDMPermission(false)
        .addStringOption(option =>
            option.setName('role').setDescription('Work type').setRequired(true)
                .addChoices(
                    { name: 'Scripting',   value: 'scripting'   },
                    { name: 'Builder',     value: 'builder'     },
                    { name: 'UI Designer', value: 'ui_designer' },
                    { name: 'Animator',    value: 'animator'    },
                )
        )
        .addAttachmentOption(option =>
            option.setName('portfolio').setDescription('Showcase your work (optional).').setRequired(false)
        ),

    async execute(interaction, guildConfig, client) {
        try {
            const roleValue  = interaction.options.getString('role');
            const attachment = interaction.options.getAttachment('portfolio');

            if (attachment && !attachment.contentType?.startsWith('image/')) {
                return await interaction.reply({
                    embeds: [errorEmbed('Invalid Attachment', 'Please upload an image file.')],
                    flags: MessageFlags.Ephemeral,
                });
            }

            // MODAL DEFINITION
            const modal = new ModalBuilder()
                .setCustomId('hirable_submit_modal')
                .setTitle('List Yourself as Available')
                .addComponents(
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder().setCustomId('hirable_about').setLabel('About You').setStyle(TextInputStyle.Paragraph).setMinLength(30).setRequired(true)
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder().setCustomId('hirable_portfolio').setLabel('Portfolio Links').setStyle(TextInputStyle.Paragraph).setRequired(false)
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder().setCustomId('hirable_availability').setLabel('Availability').setStyle(TextInputStyle.Short).setRequired(true)
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder().setCustomId('hirable_rate').setLabel('Rate').setStyle(TextInputStyle.Short).setRequired(true)
                    ),
                );

            await interaction.showModal(modal);

            const submitted = await interaction.awaitModalSubmit({
                filter: i => i.customId === 'hirable_submit_modal' && i.user.id === interaction.user.id,
                time: 300_000,
            }).catch(() => null);

            if (!submitted) return;
            await submitted.deferReply({ flags: MessageFlags.Ephemeral });

            // DATA OBJECT
            const hirableData = {
                role: roleValue,
                about: submitted.fields.getTextInputValue('hirable_about').trim(),
                portfolio: submitted.fields.getTextInputValue('hirable_portfolio')?.trim() || null,
                availability: submitted.fields.getTextInputValue('hirable_availability').trim(),
                rate: submitted.fields.getTextInputValue('hirable_rate').trim(),
                hasImage: !!(attachment?.contentType?.startsWith('image/')),
                imageUrl: attachment?.url ?? null,
            };

            // CHECK CONFIGURATION
            const logsChannel = await findChannel(interaction.guild, HIRABLE_LOGS_CHANNEL_NAME);
            
            if (!logsChannel) {
                return await submitted.editReply({
                    embeds: [errorEmbed(
                        'Configuration Error',
                        `Bot cannot find \`#${HIRABLE_LOGS_CHANNEL_NAME}\`. Ensure the channel exists and the bot has **View Channel** permissions.`
                    )],
                });
            }

            const postId = generatePostId();
            const logImage = await fetchImageAttachment(hirableData);
            
            const logMessage = await logsChannel.send({
                embeds:     [buildLogEmbed(hirableData, interaction.user, postId, 'pending')],
                components: [buildApprovalButtons(postId, false)],
                ...(logImage ? { files: [logImage] } : {}),
            });

            await submitted.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle('Listing Submitted')
                        .setDescription('Your listing is now under review by the moderation team.')
                        .setColor(COLOR_APPROVED)
                        .setTimestamp(),
                ],
            });

            // LOGIC FOR BUTTONS (Simplified)
            const collector = logsChannel.createMessageComponentCollector({
                componentType: ComponentType.Button,
                time: 7 * 24 * 60 * 60 * 1000,
            });

            collector.on('collect', async btnInteraction => {
                if (!btnInteraction.customId.includes(postId)) return;

                if (btnInteraction.customId.startsWith('hirable_approve')) {
                    await btnInteraction.deferUpdate();
                    
                    const destChannel = await findChannel(interaction.guild, DESTINATION_CHANNELS[hirableData.role]);
                    if (destChannel) {
                        const publicImage = await fetchImageAttachment(hirableData);
                        await destChannel.send({
                            embeds: [buildPublicEmbed(hirableData, interaction.user, postId)],
                            ...(publicImage ? { files: [publicImage] } : {}),
                        });
                    }

                    await logMessage.edit({
                        embeds: [buildLogEmbed(hirableData, interaction.user, postId, 'approved', btnInteraction.user.tag)],
                        components: [buildApprovalButtons(postId, true)],
                    });
                }
                
                // Add Rejection logic here similarly...
            });

        } catch (error) {
            logger.error('Hirable command failed', error);
            await handleInteractionError(interaction, error);
        }
    },
};
