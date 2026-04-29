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

// Where approved posts are sent, keyed by role value
const DESTINATION_CHANNELS = {
    scripting:   'hirable-scripter',
    builder:     'hirable-builder',
    ui_designer: 'hirable-ui-designer',
    animator:    'hirable-animator',
};

// Human-readable labels
const ROLE_LABELS = {
    scripting:   'Scripting',
    builder:     'Builder',
    ui_designer: 'UI Designer',
    animator:    'Animator',
};

// Accent color per role — mirrors /hiring so channels feel consistent
const ROLE_COLORS = {
    scripting:   0x5865f2, // indigo
    builder:     0xfaa61a, // amber
    ui_designer: 0xeb459e, // pink
    animator:    0x57f287, // green
};

const COLOR_PENDING  = 0x4f545c;
const COLOR_APPROVED = 0x57f287;
const COLOR_REJECTED = 0xed4245;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generatePostId() {
    const ts   = Date.now().toString(36).toUpperCase();
    const rand = Math.random().toString(36).substring(2, 5).toUpperCase();
    return `${ts}-${rand}`;
}

function nowTime() {
    return new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

async function findChannel(guild, channelName) {
    return guild.channels.cache.find(c => c.name === channelName && c.isTextBased()) ?? null;
}

/**
 * Fetches an image from Discord's CDN and wraps it in an AttachmentBuilder.
 * Returns null if no image is attached or the fetch fails.
 */
async function fetchImageAttachment(data, filename = 'portfolio.png') {
    if (!data.hasImage || !data.imageUrl) return null;
    try {
        const res    = await fetch(data.imageUrl);
        const buffer = Buffer.from(await res.arrayBuffer());
        return new AttachmentBuilder(buffer, { name: filename });
    } catch (err) {
        logger.warn('Could not fetch hirable portfolio image', { error: err.message });
        return null;
    }
}

// ─── Embed Builders ───────────────────────────────────────────────────────────

/**
 * The public developer profile card posted in #hirable-*.
 * Designed to read like a clean résumé snippet: avatar + name at top,
 * skills body, structured fields for availability/rate/portfolio, contact at bottom.
 */
function buildPublicEmbed(data, submitter, postId) {
    const roleLabel = ROLE_LABELS[data.role] ?? data.role;
    const roleColor = ROLE_COLORS[data.role]  ?? COLOR_APPROVED;

    // Build the description body — mirrors the reference style from /hiring
    const descParts = [data.about];

    if (data.portfolio) {
        descParts.push('', `**Portfolio / Examples**\n${data.portfolio}`);
    }

    descParts.push(
        '',
        `**Availability**\n${data.availability}`,
        '',
        `**Rate / Compensation**\n${data.rate}`,
        '',
        `**Contact**\n<@${submitter.id}>`,
    );

    const embed = new EmbedBuilder()
        .setAuthor({
            name:    submitter.username,
            iconURL: submitter.displayAvatarURL({ size: 64 }),
        })
        .setTitle(`${submitter.username} — Available for ${roleLabel}`)
        .setDescription(descParts.join('\n'))
        .setColor(roleColor)
        .addFields(
            { name: 'Role',         value: roleLabel,                     inline: true },
            { name: 'Availability', value: data.availability,             inline: true },
            { name: 'Rate',         value: data.rate,                     inline: true },
        )
        .setFooter({
            text: `Post ID: (${postId}) • Approved • Today at ${nowTime()}`,
        });

    if (data.hasImage) {
        embed.setImage('attachment://portfolio.png');
    }

    return embed;
}

/**
 * Staff-facing embed posted in #hirable-logs for review.
 * Shows everything a moderator needs to make a decision.
 */
function buildLogEmbed(data, submitter, postId, status = 'pending', reviewerTag = null) {
    const colorMap  = { pending: COLOR_PENDING, approved: COLOR_APPROVED, rejected: COLOR_REJECTED };
    const statusMap = { pending: 'Pending Review', approved: 'Approved', rejected: 'Rejected' };
    const roleLabel = ROLE_LABELS[data.role] ?? data.role;

    const embed = new EmbedBuilder()
        .setAuthor({
            name:    submitter.username,
            iconURL: submitter.displayAvatarURL({ size: 64 }),
        })
        .setTitle(`Hirable Submission — ${submitter.username}`)
        .setColor(colorMap[status] ?? COLOR_PENDING)
        .addFields(
            { name: 'Role',          value: roleLabel,                                       inline: true  },
            { name: 'Submitted By',  value: `<@${submitter.id}> (${submitter.tag})`,         inline: true  },
            { name: 'Status',        value: statusMap[status] ?? 'Pending Review',           inline: true  },
            { name: 'About / Skills',value: data.about.slice(0, 1024),                       inline: false },
            { name: 'Portfolio',     value: data.portfolio || 'None provided',               inline: false },
            { name: 'Availability',  value: data.availability,                               inline: true  },
            { name: 'Rate',          value: data.rate,                                       inline: true  },
        )
        .setTimestamp()
        .setFooter({
            text: `Post ID: (${postId})${reviewerTag ? ` • Reviewed by ${reviewerTag}` : ''}`,
        });

    if (data.hasImage) {
        embed.setImage('attachment://portfolio.png');
    }

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
        .setDescription('List yourself as available for hire on a Roblox project.')
        .setDMPermission(false)
        .addStringOption(option =>
            option
                .setName('role')
                .setDescription('What type of work are you offering?')
                .setRequired(true)
                .addChoices(
                    { name: 'Scripting',   value: 'scripting'   },
                    { name: 'Builder',     value: 'builder'     },
                    { name: 'UI Designer', value: 'ui_designer' },
                    { name: 'Animator',    value: 'animator'    },
                ),
        )
        .addAttachmentOption(option =>
            option
                .setName('portfolio')
                .setDescription('Upload a screenshot or image showcasing your work (optional).')
                .setRequired(false),
        ),

    async execute(interaction, guildConfig, client) {
        try {
            // ── 1. Read options before showModal — they vanish after ──────────
            const roleValue  = interaction.options.getString('role');
            const attachment = interaction.options.getAttachment('portfolio');

            // Validate attachment type upfront
            if (attachment && !attachment.contentType?.startsWith('image/')) {
                return await interaction.reply({
                    embeds: [errorEmbed('Invalid Attachment', 'The portfolio image must be an image file (PNG, JPG, GIF, etc.).')],
                    flags: MessageFlags.Ephemeral,
                });
            }

            // ── 2. Show the form modal ────────────────────────────────────────
            const modal = new ModalBuilder()
                .setCustomId('hirable_submit_modal')
                .setTitle('List Yourself as Available')
                .addComponents(
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId('hirable_about')
                            .setLabel('About You & Your Skills')
                            .setStyle(TextInputStyle.Paragraph)
                            .setPlaceholder(
                                'Describe your experience, skills, past work, tools you use, etc. ' +
                                'Be specific — this is what teams will read first.',
                            )
                            .setMinLength(30)
                            .setMaxLength(1200)
                            .setRequired(true),
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId('hirable_portfolio')
                            .setLabel('Portfolio / Examples (links, Roblox profile, etc.)')
                            .setStyle(TextInputStyle.Paragraph)
                            .setPlaceholder(
                                'Paste links to your work, Roblox profile, DevForum posts, YouTube, etc. ' +
                                'You can also attach an image above.',
                            )
                            .setMaxLength(600)
                            .setRequired(false),
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId('hirable_availability')
                            .setLabel('Availability')
                            .setStyle(TextInputStyle.Short)
                            .setPlaceholder('e.g. Weekends only, ~10hrs/week, Full-time, Flexible...')
                            .setMaxLength(100)
                            .setRequired(true),
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId('hirable_rate')
                            .setLabel('Rate / Compensation Expectations')
                            .setStyle(TextInputStyle.Short)
                            .setPlaceholder('e.g. Revenue share, 1000 Robux/task, Negotiable, Voluntary...')
                            .setMaxLength(150)
                            .setRequired(true),
                    ),
                );

            await interaction.showModal(modal);

            // ── 3. Await modal submission ─────────────────────────────────────
            const submitted = await interaction
                .awaitModalSubmit({
                    filter: i =>
                        i.customId === 'hirable_submit_modal' &&
                        i.user.id === interaction.user.id,
                    time: 300_000,
                })
                .catch(() => null);

            if (!submitted) return;

            await submitted.deferReply({ flags: MessageFlags.Ephemeral });

            // ── 4. Build data object ──────────────────────────────────────────
            const hirableData = {
                role:         roleValue,
                about:        submitted.fields.getTextInputValue('hirable_about').trim(),
                portfolio:    submitted.fields.getTextInputValue('hirable_portfolio')?.trim() || null,
                availability: submitted.fields.getTextInputValue('hirable_availability').trim(),
                rate:         submitted.fields.getTextInputValue('hirable_rate').trim(),
                hasImage:     !!(attachment?.contentType?.startsWith('image/')),
                imageUrl:     attachment?.url ?? null,
            };

            // ── 5. Find #hirable-logs ─────────────────────────────────────────
            const logsChannel = await findChannel(interaction.guild, HIRABLE_LOGS_CHANNEL_NAME);
            if (!logsChannel) {
                logger.warn('hirable-logs channel not found', { guildId: interaction.guildId });
                return await submitted.editReply({
                    embeds: [errorEmbed(
                        'Setup Error',
                        `The \`#${HIRABLE_LOGS_CHANNEL_NAME}\` channel could not be found. Please ask an administrator to create it.`,
                    )],
                });
            }

            const postId = generatePostId();

            // ── 6. Post to #hirable-logs ──────────────────────────────────────
            const logImage = await fetchImageAttachment(hirableData);
            const logMessage = await logsChannel.send({
                embeds:     [buildLogEmbed(hirableData, interaction.user, postId, 'pending')],
                components: [buildApprovalButtons(postId, false)],
                ...(logImage ? { files: [logImage] } : {}),
            });

            // Confirm to the submitter
            await submitted.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle('Listing Submitted')
                        .setDescription(
                            `Your hirable listing has been sent to the moderation team for review.\n` +
                            `You will receive a DM once a decision has been made.`,
                        )
                        .setColor(COLOR_APPROVED)
                        .addFields(
                            { name: 'Role',         value: ROLE_LABELS[roleValue], inline: true },
                            { name: 'Availability', value: hirableData.availability, inline: true },
                            { name: 'Rate',         value: hirableData.rate,         inline: true },
                        )
                        .setTimestamp(),
                ],
            });

            logger.info('Hirable listing submitted for review', {
                userId:      interaction.user.id,
                role:        roleValue,
                guildId:     interaction.guildId,
                logMessageId: logMessage.id,
                postId,
            });

            // ── 7. Collect approve / reject from staff ────────────────────────
            const collector = logsChannel.createMessageComponentCollector({
                componentType: ComponentType.Button,
                filter: i =>
                    i.message.id === logMessage.id &&
                    (
                        i.customId === `hirable_approve_${postId}` ||
                        i.customId === `hirable_reject_${postId}`
                    ),
                max:  1,
                time: 7 * 24 * 60 * 60 * 1000, // 7 days
            });

            collector.on('collect', async btnInteraction => {

                // ── APPROVE ───────────────────────────────────────────────────
                if (btnInteraction.customId === `hirable_approve_${postId}`) {
                    await btnInteraction.deferUpdate();

                    // Update log: approved, buttons disabled
                    const updatedLogImage = await fetchImageAttachment(hirableData);
                    await logMessage.edit({
                        embeds:     [buildLogEmbed(hirableData, interaction.user, postId, 'approved', btnInteraction.user.tag)],
                        components: [buildApprovalButtons(postId, true)],
                        ...(updatedLogImage ? { files: [updatedLogImage] } : {}),
                    }).catch(() => {});

                    // Route to correct #hirable-* channel
                    const destChannelName = DESTINATION_CHANNELS[hirableData.role];
                    const destChannel     = destChannelName
                        ? await findChannel(interaction.guild, destChannelName)
                        : null;

                    if (destChannel) {
                        const publicImage = await fetchImageAttachment(hirableData);
                        await destChannel.send({
                            embeds: [buildPublicEmbed(hirableData, interaction.user, postId)],
                            ...(publicImage ? { files: [publicImage] } : {}),
                        });
                    } else {
                        logger.warn(`Destination hirable channel not found for role: ${hirableData.role}`, {
                            guildId:  interaction.guildId,
                            expected: destChannelName,
                        });
                    }

                    // DM the developer
                    try {
                        const destChannelObj = destChannelName
                            ? await findChannel(interaction.guild, destChannelName)
                            : null;

                        await interaction.user.send({
                            embeds: [
                                new EmbedBuilder()
                                    .setTitle('Hirable Listing Approved')
                                    .setDescription(
                                        `Your listing has been approved and posted in **${interaction.guild.name}**` +
                                        (destChannelObj ? ` in <#${destChannelObj.id}>.` : '.'),
                                    )
                                    .setColor(COLOR_APPROVED)
                                    .addFields(
                                        { name: 'Role',        value: ROLE_LABELS[hirableData.role], inline: true },
                                        { name: 'Reviewed by', value: btnInteraction.user.tag,        inline: true },
                                    )
                                    .setFooter({ text: 'Good luck — teams will be able to see your listing and reach out.' })
                                    .setTimestamp(),
                            ],
                        });
                    } catch {
                        logger.info('Could not DM hirable submitter (DMs closed)', { userId: interaction.user.id });
                    }

                    logger.info('Hirable listing approved', {
                        moderatorId: btnInteraction.user.id,
                        submitterId: interaction.user.id,
                        role:        hirableData.role,
                        guildId:     interaction.guildId,
                        postId,
                    });
                }

                // ── REJECT ────────────────────────────────────────────────────
                if (btnInteraction.customId === `hirable_reject_${postId}`) {
                    // Ask the moderator for a reason
                    const rejectModal = new ModalBuilder()
                        .setCustomId(`hirable_reject_modal_${postId}`)
                        .setTitle('Reject Hirable Listing')
                        .addComponents(
                            new ActionRowBuilder().addComponents(
                                new TextInputBuilder()
                                    .setCustomId('reject_reason')
                                    .setLabel('Reason for Rejection')
                                    .setStyle(TextInputStyle.Paragraph)
                                    .setPlaceholder('Explain why this listing was not approved...')
                                    .setMinLength(10)
                                    .setMaxLength(1000)
                                    .setRequired(true),
                            ),
                        );

                    await btnInteraction.showModal(rejectModal);

                    const rejectSubmit = await btnInteraction
                        .awaitModalSubmit({
                            filter: i =>
                                i.customId === `hirable_reject_modal_${postId}` &&
                                i.user.id === btnInteraction.user.id,
                            time: 120_000,
                        })
                        .catch(() => null);

                    if (!rejectSubmit) return;

                    await rejectSubmit.deferUpdate();

                    const rejectReason = rejectSubmit.fields.getTextInputValue('reject_reason').trim();

                    // Update log: rejected, buttons disabled
                    const updatedLogImage = await fetchImageAttachment(hirableData);
                    await logMessage.edit({
                        embeds:     [buildLogEmbed(hirableData, interaction.user, postId, 'rejected', btnInteraction.user.tag)],
                        components: [buildApprovalButtons(postId, true)],
                        ...(updatedLogImage ? { files: [updatedLogImage] } : {}),
                    }).catch(() => {});

                    // DM the developer with reason + ticket button
                    const dmEmbed = new EmbedBuilder()
                        .setTitle('Hirable Listing Not Approved')
                        .setDescription(
                            `Your hirable listing was not approved in **${interaction.guild.name}**.`,
                        )
                        .setColor(COLOR_REJECTED)
                        .addFields(
                            { name: 'Role',        value: ROLE_LABELS[hirableData.role], inline: true  },
                            { name: 'Reviewed by', value: btnInteraction.user.tag,        inline: true  },
                            { name: 'Reason',      value: rejectReason,                   inline: false },
                        )
                        .setFooter({ text: 'If you believe this was a mistake, open a support ticket.' })
                        .setTimestamp();

                    const ticketButton = new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId(`hirable_ticket_${postId}`)
                            .setLabel('Open a Support Ticket')
                            .setStyle(ButtonStyle.Secondary)
                            .setDisabled(false),
                    );

                    let dmMessage = null;
                    try {
                        dmMessage = await interaction.user.send({
                            embeds:     [dmEmbed],
                            components: [ticketButton],
                        });
                    } catch {
                        logger.info('Could not DM hirable submitter (DMs closed)', { userId: interaction.user.id });
                    }

                    // Handle ticket button in DM
                    if (dmMessage) {
                        const dmCollector = dmMessage.createMessageComponentCollector({
                            componentType: ComponentType.Button,
                            filter: i =>
                                i.customId === `hirable_ticket_${postId}` &&
                                i.user.id === interaction.user.id,
                            time: 7 * 24 * 60 * 60 * 1000,
                            max:  1,
                        });

                        dmCollector.on('collect', async dmBtn => {
                            await dmBtn.reply({
                                content: `To open a support ticket, visit **${interaction.guild.name}** and use the ticket panel or \`/ticket\` command.`,
                                flags: MessageFlags.Ephemeral,
                            }).catch(() => {});
                        });

                        dmCollector.on('end', async () => {
                            await dmMessage.edit({
                                embeds:     [dmEmbed],
                                components: [
                                    new ActionRowBuilder().addComponents(
                                        new ButtonBuilder()
                                            .setCustomId(`hirable_ticket_${postId}`)
                                            .setLabel('Open a Support Ticket')
                                            .setStyle(ButtonStyle.Secondary)
                                            .setDisabled(true),
                                    ),
                                ],
                            }).catch(() => {});
                        });
                    }

                    logger.info('Hirable listing rejected', {
                        moderatorId: btnInteraction.user.id,
                        submitterId: interaction.user.id,
                        role:        hirableData.role,
                        reason:      rejectReason,
                        guildId:     interaction.guildId,
                        postId,
                    });
                }
            });

            collector.on('end', async (collected, reason) => {
                if (collected.size === 0 && reason === 'time') {
                    await logMessage.edit({ components: [buildApprovalButtons(postId, true)] }).catch(() => {});
                    logger.info('Hirable review timed out with no decision', {
                        role:    hirableData.role,
                        guildId: interaction.guildId,
                        postId,
                    });
                }
            });

        } catch (error) {
            logger.error('Error executing hirable command', {
                error:       error.message,
                stack:       error.stack,
                userId:      interaction.user.id,
                guildId:     interaction.guildId,
                commandName: 'hirable',
            });
            await handleInteractionError(interaction, error, {
                commandName: 'hirable',
                source:      'hirable_command',
            });
        }
    },
};
