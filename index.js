/**
 * InviteRoleBot — persistent + log-recovery + health endpoint for UptimeRobot
 * Node 18+, discord.js v14
 *
 * - Opens HTTP server on process.env.PORT (Render) so Web Service stays healthy
 * - Exposes GET / and GET /health returning basic JSON (ok + bot tag + timestamp)
 * - Persistent data saved to data.json
 * - Rebuild counts by parsing log channel messages
 * - Sanitized token login with masked preview logged (safe)
 */

import fs from "fs";
import path from "path";
import http from "http";
import { Client, GatewayIntentBits, REST, Routes, PermissionsBitField } from "discord.js";
import dotenv from "dotenv";
dotenv.config();

// ===================== CONFIG =====================
const DATA_FILE = path.join(process.cwd(), "data.json");
const ACCOUNT_AGE_BLOCK_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

// ===================== DATA HELPERS =====================
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
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.warn("Failed to save data.json:", err);
  }
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

// ===================== UTILS =====================
function ensureGuildData(guildId) {
  if (!data[guildId]) {
    data[guildId] = { thresholds: {}, counts: {}, logChannelId: null, invitesCache: {} };
    saveData(data);
  }
  if (!data[guildId].invitesCache) data[guildId].invitesCache = {};

  if (!invitesCache.has(guildId)) {
    const invObj = data[guildId].invitesCache || {};
    const map = new Map();
    for (const [code, v] of Object.entries(invObj)) {
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
  for (const [code, v] of map.entries()) obj[code] = { uses: v.uses ?? 0, inviterId: v.inviterId ?? null };
  ensureGuildData(guildId);
  data[guildId].invitesCache = obj;
  saveData(data);
}

// Persist everything (invites cache + data)
async function persistAll() {
  try {
    for (const guildId of invitesCache.keys()) persistInvitesCacheForGuild(guildId);
    saveData(data);
    console.log("Persisted data to disk.");
  } catch (err) {
    console.warn("PersistAll failed:", err);
  }
}

// ===================== REBUILD FROM LOGS =====================
async function rebuildCountsFromLogs(guild) {
  try {
    const gdata = data[guild.id];
    if (!gdata || !gdata.logChannelId) return false;
    const ch = await guild.channels.fetch(gdata.logChannelId).catch(() => null);
    if (!ch || !ch.isTextBased?.()) return false;

    // fetch up to 1000 messages (oldest->newest)
    const fetched = await ch.messages.fetch({ limit: 1000 });
    const msgs = Array.from(fetched.values()).reverse();

    const creditRegex = /credited to <@!?(\d+)>/i;
    const incrementByRegex = /new total:\s*(\d+)/i;

    gdata.counts = {};
    for (const m of msgs) {
      const content = m.content || "";
      const cMatch = content.match(creditRegex);
      if (!cMatch) continue;
      const inviterId = cMatch[1];
      const totalMatch = content.match(incrementByRegex);
      if (totalMatch) {
        const parsed = Number(totalMatch[1]);
        if (!Number.isNaN(parsed)) {
          gdata.counts[inviterId] = parsed;
          continue;
        }
      }
      gdata.counts[inviterId] = (gdata.counts[inviterId] || 0) + 1;
    }
    saveData(data);
    console.log(`Rebuilt invite counts for guild ${guild.id} from logs (entries: ${Object.keys(gdata.counts).length})`);
    return true;
  } catch (err) {
    console.warn("Rebuild from logs failed:", err);
    return false;
  }
}

// ===================== READY =====================
client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  // For each guild: ensure data and try to fetch invites and rebuild if needed
  for (const guild of client.guilds.cache.values()) {
    ensureGuildData(guild.id);

    // Attempt to fetch live invites and persist
    try {
      const invites = await guild.invites.fetch();
      const map = new Map();
      invites.forEach(inv => map.set(inv.code, { uses: inv.uses ?? 0, inviterId: inv.inviter?.id ?? null }));
      invitesCache.set(guild.id, map);
      persistInvitesCacheForGuild(guild.id);
    } catch (err) {
      // ignore fetch failures
    }

    // If counts empty and log channel set -> try rebuild
    const gdata = data[guild.id];
    const countsEmpty = !gdata.counts || Object.keys(gdata.counts).length === 0;
    if (countsEmpty && gdata.logChannelId) {
      await rebuildCountsFromLogs(guild);
    }
  }

  // register commands per-guild (guild-scoped)
  try {
    const rest = new REST({ version: "10" }).setToken(process.env.TOKEN);
    const commands = [
      {
        name: "set-threshold",
        description: "Set a role invite threshold",
        options: [
          { name: "role", type: 8, description: "Role to grant", required: true },
          { name: "invites", type: 4, description: "Number of invites required", required: true }
        ]
      },
      {
        name: "remove-threshold",
        description: "Remove a previously set role threshold",
        options: [{ name: "role", type: 8, description: "Role to remove", required: true }]
      },
      {
        name: "set-log-channel",
        description: "Set a channel where invite logs are posted (or omit to clear)",
        options: [{ name: "channel", type: 7, description: "Text channel to use for logs (or omit to clear)", required: false }]
      },
      {
        name: "show-config",
        description: "Show invite-role thresholds, counts summary and log channel"
      },
      {
        name: "rebuild-counts",
        description: "Rebuild invite counts by parsing the configured log channel (admin only)"
      }
    ];
    for (const guild of client.guilds.cache.values()) {
      try {
        await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), { body: commands });
      } catch (err) {
        // ignore per-guild registration failures
      }
    }
  } catch (err) {
    // rest token might not be ready on startup; ignore
  }
});

