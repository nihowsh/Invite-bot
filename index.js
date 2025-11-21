require("dotenv").config();
const { Client, GatewayIntentBits, Partials } = require("discord.js");
const dayjs = require("dayjs");

// === Lowdb Setup ===
const { Low } = require("lowdb");
const { JSONFile } = require("lowdb/node");

const adapter = new JSONFile("database.json");

// Default DB data (REQUIRED for Render)
const defaultData = {
    invites: {},
    rolesettings: {},
    logchannels: {}
};

// Pass defaultData so lowdb doesn't crash on empty file
const db = new Low(adapter, defaultData);

// Load DB
async function initDB() {
    await db.read();
    await db.write(); // ensures file exists with defaults
}
initDB();

// Load DB
async function initDB() {
    await db.read();
    db.data ||= {
        invites: {},
        rolesettings: {},
        logchannels: {}
    };
    await db.write();
}
initDB();

// === Discord Client ===
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildInvites
    ],
    partials: [Partials.GuildMember]
});

// Cache invites
let invitesCache = new Map();

client.on("ready", async () => {
    console.log(`🔥 Logged in as ${client.user.tag}`);

    for (const guild of client.guilds.cache.values()) {
        const invites = await guild.invites.fetch().catch(() => null);
        if (invites) invitesCache.set(guild.id, invites);
    }

    registerCommands();
});

// On member join
client.on("guildMemberAdd", async (member) => {
    await db.read();

    const oldInvites = invitesCache.get(member.guild.id);
    const newInvites = await member.guild.invites.fetch().catch(() => null);

    if (!oldInvites || !newInvites) return;

    const usedInvite = newInvites.find(i => i.uses > (oldInvites.get(i.code)?.uses || 0));
    invitesCache.set(member.guild.id, newInvites);

    if (!usedInvite) return;

    const inviter = member.guild.members.cache.get(usedInvite.inviter.id);
    if (!inviter) return;

    // Fake-invite check: account <= 3 days old
    const accAge = dayjs().diff(dayjs(member.user.createdAt), "day");
    const fake = accAge <= 3;

    log(member.guild,
        `👤 User: ${member.user.tag}\nInvited by: ${inviter.user.tag}\nAccount Age: ${accAge} days\n${fake ? "❌ Invite ignored" : "✔ Invite counted"}`
    );

    if (fake) return;

    const key = `${inviter.id}_${member.guild.id}`;
    db.data.invites[key] = (db.data.invites[key] || 0) + 1;
    await db.write();

    const settings = db.data.rolesettings[member.guild.id] || {};

    for (const roleId in settings) {
        const required = settings[roleId];
        const role = member.guild.roles.cache.get(roleId);
        if (!role) continue;

        const count = db.data.invites[key];

        if (count >= required && !inviter.roles.cache.has(roleId))
            inviter.roles.add(roleId).catch(() => {});

        if (count < required && inviter.roles.cache.has(roleId))
            inviter.roles.remove(roleId).catch(() => {});
    }
});

// Slash commands
client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    await db.read();

    if (interaction.commandName === "setinviterole") {
        const role = interaction.options.getRole("role");
        const needed = interaction.options.getInteger("invites");

        if (!db.data.rolesettings[interaction.guild.id])
            db.data.rolesettings[interaction.guild.id] = {};

        db.data.rolesettings[interaction.guild.id][role.id] = needed;
        await db.write();

        return interaction.reply(`✅ **${role.name}** now requires **${needed} invites**.`);
    }

    if (interaction.commandName === "inviteroles") {
        const set = db.data.rolesettings[interaction.guild.id] || {};

        if (!Object.keys(set).length)
            return interaction.reply("No invite roles set.");

        let msg = "";
        for (const id in set) {
            const role = interaction.guild.roles.cache.get(id);
            msg += `**${role?.name || "Deleted"}** → ${set[id]} invites\n`;
        }

        return interaction.reply(msg);
    }

    if (interaction.commandName === "setlogchannel") {
        const channel = interaction.options.getChannel("channel");
        db.data.logchannels[interaction.guild.id] = channel.id;
        await db.write();
        return interaction.reply(`📝 Logging channel set to: ${channel}`);
    }
});

// Log helper
async function log(guild, msg) {
    await db.read();
    const id = db.data.logchannels[guild.id];
    if (!id) return;

    const ch = guild.channels.cache.get(id);
    if (!ch) return;

    ch.send(msg).catch(() => {});
}

// Command registration
async function registerCommands() {
    const cmds = [
        {
            name: "setinviterole",
            description: "Set invite requirement for a role",
            options: [
                { name: "role", type: 8, required: true, description: "Role" },
                { name: "invites", type: 4, required: true, description: "Invites needed" }
            ]
        },
        { name: "inviteroles", description: "List all invite role requirements" },
        {
            name: "setlogchannel",
            description: "Choose invite log channel",
            options: [
                { name: "channel", type: 7, required: true, description: "Channel" }
            ]
        }
    ];

    client.application.commands.set(cmds);
}

client.login(process.env.BOT_TOKEN);

// -- Add this at the end of your index.js --
const express = require("express");
const app = express();

app.get("/", (req, res) => res.send("Invite-bot running"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`HTTP server listening on port ${PORT}`);
});


