require("dotenv").config();
const { Client, GatewayIntentBits, Partials } = require("discord.js");
const { QuickDB } = require("quick.db");
const dayjs = require("dayjs");
const db = new QuickDB();

// Create client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildInvites
    ],
    partials: [Partials.GuildMember]
});

// Cache invites so we can compare
let invitesCache = new Map();

client.on("ready", async () => {
    console.log(`🔥 Logged in as ${client.user.tag}`);

    // Preload invites for all guilds
    client.guilds.cache.forEach(async guild => {
        const invites = await guild.invites.fetch().catch(() => {});
        if (invites) invitesCache.set(guild.id, invites);
    });

    registerCommands();
});

client.on("guildMemberAdd", async (member) => {

    const oldInvites = invitesCache.get(member.guild.id);
    const newInvites = await member.guild.invites.fetch().catch(() => {});
    if (!oldInvites || !newInvites) return;

    // Find which invite was used
    const usedInvite = newInvites.find(i => i.uses > oldInvites.get(i.code)?.uses);

    invitesCache.set(member.guild.id, newInvites);
    if (!usedInvite) return;

    const inviter = member.guild.members.cache.get(usedInvite.inviter.id);
    if (!inviter) return;

    // CHECK ACCOUNT AGE (Fake-invite prevention)
    const accountAgeDays = dayjs().diff(dayjs(member.user.createdAt), "day");
    const isFake = accountAgeDays <= 3;

    // Logging function
    log(member.guild, 
        `👤 User joined: ${member.user.tag}\nInvited by: ${inviter.user.tag}\nAccount Age: ${accountAgeDays} days\n${isFake ? "❌ Invite ignored" : "✔ Invite counted"}`
    );

    if (isFake) return;

    // VALID INVITE → ADD COUNT
    let userInvites = (await db.get(`invites_${inviter.id}_${member.guild.id}`)) || 0;
    userInvites++;
    await db.set(`invites_${inviter.id}_${member.guild.id}`, userInvites);

    // CHECK ROLE THRESHOLDS
    const settings = (await db.get(`rolesettings_${member.guild.id}`)) || {};

    for (const roleId in settings) {
        const required = settings[roleId];
        const role = member.guild.roles.cache.get(roleId);
        if (!role) continue;

        // ADD ROLE IF REACHED
        if (userInvites >= required && !inviter.roles.cache.has(roleId)) {
            inviter.roles.add(roleId).catch(() => {});
        }

        // REMOVE ROLE IF DROPPED
        if (userInvites < required && inviter.roles.cache.has(roleId)) {
            inviter.roles.remove(roleId).catch(() => {});
        }
    }

});

// Handle slash commands
client.on("interactionCreate", async (interaction) => {

    if (!interaction.isChatInputCommand()) return;

    // SET INVITE ROLE THRESHOLD
    if (interaction.commandName === "setinviterole") {
        const role = interaction.options.getRole("role");
        const invites = interaction.options.getInteger("invites");

        let settings = (await db.get(`rolesettings_${interaction.guild.id}`)) || {};
        settings[role.id] = invites;

        await db.set(`rolesettings_${interaction.guild.id}`, settings);

        return interaction.reply(`✅ **${role.name}** now requires **${invites} invites.**`);
    }

    // LIST ROLES + INVITE VALUES
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

    // SET LOGGING CHANNEL
    if (interaction.commandName === "setlogchannel") {
        const channel = interaction.options.getChannel("channel");

        await db.set(`logchannel_${interaction.guild.id}`, channel.id);

        return interaction.reply(`📝 Logging channel set to ${channel}`);
    }
});

// Simple logging helper
async function log(guild, message) {
    const channelId = await db.get(`logchannel_${guild.id}`);
    if (!channelId) return;

    const channel = guild.channels.cache.get(channelId);
    if (!channel) return;

    channel.send(message).catch(() => {});
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
            description: "Set the logging channel",
            options: [
                { name: "channel", type: 7, description: "Select a channel", required: true }
            ]
        }
    ];

    client.application.commands.set(commands);
}

// Login bot
client.login(process.env.BOT_TOKEN);
