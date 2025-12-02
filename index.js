/**
 * InviteRoleBot — persistent + log-recovery
 * Node 18+, discord.js v14
 */

import fs from "fs";
import path from "path";
import { Client, GatewayIntentBits, REST, Routes, PermissionsBitField } from "discord.js";
import dotenv from "dotenv";
dotenv.config();

// ===================== CONFIG =====================
const DATA_FILE = path.join(process.cwd(), "data.json");
const ACCOUNT_AGE_BLOCK_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

// ===================== DATA LOAD =====================
function loadData() {
  if (!fs.existsSync(DATA_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch (e) {
    console.error("Failed to parse data.json:", e);
    return {};
  }
}
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

const data = loadData();
const invitesCache = new Map();

// ===================== CLIENT =====================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.GuildMessages
  ],
});

// ===================== UTIL =====================
function ensureGuildData(guildId) {
  if (!data[guildId]) {
    data[guildId] = { thresholds: {}, counts: {}, logChannelId: null, invitesCache: {} };
    saveData(data);
  }
  if (!data[guildId].invitesCache) data[guildId].invitesCache = {};

  if (!invitesCache.has(guildId)) {
    const obj = data[guildId].invitesCache;
    const map = new Map();
    for (const [code, v] of Object.entries(obj)) {
      map.set(code, { uses: v.uses ?? 0, inviterId: v.inviterId ?? null });
    }
    invitesCache.set(guildId, map);
  }

  return data[guildId];
}

function persistInvitesCacheForGuild(guildId) {
  const map = invitesCache.get(guildId);
  if (!map) return;

  const obj = {};
  for (const [code, v] of map.entries()) {
    obj[code] = { uses: v.uses ?? 0, inviterId: v.inviterId ?? null };
  }

  ensureGuildData(guildId);
  data[guildId].invitesCache = obj;
  saveData(data);
}

// ===================== LOG REBUILD =====================
async function rebuildCountsFromLogs(guild) {
  try {
    const gdata = data[guild.id];
    if (!gdata.logChannelId) return false;

    const ch = await guild.channels.fetch(gdata.logChannelId).catch(() => null);
    if (!ch || !ch.isTextBased?.()) return false;

    const fetched = await ch.messages.fetch({ limit: 1000 });
    const msgs = Array.from(fetched.values()).reverse();

    const creditRegex = /credited to <@!?(\d+)>/i;
    const totalRegex = /new total:\s*(\d+)/i;

    gdata.counts = {};

    for (const m of msgs) {
      const text = m.content || "";
      const c = text.match(creditRegex);
      if (!c) continue;

      const inviterId = c[1];
      const t = text.match(totalRegex);

      if (t) {
        gdata.counts[inviterId] = Number(t[1]);
      } else {
        gdata.counts[inviterId] = (gdata.counts[inviterId] || 0) + 1;
      }
    }

    saveData(data);
    console.log(`Rebuilt counts for ${guild.id}`);
    return true;
  } catch {
    return false;
  }
}

// ===================== READY =====================
client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  for (const guild of client.guilds.cache.values()) {
    ensureGuildData(guild.id);

    // fetch live invites
    try {
      const invites = await guild.invites.fetch();
      const map = new Map();
      invites.forEach(inv => {
        map.set(inv.code, { uses: inv.uses ?? 0, inviterId: inv.inviter?.id ?? null });
      });
      invitesCache.set(guild.id, map);
      persistInvitesCacheForGuild(guild.id);
    } catch {}

    // rebuild if needed
    const gdata = data[guild.id];
    if (!gdata.counts || Object.keys(gdata.counts).length === 0) {
      if (gdata.logChannelId) {
        await rebuildCountsFromLogs(guild);
      }
    }
  }

  // register commands
  const rest = new REST({ version: "10" }).setToken(process.env.TOKEN);
  const commands = [
    {
      name: "set-threshold",
      description: "Role reward at X invites",
      options: [
        { name: "role", type: 8, description: "Role", required: true },
        { name: "invites", type: 4, description: "Invite count", required: true }
      ]
    },
    {
      name: "remove-threshold",
      description: "Remove threshold",
      options: [{ name: "role", type: 8, required: true }]
    },
    {
      name: "set-log-channel",
      description: "Set log channel",
      options: [{ name: "channel", type: 7, required: false }]
    },
    { name: "show-config", description: "Show config" }
  ];

  for (const guild of client.guilds.cache.values()) {
    try {
      await rest.put(
        Routes.applicationGuildCommands(client.user.id, guild.id),
        { body: commands }
      );
    } catch {}
  }
});

// ===================== INVITE CACHE UPDATES =====================
client.on("inviteCreate", invite => {
  const gid = invite.guildId;
  ensureGuildData(gid);
  if (!invitesCache.has(gid)) invitesCache.set(gid, new Map());
  invitesCache.get(gid).set(invite.code, {
    uses: invite.uses ?? 0,
    inviterId: invite.inviter?.id ?? null
  });
  persistInvitesCacheForGuild(gid);
});

client.on("inviteDelete", invite => {
  const gid = invite.guildId;
  ensureGuildData(gid);
  if (!invitesCache.has(gid)) return;
  invitesCache.get(gid).delete(invite.code);
  persistInvitesCacheForGuild(gid);
});