// ===================== INVITE CACHE EVENTS =====================
client.on("inviteCreate", invite => {
  const guildId = invite.guildId;
  if (!invitesCache.has(guildId)) invitesCache.set(guildId, new Map());
  invitesCache.get(guildId).set(invite.code, { uses: invite.uses ?? 0, inviterId: invite.inviter?.id ?? null });
  ensureGuildData(guildId);
  persistInvitesCacheForGuild(guildId);
});

client.on("inviteDelete", invite => {
  const guildId = invite.guildId;
  if (!invitesCache.has(guildId)) return;
  invitesCache.get(guildId).delete(invite.code);
  ensureGuildData(guildId);
  persistInvitesCacheForGuild(guildId);
});

// ===================== MEMBER JOIN =====================
client.on("guildMemberAdd", async member => {
  const guild = member.guild;
  const guildId = guild.id;
  ensureGuildData(guildId);

  if (member.user.bot) return;

  // account age
  const accountAge = Date.now() - member.user.createdTimestamp;
  if (accountAge <= ACCOUNT_AGE_BLOCK_MS) {
    const g = data[guildId];
    if (g.logChannelId) {
      const ch = guild.channels.cache.get(g.logChannelId);
      if (ch && ch.isTextBased?.()) {
        ch.send(`<@${member.id}> joined but their account is too new (${Math.floor(accountAge / (24*60*60*1000))} days). Invite not counted.`);
      }
    }
    // refresh invites cache
    try {
      const newInvs = await guild.invites.fetch();
      const map = new Map();
      newInvs.forEach(inv => map.set(inv.code, { uses: inv.uses ?? 0, inviterId: inv.inviter?.id ?? null }));
      invitesCache.set(guildId, map);
      persistInvitesCacheForGuild(guildId);
    } catch (e) { /* ignore */ }
    return;
  }

  // find used invite by comparing cached uses to current
  let usedInviterId = null;
  try {
    const currentInvs = await guild.invites.fetch();
    const prevMap = invitesCache.get(guildId) ?? new Map();
    for (const inv of currentInvs.values()) {
      const prev = prevMap.get(inv.code);
      const prevUses = prev?.uses ?? 0;
      if ((inv.uses ?? 0) > prevUses) {
        usedInviterId = inv.inviter?.id ?? null;
        break;
      }
    }
    // update cache
    const map = new Map();
    currentInvs.forEach(inv => map.set(inv.code, { uses: inv.uses ?? 0, inviterId: inv.inviter?.id ?? null }));
    invitesCache.set(guildId, map);
    persistInvitesCacheForGuild(guildId);
  } catch (err) {
    console.warn("Failed to fetch invites on guildMemberAdd:", err);
  }

  if (!usedInviterId) {
    const g = data[guildId];
    if (g.logChannelId) {
      const ch = guild.channels.cache.get(g.logChannelId);
      if (ch && ch.isTextBased?.()) {
        ch.send(`A member joined (<@${member.id}>) but the inviter couldn't be determined (vanity URL or unknown).`);
      }
    }
    return;
  }

  // increment inviter count and persist
  const gdata = data[guildId];
  gdata.counts[usedInviterId] = (gdata.counts[usedInviterId] || 0) + 1;
  saveData(data);

  if (gdata.logChannelId) {
    const ch = guild.channels.cache.get(gdata.logChannelId);
    if (ch && ch.isTextBased?.()) {
      ch.send(`✅ <@${member.id}> joined (account age ok). Count credited to <@${usedInviterId}> — new total: ${gdata.counts[usedInviterId]}`);
    }
  }

  // assign roles for thresholds (sorted ascending)
  const thresholds = Object.entries(gdata.thresholds || {}).map(([roleId, req]) => [roleId, Number(req)]);
  thresholds.sort((a,b) => a[1] - b[1]);

  const inviterMember = await guild.members.fetch(usedInviterId).catch(()=>null);
  if (!inviterMember) return;

  for (const [roleId, required] of thresholds) {
    if (gdata.counts[usedInviterId] >= required) {
      if (!inviterMember.roles.cache.has(roleId)) {
        try {
          await inviterMember.roles.add(roleId, `Reached ${required} invites`);
          if (gdata.logChannelId) {
            const ch = guild.channels.cache.get(gdata.logChannelId);
            if (ch && ch.isTextBased?.()) ch.send(`🎉 Assigned role <@&${roleId}> to <@${usedInviterId}> (reached ${required} invites).`);
          }
        } catch (err) {
          console.warn(`Failed to assign role ${roleId} in guild ${guildId}:`, err.message);
          if (gdata.logChannelId) {
            const ch = guild.channels.cache.get(gdata.logChannelId);
            if (ch && ch.isTextBased?.()) ch.send(`⚠️ Could not assign role <@&${roleId}> to <@${usedInviterId}>. Check bot permissions/role position.`);
          }
        }
      }
    }
  }
});

