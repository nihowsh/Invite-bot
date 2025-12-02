/**
 * InviteRoleBot — persistent + log-recovery
 * - Node 18+
 * - discord.js v14
 *
 * Changes vs previous:
 *  - Save guild invite cache to data.json so restarts don't lose invite state
 *  - Save counts + thresholds + log channel to data.json (as before)
 *  - On startup, if counts are missing or look empty, attempt to rebuild counts
 *    by parsing the configured log channel history.
 *
 * Important: bot needs Read Message History permission on the log channel for recovery.
 */

import fs from "fs";
import path from "path";
import { Client, GatewayIntentBits, REST, Routes, PermissionsBitField } from "discord.js";
import dotenv from "dotenv";
dotenv.config();

const DATA_FILE = path.join(process.cwd(), "data.json");
const ACCOUNT_AGE_BLOCK_MS = 3 * 24 * 60 * 60 * 1000; // 3 days in ms (change if you want)

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

// Data shape (persisted):
// {
//   [guildId]: {
//     thresholds: { [roleId]: inviteCount },
//     counts: { [userId]: inviteCount },
//     logChannelId: string|null,
//     invitesCache: { [code]: { uses:number, inviterId:string|null } }  <-- NEW
//   }, ...
// }

const data = loadData();

// In-memory invitesCache maps guildId -> Map(code -> {uses, inviterId})
// We'll hydrate this from data (if present) on ready, but also keep it in-memory for fast comparison.
const invitesCache = new Map();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.GuildMessages,
  ],
});

// Ensure guild entry exists in data (and keep invitesCache and data in sync)
function ensureGuildData(guildId) {
  if (!data[guildId]) {
    data[guildId] = { thresholds: {}, counts: {}, logChannelId: null, invitesCache: {} };
    saveData(data);
  } else {
    // ensure invitesCache key exists
    if (!data[guildId].invitesCache) data[guildId].invitesCache = {};
  }
  // hydrate in-memory invitesCache if not set
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

// Save the in-memory invitesCache back to data[guildId].invitesCache and disk
function persistInvitesCacheForGuild(guildId) {
  const map = invitesCache.get(guildId);
  if (!map) return;
  const obj = {};
  for (const [code, v] of map.entries()) obj[code] = { uses: v.uses ?? 0, inviterId: v.inviterId ?? null };
  ensureGuildData(guildId);
  data[guildId].invitesCache = obj;
  saveData(data);
}

// Rebuild counts from the configured log channel by parsing messages.
// This is a fallback when data is missing or bot was offline and missed joins.
// It looks for lines like: "Count credited to <@123456789> — new total: 3"
// or "credited to <@123456789>" and increments counts accordingly in order of messages.
async function rebuildCountsFromLogs(guild) {
  try {
    const gdata = data[guild.id];
    if (!gdata || !gdata.logChannelId) return false;
    const ch = await guild.channels.fetch(gdata.logChannelId).catch(()=>null);
    if (!ch || !ch.isTextBased?.()) return false;
    // fetch up to 1000 messages (adjustable). Most servers won't need more.
    const fetched = await ch.messages.fetch({ limit: 1000 });
    // We will scan messages oldest -> newest so counts accumulate in the right order.
    const msgs = Array.from(fetched.values()).reverse();
    const creditRegex = /credited to <@!?(\d+)>/i;
    const incrementByRegex = /new total:\s*(\d+)/i;
    // Reset counts before rebuild (we will rebuild completely)
    gdata.counts = {};
    for (const m of msgs) {
      const content = m.content || "";
      const cMatch = content.match(creditRegex);
      if (!cMatch) continue;
      const inviterId = cMatch[1];
      // If we can parse new total, set it (best effort). Otherwise increment by 1.
      const totalMatch = content.match(incrementByRegex);
      if (totalMatch) {
        const parsed = Number(totalMatch[1]);
        if (!Number.isNaN(parsed)) {
          gdata.counts[inviterId] = parsed;
          continue;
        }
      }
      // fallback: increment
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

// On ready: hydrate invitesCache from disk and try to fetch fresh invites (and update cache).
client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  for (const guild of client.guilds.cache.values()) {
    ensureGuildData(guild.id);

    // If we have stored invitesCache in data, hydrate in-memory (ensureGuildData handles it)
    // Then attempt to fetch live invites and update both in-memory and disk
    try {
      const invites = await guild.invites.fetch();
      const map = new Map();
      invites.forEach(inv => map.set(inv.code, { uses: inv.uses ?? 0, inviterId: inv.inviter?.id ?? null }));
      invitesCache.set(guild.id, map);
      persistInvitesCacheForGuild(guild.id);
    } catch (err) {
      console.warn(`Could not fetch invites for guild ${guild.id}:`, err.message);
      // keep whatever was persisted on disk (if any)
    }

    // If counts look empty, try to recover from logs (best-effort)
    const gdata = data[guild.id];
    const countsEmpty = !gdata.counts || Object.keys(gdata.counts).length === 0;
    if (countsEmpty && gdata.logChannelId) {
      const success = await rebuildCountsFromLogs(guild);
      if (!success) {
        console.log(`Unable to rebuild counts for guild ${guild.id} from logs.`);
      }
    }
  }

  // register commands after ready (guild-scoped)
  const rest = new REST({ version: "10" }).setToken(process.env.TOKEN);
  const commands = [
    {
      name: "set-threshold",
      description: "Set a role invite threshold: when a user reaches X invites, the role will be given",
      options: [
        { name: "role", type: 8, description: "Role to grant", required: true },
        { name: "invites", type: 4, description: "Number of invites required", required: true }
      ]
    },
    {
      name: "remove-threshold",
      description: "Remove a previously set role threshold",
      options: [{ name: "role", type: 8, description: "Role to remove from thresholds", required: true }]
    },
    {
      name: "set-log-channel",
      description: "Set a channel where invite logs are posted (set to none to clear)",
      options: [{ name: "channel", type: 7, description: "Text channel to use for logs (or omit to clear)", required: false }]
    },
    {
      name: "show-config",
      description: "Show invite-role thresholds, counts summary and log channel"
    }
  ];
  for (const guild of client.guilds.cache.values()) {
    try {
      await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), { body: commands });
      console.log(`Registered commands for guild ${guild.id}`);
    } catch (err) {
      console.warn(`Failed to register commands for ${guild.id}:`, err.message);
    }
  }
});

