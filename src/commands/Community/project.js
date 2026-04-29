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
import { errorEmbed, successEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { handleInteractionError } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

// ─── Config ───────────────────────────────────────────────────────────────────
const PROJECT_LOGS_CHANNEL_NAME = 'project-logs';
const PROJECTS_CHANNEL_NAME     = 'projects';

const COLOR_GREEN   = 0x57f287; // approved / public post
const COLOR_ORANGE  = 0xfaa61a; // pending
const COLOR_RED     = 0xed4245; // rejected

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generatePostId() {
    return Date.now().toString();
}

function hiringText(value) {
    const v = value.trim().toLowerCase();
    return ['yes', 'y', 'true', '1'].includes(v) ? 'Yes' : 'No';
}

function nowTime() {
    return new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

/**
 * The embed posted publicly in #projects.
 * Matches the reference: author at top, bold title, description body,
 * hiring + contact fields, image as embed image at bottom, post ID in footer.
 */
function buildPublicEmbed(projectData, submitter, postId) {
    const embed = new EmbedBuilder()
        .setAuthor({
            name: submitter.username,
            iconURL: submitter.displayAvatarURL({ size: 64 }),
        })
        .setTitle(projectData.name)
        .setDescription(projectData.description)
        .setColor(COLOR_GREEN)
        .addFields(
            { name: 'Hiring Developers', value: hiringText(projectData.hiring), inline: true },
            { name: 'Contact',           value: `<@${submitter.id}>`,           inline: true },
        )
        .setFooter({
            text: `Post ID: (${postId}) • Approved • Today at ${nowTime()}`,
        });

    if (projectData.hasImage) {
        embed.setImage('attachment://project_thumbnail.png');
    }

    return embed;
}

/**
 * The embed sent to #project-logs for moderator review.
 */
function buildLogEmbed(projectData, submitter, postId, status = 'pending', reviewerTag = null) {
    const colorMap  = { pending: COLOR_ORANGE, approved: COLOR_GREEN, rejected: COLOR_RED };
    const statusMap = { pending: 'Pending Review', approved: 'Approved', rejected: 'Rejected' };

    const embed = new EmbedBuilder()
        .setAuthor({
            name: submitter.username,
            iconURL: submitter.displayAvatarURL({ size: 64 }),
        })
        .setTitle(`Project Submission — ${projectData.name}`)
        .setColor(colorMap[status] ?? COLOR_ORANGE)
        .addFields(
            { name: 'Project Name',      value: projectData.name,                        inline: false },
            { name: 'Description',       value: projectData.description.slice(0, 1024),  inline: false },
            { name: 'Hiring Developers', value: hiringText(projectData.hiring),           inline: true  },
            { name: 'Submitted By',      value: `<@${submitter.id}> (${submitter.tag})`, inline: true  },
            { name: 'Status',            value: statusMap[status] ?? 'Pending Review',   inline: true  },
        )
        .setTimestamp()
        .setFooter({
            text: `Post ID: (${postId})${reviewerTag ? ` • Reviewed by ${reviewerTag}` : ''}`,
        });

    if (projectData.hasImage) {
        embed.setImage('attachment://project_thumbnail.png');
    }

    return embed;
}

function buildApprovalButtons(disabled = false) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('project_approve')
            .setLabel('Approve')
            .setStyle(ButtonStyle.Success)
            .setDisabled(disabled),
        new ButtonBuilder()
            .setCustomId('project_reject')
            .setLabel('Reject')
            .setStyle(ButtonStyle.Danger)
            .setDisabled(disabled),
    );
}

async function findChannel(guild, channelName) {
    return guild.channels.cache.find(c => c.name === channelName && c.isTextBased()) ?? null;
}

/**
 * Fetches the image from Discord's CDN and returns an AttachmentBuilder,
 * or null if the fetch fails or no image is set.
 */
async function fetchImageAttachment(projectData) {
    if (!projectData.hasImage || !projectData.imageUrl) return null;
    try {
        const res    = await fetch(projectData.imageUrl);
        const buffer = Buffer.from(await res.arrayBuffer());
        return new AttachmentBuilder(buffer, { name: 'project_thumbnail.png' });
    } catch (err) {
        logger.warn('Could not fetch project thumbnail', { error: err.message });
        return null;
    }
}

// ─── Command ──────────────────────────────────────────────────────────────────