// ===================== MEMBER JOIN =====================
client.on("guildMemberAdd", async member => {
  const guild = member.guild;
  const gid = guild.id;

  ensureGuildData(gid);
  const gdata = data[gid];

  if (member.user.bot) return;

  // account age check
  const age = Date.now() - member.user.createdTimestamp;
  if (age <= ACCOUNT_AGE_BLOCK_MS) {
    if (gdata.logChannelId) {
      guild.channels.cache
        .get(gdata.logChannelId)
        ?.send(`<@${member.id}> joined but account too new — ignored.`);
    }
    return;
  }

  // find which invite was used
  let inviterId = null;
  try {
    const current = await guild.invites.fetch();
    const prev = invitesCache.get(gid) ?? new Map();

    for (const inv of current.values()) {
      const old = prev.get(inv.code);
      const oldUses = old?.uses ?? 0;
      if ((inv.uses ?? 0) > oldUses) {
        inviterId = inv.inviter?.id ?? null;
        break;
      }
    }

    const newMap = new Map();
    current.forEach(inv =>
      newMap.set(inv.code, { uses: inv.uses ?? 0, inviterId: inv.inviter?.id ?? null })
    );
    invitesCache.set(gid, newMap);
    persistInvitesCacheForGuild(gid);

  } catch {}

  if (!inviterId) {
    if (gdata.logChannelId) {
      guild.channels.cache
        .get(gdata.logChannelId)
        ?.send(`Cannot determine who invited <@${member.id}>.`);
    }
    return;
  }

  // increment count
  gdata.counts[inviterId] = (gdata.counts[inviterId] || 0) + 1;
  saveData(data);

  if (gdata.logChannelId) {
    guild.channels.cache
      .get(gdata.logChannelId)
      ?.send(`✅ <@${member.id}> joined. Credited to <@${inviterId}> — new total: ${gdata.counts[inviterId]}`);
  }

  // assign roles
  const thresholds = Object.entries(gdata.thresholds).sort((a, b) => a[1] - b[1]);
  const inviterMember = await guild.members.fetch(inviterId).catch(() => null);
  if (!inviterMember) return;

  for (const [roleId, req] of thresholds) {
    if (gdata.counts[inviterId] >= req) {
      if (!inviterMember.roles.cache.has(roleId)) {
        inviterMember.roles.add(roleId).catch(() => {});
      }
    }
  }
});

// ===================== COMMANDS =====================
client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, guild, member } = interaction;
  if (!guild) return;

  const admin =
    member.permissions.has(PermissionsBitField.Flags.Administrator) ||
    member.permissions.has(PermissionsBitField.Flags.ManageGuild);

  if (!admin)
    return interaction.reply({ content: "Admin only.", ephemeral: true });

  ensureGuildData(guild.id);
  const gdata = data[guild.id];

  if (commandName === "set-threshold") {
    const role = interaction.options.getRole("role", true);
    const invites = interaction.options.getInteger("invites", true);

    gdata.thresholds[role.id] = invites;
    saveData(data);
    return interaction.reply(`Set <@&${role.id}> = ${invites} invites.`);
  }

  if (commandName === "remove-threshold") {
    const role = interaction.options.getRole("role", true);

    delete gdata.thresholds[role.id];
    saveData(data);
    return interaction.reply(`Removed threshold for <@&${role.id}>.`);
  }

  if (commandName === "set-log-channel") {
    const ch = interaction.options.getChannel("channel", false);

    gdata.logChannelId = ch ? ch.id : null;
    saveData(data);

    return interaction.reply(
      ch
        ? `Log channel set to <#${ch.id}>.`
        : `Log channel cleared.`
    );
  }

  if (commandName === "show-config") {
    const t = Object.entries(gdata.thresholds)
      .map(([rid, req]) => `• <@&${rid}> → ${req}`)
      .join("\n") || "None";

    const c = Object.entries(gdata.counts)
      .slice(0, 15)
      .map(([uid, cnt]) => `• <@${uid}>: ${cnt}`)
      .join("\n") || "None";

    return interaction.reply(
      `**Thresholds:**\n${t}\n\n**Counts:**\n${c}\n\n**Log channel:** ${
        gdata.logChannelId ? `<#${gdata.logChannelId}>` : "None"
      }`
    );
  }
});

// ===================== FINAL: SAFE LOGIN =====================
let tokenRaw = process.env.TOKEN;

if (!tokenRaw) {
  console.error("TOKEN missing. Set env var TOKEN.");
  process.exit(1);
}

// sanitize
tokenRaw = tokenRaw
  .trim()
  .replace(/^["']+|["']+$/g, "")
  .replace(/\r?\n/g, "");

// masked preview
const masked = tokenRaw.length > 8
  ? tokenRaw.slice(0, 4) + "..." + tokenRaw.slice(-4)
  : tokenRaw;

console.log(`TOKEN preview: ${masked} | length: ${tokenRaw.length}`);

client.login(tokenRaw).catch(err => {
  console.error("Login failed:", err);
  process.exit(1);
});