// Update invites cache on create/delete/update and persist immediately
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

// On member join: same logic, but we also persist data immediately after counting/assigning roles
client.on("guildMemberAdd", async member => {
  const guild = member.guild;
  const guildId = guild.id;
  ensureGuildData(guildId);

  if (member.user.bot) return;

  // account age check
  const accountAge = Date.now() - member.user.createdTimestamp;
  if (accountAge <= ACCOUNT_AGE_BLOCK_MS) {
    const g = data[guildId];
    if (g.logChannelId) {
      const ch = guild.channels.cache.get(g.logChannelId);
      if (ch && ch.isTextBased?.()) {
        ch.send(`<@${member.id}> joined but their account is too new (${Math.floor(accountAge / (24*60*60*1000))} days). Invite not counted.`);
      }
    }
    // update invites cache by fetching fresh invites (persist afterwards)
    try {
      const newInvs = await guild.invites.fetch();
      const map = new Map();
      newInvs.forEach(inv => map.set(inv.code, { uses: inv.uses ?? 0, inviterId: inv.inviter?.id ?? null }));
      invitesCache.set(guildId, map);
      persistInvitesCacheForGuild(guildId);
    } catch (e) { /* ignore fetch failure */ }
    return;
  }

  // fetch current invites and compare to cached invites to detect which invite incremented
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
    // update cache and persist
    const map = new Map();
    currentInvs.forEach(inv => map.set(inv.code, { uses: inv.uses ?? 0, inviterId: inv.inviter?.id ?? null }));
    invitesCache.set(guildId, map);
    persistInvitesCacheForGuild(guildId);
  } catch (err) {
    console.warn("Failed to fetch invites on guildMemberAdd:", err);
  }

  // if no inviter detected, log and exit
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

  // increment inviter's count (persist immediately)
  const gdata = data[guildId];
  if (!gdata.counts[usedInviterId]) gdata.counts[usedInviterId] = 0;
  gdata.counts[usedInviterId] += 1;
  saveData(data);

  // log credited join (consistent format so rebuild can parse)
  if (gdata.logChannelId) {
    const ch = guild.channels.cache.get(gdata.logChannelId);
    if (ch && ch.isTextBased?.()) {
      ch.send(`✅ <@${member.id}> joined (account age ok). Count credited to <@${usedInviterId}> — new total: ${gdata.counts[usedInviterId]}`);
    }
  }

  // assign roles for thresholds
  const thresholds = gdata.thresholds || {};
  const thresholdArr = Object.entries(thresholds).map(([roleId, req]) => [roleId, Number(req)]);
  // sort ascending so lower tiers assigned first
  thresholdArr.sort((a,b) => a[1] - b[1]);

  const inviterMember = await guild.members.fetch(usedInviterId).catch(()=>null);
  if (!inviterMember) return;

  for (const [roleId, required] of thresholdArr) {
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

// ----- Commands -----
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
});

client.login(process.env.TOKEN);



