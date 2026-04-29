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

const HIRING_LOGS_CHANNEL_NAME  = 'hiring-logs';
const PROJECTS_CHANNEL_NAME     = 'projects';

// Where approved posts get sent, keyed by role value
const DESTINATION_CHANNELS = {
    scripting:   'hiring-scripter',
    builder:     'hiring-builder',
    ui_designer: 'hiring-ui-designer',
    animator:    'hiring-animator',
};

// Human-readable role labels
const ROLE_LABELS = {
    scripting:   'Scripting',
    builder:     'Builder',
    ui_designer: 'UI Designer',
    animator:    'Animator',
};

// Accent color per role for the public post
const ROLE_COLORS = {
    scripting:   0x5865f2, // indigo  — scripting/code
    builder:     0xfaa61a, // amber   — building
    ui_designer: 0xeb459e, // pink    — design
    animator:    0x57f287, // green   — animation
};

const COLOR_PENDING  = 0x4f545c; // grey
const COLOR_APPROVED = 0x57f287; // green
const COLOR_REJECTED = 0xed4245; // red

// How far back (ms) to scan #projects when looking for a linked post
const PROJECT_SEARCH_LIMIT = 100; // messages fetched per scan

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generatePostId() {
    // Slightly more readable than raw epoch — still unique
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
 * Scans #projects for a message whose embed title matches the project name.
 * Returns { found: true, url } or { found: false }.
 */
async function findProjectPost(guild, projectName) {
    const channel = await findChannel(guild, PROJECTS_CHANNEL_NAME);
    if (!channel) return { found: false };

    try {
        const messages = await channel.messages.fetch({ limit: PROJECT_SEARCH_LIMIT });
        const normalised = projectName.trim().toLowerCase();

        const match = messages.find(msg =>
            msg.embeds?.some(e => e.title?.trim().toLowerCase() === normalised),
        );

        if (match) return { found: true, url: match.url, messageId: match.id };
    } catch (err) {
        logger.warn('Failed to scan #projects for project link', { error: err.message });
    }

    return { found: false };
}

/**
 * Fetches an image URL from Discord's CDN and returns an AttachmentBuilder.
 * Returns null if no image is set or the fetch fails.
 */
async function fetchImageAttachment(hiringData, filename = 'hiring_thumbnail.png') {
    if (!hiringData.hasImage || !hiringData.imageUrl) return null;
    try {
        const res    = await fetch(hiringData.imageUrl);
        const buffer = Buffer.from(await res.arrayBuffer());
        return new AttachmentBuilder(buffer, { name: filename });
    } catch (err) {
        logger.warn('Could not fetch hiring thumbnail', { error: err.message });
        return null;
    }
}

// ─── Embed Builders ───────────────────────────────────────────────────────────

/**
 * Public embed posted in the appropriate #hiring-* channel once approved.
 */
function buildPublicEmbed(hiringData, submitter, postId) {
    const roleLabel = ROLE_LABELS[hiringData.role] ?? hiringData.role;
    const roleColor = ROLE_COLORS[hiringData.role] ?? COLOR_APPROVED;

    const desc = [
        hiringData.description,
        '',
        `**Payment**\n${hiringData.payment}`,
        '',
        `**Contact**\n<@${submitter.id}>`,
    ].join('\n');

    const embed = new EmbedBuilder()
        .setAuthor({
            name:    submitter.username,
            iconURL: submitter.displayAvatarURL({ size: 64 }),
        })
        .setTitle(`${hiringData.projectName} — Looking for ${roleLabel}`)
        .setDescription(desc)
        .setColor(roleColor)
        .addFields(
            { name: 'Role',    value: roleLabel,             inline: true },
            { name: 'Project', value: hiringData.projectName, inline: true },
        )
        .setFooter({
            text: `Post ID: (${postId}) • Approved • Today at ${nowTime()}`,
        });

    if (hiringData.projectUrl) {
        embed.addFields({ name: 'Project Post', value: `[View in #projects](${hiringData.projectUrl})`, inline: true });
    }

    if (hiringData.hasImage) {
        embed.setImage('attachment://hiring_thumbnail.png');
    }

    return embed;
}

/**
 * Staff-facing embed posted in #hiring-logs for review.
 */
function buildLogEmbed(hiringData, submitter, postId, status = 'pending', reviewerTag = null) {
    const colorMap  = { pending: COLOR_PENDING, approved: COLOR_APPROVED, rejected: COLOR_REJECTED };
    const statusMap = { pending: 'Pending Review', approved: 'Approved', rejected: 'Rejected' };
    const roleLabel = ROLE_LABELS[hiringData.role] ?? hiringData.role;

    const embed = new EmbedBuilder()
        .setAuthor({
            name:    submitter.username,
            iconURL: submitter.displayAvatarURL({ size: 64 }),
        })
        .setTitle(`Hiring Submission — ${hiringData.projectName}`)
        .setColor(colorMap[status] ?? COLOR_PENDING)
        .addFields(
            { name: 'Role Sought',   value: roleLabel,                                       inline: true  },
            { name: 'Project',       value: hiringData.projectName,                           inline: true  },
            { name: 'Project Linked',value: hiringData.projectUrl
                                            ? `[View post](${hiringData.projectUrl})`
                                            : 'Not found in #projects',                       inline: true  },
            { name: 'Description',   value: hiringData.description.slice(0, 1024),            inline: false },
            { name: 'Payment',       value: hiringData.payment,                               inline: true  },
            { name: 'Submitted By',  value: `<@${submitter.id}> (${submitter.tag})`,          inline: true  },
            { name: 'Status',        value: statusMap[status] ?? 'Pending Review',            inline: true  },
        )
        .setTimestamp()
        .setFooter({
            text: `Post ID: (${postId})${reviewerTag ? ` • Reviewed by ${reviewerTag}` : ''}`,
        });

    if (hiringData.hasImage) {
        embed.setImage('attachment://hiring_thumbnail.png');
    }

    return embed;
}

/**
 * Builds the two-button approval row, optionally disabled.
 */
function buildApprovalButtons(postId, disabled = false) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`hiring_approve_${postId}`)
            .setLabel('Approve')
            .setStyle(ButtonStyle.Success)
            .setDisabled(disabled),
        new ButtonBuilder()
            .setCustomId(`hiring_reject_${postId}`)
            .setLabel('Reject')
            .setStyle(ButtonStyle.Danger)
            .setDisabled(disabled),
    );
}