export default {
    data: new SlashCommandBuilder()
        .setName('project')
        .setDescription('Submit your Roblox project to the community.')
        .setDMPermission(false)
        .addAttachmentOption(option =>
            option
                .setName('thumbnail')
                .setDescription('Upload a screenshot or banner image for your project.')
                .setRequired(false),
        ),

    async execute(interaction, guildConfig, client) {
        try {
            // ── 1. Read attachment before the modal (option data is lost after showModal) ──
            const attachment = interaction.options.getAttachment('thumbnail');

            if (attachment && !attachment.contentType?.startsWith('image/')) {
                return await interaction.reply({
                    embeds: [errorEmbed('Invalid Attachment', 'Please upload an image file (PNG, JPG, GIF, etc.).')],
                    flags: MessageFlags.Ephemeral,
                });
            }

            // ── 2. Show submission modal ──────────────────────────────────────
            const modal = new ModalBuilder()
                .setCustomId('project_submit_modal')
                .setTitle('Submit Your Project')
                .addComponents(
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId('project_name')
                            .setLabel('Project Name')
                            .setStyle(TextInputStyle.Short)
                            .setPlaceholder('e.g. Dark vs Light')
                            .setMaxLength(100)
                            .setMinLength(2)
                            .setRequired(true),
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId('project_description')
                            .setLabel('Project Description')
                            .setStyle(TextInputStyle.Paragraph)
                            .setPlaceholder('Describe your game — what it is, its current state, any links, etc.')
                            .setMaxLength(1800)
                            .setMinLength(20)
                            .setRequired(true),
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId('project_hiring')
                            .setLabel('Are you hiring developers? (Yes / No)')
                            .setStyle(TextInputStyle.Short)
                            .setPlaceholder('Yes or No')
                            .setMaxLength(3)
                            .setRequired(true),
                    ),
                );

            await interaction.showModal(modal);

            // ── 3. Await modal submit ─────────────────────────────────────────
            const submitted = await interaction
                .awaitModalSubmit({
                    filter: i =>
                        i.customId === 'project_submit_modal' &&
                        i.user.id === interaction.user.id,
                    time: 300_000,
                })
                .catch(() => null);

            if (!submitted) return;

            await submitted.deferReply({ flags: MessageFlags.Ephemeral });

            const projectData = {
                name:        submitted.fields.getTextInputValue('project_name').trim(),
                description: submitted.fields.getTextInputValue('project_description').trim(),
                hiring:      submitted.fields.getTextInputValue('project_hiring').trim(),
                hasImage:    !!(attachment?.contentType?.startsWith('image/')),
                imageUrl:    attachment?.url ?? null,
            };

            // ── 4. Find mod log channel ───────────────────────────────────────
            const logsChannel = await findChannel(interaction.guild, PROJECT_LOGS_CHANNEL_NAME);
            if (!logsChannel) {
                logger.warn('project-logs channel not found', { guildId: interaction.guildId });
                return await submitted.editReply({
                    embeds: [errorEmbed(
                        'Setup Error',
                        `The #${PROJECT_LOGS_CHANNEL_NAME} channel could not be found. Please ask an administrator to create it.`,
                    )],
                });
            }

            const postId = generatePostId();

            // ── 5. Post to #project-logs ──────────────────────────────────────
            const imageAttachment = await fetchImageAttachment(projectData);
            const logPayload = {
                embeds:     [buildLogEmbed(projectData, interaction.user, postId, 'pending')],
                components: [buildApprovalButtons(false)],
                ...(imageAttachment ? { files: [imageAttachment] } : {}),
            };

            const logMessage = await logsChannel.send(logPayload);

            await submitted.editReply({
                embeds: [successEmbed(
                    'Project Submitted',
                    'Your project has been sent to the moderation team for review. You will receive a DM once a decision has been made.',
                )],
            });

            logger.info('Project submitted for review', {
                userId: interaction.user.id,
                projectName: projectData.name,
                guildId: interaction.guildId,
                logMessageId: logMessage.id,
                postId,
            });

            // ── 6. Collect approve / reject ───────────────────────────────────
            const collector = logsChannel.createMessageComponentCollector({
                componentType: ComponentType.Button,
                filter: i =>
                    i.message.id === logMessage.id &&
                    (i.customId === 'project_approve' || i.customId === 'project_reject'),
                max:  1,
                time: 7 * 24 * 60 * 60 * 1000, // 7 days
            });

            collector.on('collect', async btnInteraction => {

                // ── APPROVE ───────────────────────────────────────────────────
                if (btnInteraction.customId === 'project_approve') {
                    await btnInteraction.deferUpdate();

                    // Update log: mark approved, disable buttons
                    const updatedImage = await fetchImageAttachment(projectData);
                    await logMessage.edit({
                        embeds:     [buildLogEmbed(projectData, interaction.user, postId, 'approved', btnInteraction.user.tag)],
                        components: [buildApprovalButtons(true)],
                        ...(updatedImage ? { files: [updatedImage] } : {}),
                    }).catch(() => {});

                    // Post in #projects
                    const projectsChannel = await findChannel(interaction.guild, PROJECTS_CHANNEL_NAME);
                    if (projectsChannel) {
                        const publicImage = await fetchImageAttachment(projectData);
                        await projectsChannel.send({
                            embeds: [buildPublicEmbed(projectData, interaction.user, postId)],
                            ...(publicImage ? { files: [publicImage] } : {}),
                        });
                    } else {
                        logger.warn('projects channel not found', { guildId: interaction.guildId });
                    }

                    // DM submitter
                    try {
                        await interaction.user.send({
                            embeds: [
                                new EmbedBuilder()
                                    .setTitle('Project Approved')
                                    .setDescription(
                                        `Your project **${projectData.name}** has been approved and posted in **${interaction.guild.name}**.`,
                                    )
                                    .setColor(COLOR_GREEN)
                                    .addFields(
                                        { name: 'Project',     value: projectData.name,        inline: true },
                                        { name: 'Reviewed by', value: btnInteraction.user.tag, inline: true },
                                    )
                                    .setTimestamp(),
                            ],
                        });
                    } catch {
                        logger.info('Could not DM submitter (DMs closed)', { userId: interaction.user.id });
                    }

                    logger.info('Project approved', {
                        moderatorId: btnInteraction.user.id,
                        submitterId: interaction.user.id,
                        projectName: projectData.name,
                        guildId: interaction.guildId,
                        postId,
                    });
                }

                // ── REJECT ────────────────────────────────────────────────────
                if (btnInteraction.customId === 'project_reject') {
                    const rejectModal = new ModalBuilder()
                        .setCustomId('project_reject_modal')
                        .setTitle('Reject Project')
                        .addComponents(
                            new ActionRowBuilder().addComponents(
                                new TextInputBuilder()
                                    .setCustomId('reject_reason')
                                    .setLabel('Reason for Rejection')
                                    .setStyle(TextInputStyle.Paragraph)
                                    .setPlaceholder('Explain why this project was not approved...')
                                    .setMinLength(10)
                                    .setMaxLength(1000)
                                    .setRequired(true),
                            ),
                        );

                    await btnInteraction.showModal(rejectModal);

                    const rejectSubmit = await btnInteraction
                        .awaitModalSubmit({
                            filter: i =>
                                i.customId === 'project_reject_modal' &&
                                i.user.id === btnInteraction.user.id,
                            time: 120_000,
                        })
                        .catch(() => null);

                    if (!rejectSubmit) return;

                    await rejectSubmit.deferUpdate();

                    const rejectReason = rejectSubmit.fields.getTextInputValue('reject_reason').trim();

                    // Update log: mark rejected, disable buttons
                    const updatedImage = await fetchImageAttachment(projectData);
                    await logMessage.edit({
                        embeds:     [buildLogEmbed(projectData, interaction.user, postId, 'rejected', btnInteraction.user.tag)],
                        components: [buildApprovalButtons(true)],
                        ...(updatedImage ? { files: [updatedImage] } : {}),
                    }).catch(() => {});

                    // DM submitter with reason + ticket button
                    const ticketButton = new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId('project_open_ticket')
                            .setLabel('Open a Support Ticket')
                            .setStyle(ButtonStyle.Secondary)
                            .setDisabled(false),
                    );

                    const dmEmbed = new EmbedBuilder()
                        .setTitle('Project Not Approved')
                        .setDescription(
                            `Your project **${projectData.name}** was not approved in **${interaction.guild.name}**.`,
                        )
                        .setColor(COLOR_RED)
                        .addFields(
                            { name: 'Project',     value: projectData.name,        inline: true },
                            { name: 'Reviewed by', value: btnInteraction.user.tag, inline: true },
                            { name: 'Reason',      value: rejectReason,            inline: false },
                        )
                        .setFooter({ text: 'If you believe this was a mistake, open a support ticket.' })
                        .setTimestamp();

                    let dmMessage = null;
                    try {
                        dmMessage = await interaction.user.send({ embeds: [dmEmbed], components: [ticketButton] });
                    } catch {
                        logger.info('Could not DM submitter (DMs closed)', { userId: interaction.user.id });
                    }

                    // Handle ticket button in DM
                    if (dmMessage) {
                        const dmCollector = dmMessage.createMessageComponentCollector({
                            componentType: ComponentType.Button,
                            filter: i =>
                                i.customId === 'project_open_ticket' &&
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
                                            .setCustomId('project_open_ticket')
                                            .setLabel('Open a Support Ticket')
                                            .setStyle(ButtonStyle.Secondary)
                                            .setDisabled(true),
                                    ),
                                ],
                            }).catch(() => {});
                        });
                    }

                    logger.info('Project rejected', {
                        moderatorId: btnInteraction.user.id,
                        submitterId: interaction.user.id,
                        projectName: projectData.name,
                        reason:      rejectReason,
                        guildId:     interaction.guildId,
                        postId,
                    });
                }
            });

            collector.on('end', async (collected, reason) => {
                if (collected.size === 0 && reason === 'time') {
                    await logMessage.edit({ components: [buildApprovalButtons(true)] }).catch(() => {});
                    logger.info('Project review timed out with no decision', {
                        projectName: projectData.name,
                        guildId: interaction.guildId,
                        postId,
                    });
                }
            });

        } catch (error) {
            logger.error('Error executing project command', {
                error:       error.message,
                stack:       error.stack,
                userId:      interaction.user.id,
                guildId:     interaction.guildId,
                commandName: 'project',
            });
            await handleInteractionError(interaction, error, {
                commandName: 'project',
                source:      'project_command',
            });
        }
    },
};