// ===================== GUILD MEMBER REMOVE (decrement + optional role revoke) =====================
client.on("guildMemberRemove", async (member) => {
  const guild = member.guild;
  const guildId = guild.id;
  ensureGuildData(guildId);
  const gdata = data[guildId];
  if (!gdata.logChannelId) return;

  const ch = await guild.channels.fetch(gdata.logChannelId).catch(()=>null);
  if (!ch || !ch.isTextBased?.()) return;

  try {
    const fetched = await ch.messages.fetch({ limit: 1000 });
    const msgs = Array.from(fetched.values()).reverse();

    const pattern = new RegExp(`<@!?${member.id}> joined \\(account age ok\\)\\. Count credited to <@!?([0-9]+)> — new total: (\\d+)`, "i");
    let found = null;
    for (const m of msgs) {
      const c = m.content || "";
      const match = c.match(pattern);
      if (match) found = { inviterId: match[1], total: Number(match[2]) };
    }
    if (!found) {
      const fallbackPattern = new RegExp(`Count credited to <@!?([0-9]+)>`, "i");
      for (const m of msgs) {
        const c = m.content || "";
        const match = c.match(fallbackPattern);
        if (match && c.includes(`<@${member.id}>`)) {
          found = { inviterId: match[1], total: null };
          break;
        }
      }
    }
    if (!found) return;

    const inviterId = found.inviterId;
    if (!gdata.counts[inviterId]) return;

    gdata.counts[inviterId] = Math.max(0, gdata.counts[inviterId] - 1);
    saveData(data);

    // optionally remove roles if inviter fell below threshold
    const thresholdArr = Object.entries(gdata.thresholds || {}).map(([roleId, req]) => [roleId, Number(req)]);
    thresholdArr.sort((a,b) => b[1] - a[1]); // remove higher roles first

    const inviterMember = await guild.members.fetch(inviterId).catch(()=>null);
    if (inviterMember) {
      for (const [roleId, required] of thresholdArr) {
        if (gdata.counts[inviterId] < required && inviterMember.roles.cache.has(roleId)) {
          try {
            await inviterMember.roles.remove(roleId, `Invites dropped below ${required}`);
            ch.send(`🔻 Removed role <@&${roleId}> from <@${inviterId}> (now ${gdata.counts[inviterId]} invites).`);
          } catch (err) {
            console.warn("Failed to remove role after decrement:", err.message);
          }
        }
      }
    }
  } catch (err) {
    console.warn("Failed to handle guildMemberRemove:", err);
  }
});