// ─── Command ──────────────────────────────────────────────────────────────────

export default {
    data: new SlashCommandBuilder()
        .setName('hiring')
        .setDescription('Post a hiring listing for your Roblox project.')
        .setDMPermission(false)
        .addStringOption(option =>
            option
                .setName('role')
                .setDescription('What type of developer are you looking for?')
                .setRequired(true)
                .addChoices(
                    { name: 'Scripting',   value: 'scripting'   },
                    { name: 'Builder',     value: 'builder'     },
                    { name: 'UI Designer', value: 'ui_designer' },
                    { name: 'Animator',    value: 'animator'    },
                ),
        )
        .addStringOption(option =>
            option
                .setName('project')
                .setDescription('Exact name of your project (must be submitted via /project first).')
                .setRequired(true)
                .setMaxLength(100),
        )
        .addAttachmentOption(option =>
            option
                .setName('thumbnail')
                .setDescription('Optional banner or screenshot for your listing.')
                .setRequired(false),
        ),

    async execute(interaction, guildConfig, client) {
        try {
            // ── 1. Read options before showModal — they vanish after ──────────
            const roleValue   = interaction.options.getString('role');
            const projectName = interaction.options.getString('project').trim();
            const attachment  = interaction.options.getAttachment('thumbnail');

            // Validate attachment type immediately
            if (attachment && !attachment.contentType?.startsWith('image/')) {
                return await interaction.reply({
                    embeds: [errorEmbed('Invalid Attachment', 'The thumbnail must be an image file (PNG, JPG, GIF, etc.).')],
                    flags: MessageFlags.Ephemeral,
                });
            }

            // ── 2. Show the form modal ────────────────────────────────────────
            const modal = new ModalBuilder()
                .setCustomId('hiring_submit_modal')
                .setTitle('Post a Hiring Listing')
                .addComponents(
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId('hiring_description')
                            .setLabel('What are you looking for?')
                            .setStyle(TextInputStyle.Paragraph)
                            .setPlaceholder(
                                'Describe the role, what the developer will be working on, experience needed, etc.',
                            )
                            .setMinLength(30)
                            .setMaxLength(1500)
                            .setRequired(true),
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId('hiring_payment')
                            .setLabel('Payment / Compensation')
                            .setStyle(TextInputStyle.Short)
                            .setPlaceholder('e.g. Revenue share, Robux, Voluntary, Negotiable...')
                            .setMaxLength(150)
                            .setRequired(true),
                    ),
                );

            await interaction.showModal(modal);

            // ── 3. Await modal submission (5 min window) ──────────────────────
            const submitted = await interaction
                .awaitModalSubmit({
                    filter: i =>
                        i.customId === 'hiring_submit_modal' &&
                        i.user.id === interaction.user.id,
                    time: 300_000,
                })
                .catch(() => null);

            if (!submitted) return;

            await submitted.deferReply({ flags: MessageFlags.Ephemeral });

            // ── 4. Scan #projects for a matching post ─────────────────────────
            const projectResult = await findProjectPost(interaction.guild, projectName);

            // Hard error if no project post found — tell them exactly what to do
            if (!projectResult.found) {
                return await submitted.editReply({
                    embeds: [
                        new EmbedBuilder()
                            .setTitle('Project Not Found')
                            .setDescription(
                                `No approved project named **"${projectName}"** could be found in <#${(await findChannel(interaction.guild, PROJECTS_CHANNEL_NAME))?.id ?? PROJECTS_CHANNEL_NAME}>.\n\n` +
                                `Make sure the name matches **exactly** as it appears in the channel.\n\n` +
                                `If you haven't submitted your project yet, use \`/project\` first and wait for it to be approved before posting a hiring listing.`,
                            )
                            .setColor(COLOR_REJECTED)
                            .addFields({
                                name: 'You searched for',
                                value: `"${projectName}"`,
                                inline: false,
                            })
                            .setFooter({ text: 'Tip: Project names are case-insensitive but must otherwise match exactly.' })
                            .setTimestamp(),
                    ],
                });
            }

            // ── 5. Build hiring data object ───────────────────────────────────
            const hiringData = {
                role:        roleValue,
                projectName: projectName,
                projectUrl:  projectResult.url ?? null,
                description: submitted.fields.getTextInputValue('hiring_description').trim(),
                payment:     submitted.fields.getTextInputValue('hiring_payment').trim(),
                hasImage:    !!(attachment?.contentType?.startsWith('image/')),
                imageUrl:    attachment?.url ?? null,
            };

            // ── 6. Find #hiring-logs ──────────────────────────────────────────
            const logsChannel = await findChannel(interaction.guild, HIRING_LOGS_CHANNEL_NAME);
            if (!logsChannel) {
                logger.warn('hiring-logs channel not found', { guildId: interaction.guildId });
                return await submitted.editReply({
                    embeds: [errorEmbed(
                        'Setup Error',
                        `The \`#${HIRING_LOGS_CHANNEL_NAME}\` channel could not be found. Please ask an administrator to create it.`,
                    )],
                });
            }

            const postId = generatePostId();

            // ── 7. Post to #hiring-logs ───────────────────────────────────────
            const logImage = await fetchImageAttachment(hiringData);
            const logMessage = await logsChannel.send({
                embeds:     [buildLogEmbed(hiringData, interaction.user, postId, 'pending')],
                components: [buildApprovalButtons(postId, false)],
                ...(logImage ? { files: [logImage] } : {}),
            });

            // Confirm to the submitter
            await submitted.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle('Listing Submitted')
                        .setDescription(
                            `Your hiring listing for **${hiringData.projectName}** has been sent for review.\n` +
                            `You will receive a DM once a decision has been made.`,
                        )
                        .setColor(COLOR_APPROVED)
                        .addFields(
                            { name: 'Role',    value: ROLE_LABELS[roleValue], inline: true },
                            { name: 'Project', value: projectName,             inline: true },
                            { name: 'Project Post', value: `[View in #projects](${projectResult.url})`, inline: true },
                        )
                        .setTimestamp(),
                ],
            });

            logger.info('Hiring listing submitted for review', {
                userId:      interaction.user.id,
                role:        roleValue,
                projectName: projectName,
                projectUrl:  projectResult.url,
                guildId:     interaction.guildId,
                logMessageId: logMessage.id,
                postId,
            });

            // ── 8. Collect approve / reject from staff ────────────────────────
            const collector = logsChannel.createMessageComponentCollector({
                componentType: ComponentType.Button,
                filter: i =>
                    i.message.id === logMessage.id &&
                    (i.customId === `hiring_approve_${postId}` || i.customId === `hiring_reject_${postId}`),
                max:  1,
                time: 7 * 24 * 60 * 60 * 1000, // 7 days
            });

            collector.on('collect', async btnInteraction => {

                // ── APPROVE ───────────────────────────────────────────────────
                if (btnInteraction.customId === `hiring_approve_${postId}`) {
                    await btnInteraction.deferUpdate();

                    // Update log embed: approved + buttons disabled
                    const updatedLogImage = await fetchImageAttachment(hiringData);
                    await logMessage.edit({
                        embeds:     [buildLogEmbed(hiringData, interaction.user, postId, 'approved', btnInteraction.user.tag)],
                        components: [buildApprovalButtons(postId, true)],
                        ...(updatedLogImage ? { files: [updatedLogImage] } : {}),
                    }).catch(() => {});

                    // Route to the correct #hiring-* channel
                    const destChannelName = DESTINATION_CHANNELS[hiringData.role];
                    const destChannel     = destChannelName
                        ? await findChannel(interaction.guild, destChannelName)
                        : null;

                    if (destChannel) {
                        const publicImage = await fetchImageAttachment(hiringData);
                        await destChannel.send({
                            embeds: [buildPublicEmbed(hiringData, interaction.user, postId)],
                            ...(publicImage ? { files: [publicImage] } : {}),
                        });
                    } else {
                        logger.warn(`Destination channel not found for role: ${hiringData.role}`, {
                            guildId: interaction.guildId,
                            expected: destChannelName,
                        });
                    }

                    // DM the submitter
                    try {
                        await interaction.user.send({
                            embeds: [
                                new EmbedBuilder()
                                    .setTitle('Hiring Listing Approved')
                                    .setDescription(
                                        `Your hiring listing for **${hiringData.projectName}** has been approved and posted in **${interaction.guild.name}**` +
                                        (destChannelName ? ` in <#${(await findChannel(interaction.guild, destChannelName))?.id ?? destChannelName}>.` : '.'),
                                    )
                                    .setColor(COLOR_APPROVED)
                                    .addFields(
                                        { name: 'Role',        value: ROLE_LABELS[hiringData.role], inline: true },
                                        { name: 'Project',     value: hiringData.projectName,        inline: true },
                                        { name: 'Reviewed by', value: btnInteraction.user.tag,       inline: true },
                                    )
                                    .setTimestamp(),
                            ],
                        });
                    } catch {
                        logger.info('Could not DM hiring submitter (DMs closed)', { userId: interaction.user.id });
                    }

                    logger.info('Hiring listing approved', {
                        moderatorId: btnInteraction.user.id,
                        submitterId: interaction.user.id,
                        role:        hiringData.role,
                        projectName: hiringData.projectName,
                        guildId:     interaction.guildId,
                        postId,
                    });
                }

                // ── REJECT ────────────────────────────────────────────────────
                if (btnInteraction.customId === `hiring_reject_${postId}`) {
                    // Ask moderator for a reason
                    const rejectModal = new ModalBuilder()
                        .setCustomId(`hiring_reject_modal_${postId}`)
                        .setTitle('Reject Hiring Listing')
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
                                i.customId === `hiring_reject_modal_${postId}` &&
                                i.user.id === btnInteraction.user.id,
                            time: 120_000,
                        })
                        .catch(() => null);

                    if (!rejectSubmit) return;

                    await rejectSubmit.deferUpdate();

                    const rejectReason = rejectSubmit.fields.getTextInputValue('reject_reason').trim();

                    // Update log embed: rejected + buttons disabled
                    const updatedLogImage = await fetchImageAttachment(hiringData);
                    await logMessage.edit({
                        embeds:     [buildLogEmbed(hiringData, interaction.user, postId, 'rejected', btnInteraction.user.tag)],
                        components: [buildApprovalButtons(postId, true)],
                        ...(updatedLogImage ? { files: [updatedLogImage] } : {}),
                    }).catch(() => {});

                    // DM submitter with reason + ticket button
                    const dmEmbed = new EmbedBuilder()
                        .setTitle('Hiring Listing Not Approved')
                        .setDescription(
                            `Your hiring listing for **${hiringData.projectName}** was not approved in **${interaction.guild.name}**.`,
                        )
                        .setColor(COLOR_REJECTED)
                        .addFields(
                            { name: 'Role',        value: ROLE_LABELS[hiringData.role], inline: true },
                            { name: 'Project',     value: hiringData.projectName,        inline: true },
                            { name: 'Reviewed by', value: btnInteraction.user.tag,       inline: true },
                            { name: 'Reason',      value: rejectReason,                  inline: false },
                        )
                        .setFooter({ text: 'If you believe this was a mistake, open a support ticket.' })
                        .setTimestamp();

                    const ticketButton = new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId(`hiring_ticket_${postId}`)
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
                        logger.info('Could not DM hiring submitter (DMs closed)', { userId: interaction.user.id });
                    }

                    // Listen for ticket button press in DM
                    if (dmMessage) {
                        const dmCollector = dmMessage.createMessageComponentCollector({
                            componentType: ComponentType.Button,
                            filter: i =>
                                i.customId === `hiring_ticket_${postId}` &&
                                i.user.id === interaction.user.id,
                            time: 7 * 24 * 60 * 60 * 1000,
                            max:  1,
                        });

                        dmCollector.on('collect', async dmBtn => {
                            await dmBtn.reply({
                                content:
                                    `To open a support ticket, visit **${interaction.guild.name}** and use the ticket panel or \`/ticket\` command.`,
                                flags: MessageFlags.Ephemeral,
                            }).catch(() => {});
                        });

                        dmCollector.on('end', async () => {
                            await dmMessage.edit({
                                embeds:     [dmEmbed],
                                components: [
                                    new ActionRowBuilder().addComponents(
                                        new ButtonBuilder()
                                            .setCustomId(`hiring_ticket_${postId}`)
                                            .setLabel('Open a Support Ticket')
                                            .setStyle(ButtonStyle.Secondary)
                                            .setDisabled(true),
                                    ),
                                ],
                            }).catch(() => {});
                        });
                    }

                    logger.info('Hiring listing rejected', {
                        moderatorId: btnInteraction.user.id,
                        submitterId: interaction.user.id,
                        role:        hiringData.role,
                        projectName: hiringData.projectName,
                        reason:      rejectReason,
                        guildId:     interaction.guildId,
                        postId,
                    });
                }
            });

            collector.on('end', async (collected, reason) => {
                if (collected.size === 0 && reason === 'time') {
                    await logMessage.edit({ components: [buildApprovalButtons(postId, true)] }).catch(() => {});
                    logger.info('Hiring review timed out with no decision', {
                        projectName: hiringData.projectName,
                        role:        hiringData.role,
                        guildId:     interaction.guildId,
                        postId,
                    });
                }
            });

        } catch (error) {
            logger.error('Error executing hiring command', {
                error:       error.message,
                stack:       error.stack,
                userId:      interaction.user.id,
                guildId:     interaction.guildId,
                commandName: 'hiring',
            });
            await handleInteractionError(interaction, error, {
                commandName: 'hiring',
                source:      'hiring_command',
            });
        }
    },
};
