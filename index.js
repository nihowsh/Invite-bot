require("dotenv").config();
const { Client, GatewayIntentBits, Partials } = require("discord.js");
const { QuickDB } = require("quick.db2"); // ✅ FIXED for Render
const dayjs = require("dayjs");
const db = new QuickDB();

// Discord client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildInvites
    ],
    partials: [Partials.GuildMember]
});

let invitesCache = new Map();

client.on("ready", async () => {
    console.log(`🔥 Logged in as ${client.user.tag}`);

    // Cache invites
    for (const guild of client.guilds.cache.values()) {
        const invites = await guild.invites.fetch().catch(() => null);
        if (invites) invitesCache.set(guild.id, invites);
    }

    registerCommands();
});

client.on("guildMemberAdd", async (member) => {
    const oldInvites = invitesCache.get(member.guild.id);
    const newInvites = await member.guild.invites.fetch().catch(() => null);

    if (!oldInvites || !newInvites) return;

    const usedInvite = newInvites.find(i => i.uses > (oldInvites.get(i.code)?.uses || 0));
    invitesCache.set(member.guild.id, newInvites);
    if (!usedInvite) return;

    const inviter = member.guild.members.cache.get(usedInvite.inviter.id);
    if (!inviter) return;

    // Check for fake invites — account age <= 3 days
    const accountAge = dayjs().diff(dayjs(member.user.createdAt), "day");
    const fake = accountAge <= 3;

    log(member.guild, 
        `👤 User joined: ${member.user.tag}\nInvited by: ${inviter.user.tag}\nAccount Age: ${accountAge} days\n${fake ? "❌ Invite ignored" : "✔ Invite counted"}`
    );

    if (fake) return;

    // Add invite count
    let invKey = `invites_${inviter.id}_${member.guild.id}`;
    let invites = (await db.get(invKey)) || 0;
    invites++;
    await db.set(invKey, invites);

    // Check role thresholds
    const settings = (await db.get(`rolesettings_${member.guild.id}`)) || {};

    for (const roleId in settings) {
        const needed = settings[roleId];
        const role = member.guild.roles.cache.get(roleId);
        if (!role) continue;

        if (invites >= needed && !inviter.roles.cache.has(roleId)) {
            inviter.roles.add(roleId).catch(() => {});
        }

        if (invites < needed && inviter.roles.cache.has(roleId)) {
            inviter.roles.remove(roleId).catch(() => {});
        }
    }
});

// Slash command handler
client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "setinviterole") {
        const role = interaction.options.getRole("role");
        const invites = interaction.options.getInteger("invites");

        let settings = (await db.get(`rolesettings_${interaction.guild.id}`)) || {};
        settings[role.id] = invites;
        await db.set(`rolesettings_${interaction.guild.id}`, settings);

        return interaction.reply(`✅ **${role.name}** now requires **${invites} invites.**`);
    }

    if (interaction.commandName === "inviteroles") {
        const settings = (await db.get(`rolesettings_${interaction.guild.id}`)) || {};

        if (!Object.keys(settings).length)
            return interaction.reply("ℹ No invite roles set yet.");

        let text = "";
        for (const roleId in settings) {
            const role = interaction.guild.roles.cache.get(roleId);
            text += `**${role?.name || "Deleted Role"}** → ${settings[roleId]} invites\n`;
        }

        return interaction.reply(text);
    }

    if (interaction.commandName === "setlogchannel") {
        const channel = interaction.options.getChannel("channel");
        await db.set(`logchannel_${interaction.guild.id}`, channel.id);

        return interaction.reply(`📝 Logging channel set to ${channel}`);
    }
});

// Logging helper
async function log(guild, msg) {
    const channelId = await db.get(`logchannel_${guild.id}`);
    if (!channelId) return;

    const channel = guild.channels.cache.get(channelId);
    if (!channel) return;

    channel.send(msg).catch(() => {});
}

// Register slash commands
async function registerCommands() {
    const commands = [
        {
            name: "setinviterole",
            description: "Set how many invites a role requires.",
            options: [
                { name: "role", type: 8, description: "Role", required: true },
                { name: "invites", type: 4, description: "Invite count", required: true }
            ]
        },
        {
            name: "inviteroles",
            description: "View all invite-based roles"
        },
        {
            name: "setlogchannel",
            description: "Set logging channel",
            options: [
                { name: "channel", type: 7, description: "Select channel", required: true }
            ]
        }
    ];

    client.application.commands.set(commands);
}

client.login(process.env.BOT_TOKEN);