// ===================== INTERACTIONS (commands) =====================
client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName, guild, member } = interaction;
  if (!guild) return interaction.reply({ content: "This command must be used in a server (guild).", ephemeral: true });

  const hasPerm = member.permissions.has(PermissionsBitField.Flags.Administrator) || member.permissions.has(PermissionsBitField.Flags.ManageGuild);
  if (!hasPerm) return interaction.reply({ content: "You need Administrator or Manage Server permissions to use this.", ephemeral: true });

  ensureGuildData(guild.id);
  const g = data[guild.id];

  if (commandName === "set-threshold") {
    const role = interaction.options.getRole("role", true);
    const invites = interaction.options.getInteger("invites", true);
    if (invites <= 0) return interaction.reply({ content: "Invites must be a positive integer.", ephemeral: true });

    g.thresholds[role.id] = invites;
    saveData(data);
    return interaction.reply({ content: `Threshold set: <@&${role.id}> will be granted at **${invites}** invites.`, ephemeral: false });
  }

  if (commandName === "remove-threshold") {
    const role = interaction.options.getRole("role", true);
    if (g.thresholds[role.id]) {
      delete g.thresholds[role.id];
      saveData(data);
      return interaction.reply({ content: `Removed threshold for role <@&${role.id}>.`, ephemeral: false });
    } else {
      return interaction.reply({ content: `No threshold was set for role <@&${role.id}>.`, ephemeral: true });
    }
  }

  if (commandName === "set-log-channel") {
    const channel = interaction.options.getChannel("channel", false);
    if (!channel) {
      g.logChannelId = null;
      saveData(data);
      return interaction.reply({ content: `Log channel cleared.`, ephemeral: false });
    }
    if (!channel.isTextBased?.()) return interaction.reply({ content: "Please provide a text channel.", ephemeral: true });
    g.logChannelId = channel.id;
    saveData(data);
    return interaction.reply({ content: `Log channel set to <#${channel.id}>. Make sure I can read message history in this channel for recovery.`, ephemeral: false });
  }

  if (commandName === "show-config") {
    const thresholds = Object.entries(g.thresholds).map(([roleId, req]) => `• <@&${roleId}> → ${req} invites`).join("\n") || "None";
    const countsPreview = Object.entries(g.counts || {}).slice(0, 10).map(([uid, c]) => `• <@${uid}>: ${c}`).join("\n") || "None";
    const logCh = g.logChannelId ? `<#${g.logChannelId}>` : "None";
    return interaction.reply({
      content: `**Thresholds:**\n${thresholds}\n\n**Recent counts:**\n${countsPreview}\n\n**Log channel:** ${logCh}`,
      ephemeral: false
    });
  }

  if (commandName === "rebuild-counts") {
    if (!g.logChannelId) return interaction.reply({ content: "No log channel set. Use /set-log-channel first.", ephemeral: true });
    await interaction.reply({ content: "Starting rebuild from logs — this may take a moment...", ephemeral: false });
    const ok = await rebuildCountsFromLogs(guild);
    if (ok) return interaction.editReply({ content: "Rebuild complete. Counts have been overwritten from the log channel." });
    else return interaction.editReply({ content: "Rebuild failed — make sure I have Read Message History permission in the log channel and that logs exist." });
  }
});

// ===================== HTTP HEALTH SERVER (for Render web service + UptimeRobot) =====================
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/health") {
    const botTag = client?.user ? client.user.tag : "starting";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", bot: botTag, timestamp: Date.now() }));
  } else {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
});
server.listen(PORT, () => console.log(`HTTP server listening on port ${PORT} — /health OK`));
process.on("SIGINT", async () => { try { server.close(); } catch {} await persistAll(); process.exit(0); });
process.on("SIGTERM", async () => { try { server.close(); } catch {} await persistAll(); process.exit(0); });

// ===================== TOKEN SANITIZE + LOGIN =====================
let tokenRaw = process.env.TOKEN;
if (!tokenRaw) {
  console.error("FATAL: TOKEN env var is missing. Set TOKEN in Render/Environment (no quotes).");
  process.exit(1);
}
tokenRaw = tokenRaw.trim().replace(/^["']+|["']+$/g, "").replace(/\r?\n/g, "");

const masked = tokenRaw.length > 8 ? tokenRaw.slice(0, 4) + "..." + tokenRaw.slice(-4) : tokenRaw;
console.log(`TOKEN preview: ${masked} | length: ${tokenRaw.length}`);

client.login(tokenRaw).then(() => console.log("Bot logged in successfully.")).catch(async (err) => {
  console.error("Login failed:", err);
  await persistAll();
  process.exit(1);
});

