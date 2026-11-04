import { PermissionFlagsBits } from 'discord.js'
import { z } from 'zod'

const permissionLabels = {
  CreateInstantInvite: 'Create Invite',
  KickMembers: 'Kick, Approve, and Reject Members',
  BanMembers: 'Ban Members',
  Administrator: 'Administrator',
  ManageChannels: 'Manage Channels',
  ManageGuild: 'Manage Server',
  AddReactions: 'Add Reactions',
  ViewAuditLog: 'View Audit Log',
  PrioritySpeaker: 'Priority Speaker',
  Stream: 'Video',
  ViewChannel: 'View Channels',
  SendMessages: 'Send Messages and Create Posts',
  SendTTSMessages: 'Send Text-to-Speech Messages',
  ManageMessages: 'Manage Messages',
  EmbedLinks: 'Embed Links',
  AttachFiles: 'Attach Files',
  ReadMessageHistory: 'Read Message History',
  MentionEveryone: 'Mention @everyone, @here, and All Roles',
  UseExternalEmojis: 'Use External Emoji',
  ViewGuildInsights: 'View Server Insights',
  Connect: 'Connect',
  Speak: 'Speak',
  MuteMembers: 'Mute Members',
  DeafenMembers: 'Deafen Members',
  MoveMembers: 'Move Members',
  UseVAD: 'Use Voice Activity',
  ChangeNickname: 'Change Nickname',
  ManageNicknames: 'Manage Nicknames',
  ManageRoles: 'Manage Roles',
  ManageWebhooks: 'Manage Webhooks',
  ManageEmojisAndStickers: 'Manage Expressions',
  ManageGuildExpressions: 'Manage Expressions',
  UseApplicationCommands: 'Use Application Commands',
  RequestToSpeak: 'Request to Speak',
  ManageEvents: 'Manage Events',
  ManageThreads: 'Manage Threads and Posts',
  CreatePublicThreads: 'Create Public Threads',
  CreatePrivateThreads: 'Create Private Threads',
  UseExternalStickers: 'Use External Stickers',
  SendMessagesInThreads: 'Send Messages in Threads and Posts',
  UseEmbeddedActivities: 'Use Activities',
  ModerateMembers: 'Timeout Members',
  ViewCreatorMonetizationAnalytics: 'View Server Subscription Insights',
  UseSoundboard: 'Use Soundboard',
  CreateGuildExpressions: 'Create Expressions',
  CreateEvents: 'Create Events',
  UseExternalSounds: 'Use External Sounds',
  SendVoiceMessages: 'Send Voice Messages',
  SetVoiceChannelStatus: 'Set Voice Channel Status',
  SendPolls: 'Create Polls',
  UseExternalApps: 'Use External Apps',
  PinMessages: 'Pin Messages',
  BypassSlowmode: 'Bypass Slowmode',
} satisfies Record<keyof typeof PermissionFlagsBits, string>

type ObservedRole = {
  discordRoleId: string
  mentionable: boolean
  name: string
  permissions: bigint
  position: number
}

type ObservedOverwrite =
  | { allow: bigint; deny: bigint; discordRoleId: string; kind: 'role' }
  | { allow: bigint; deny: bigint; discordUserId: string; kind: 'member' }

type ObservedChannel = {
  discordChannelId: string
  isCategory: boolean
  isVoice: boolean
  name: string
  overwrites: ObservedOverwrite[]
  parentDiscordChannelId: string | null
  position: number
}

type ObservedThread = {
  discordChannelId: string
  isPrivate: boolean
  name: string
  parentDiscordChannelId: string
}

type ObservedServerRoles = {
  ownerDiscordRoleIds: string[]
  ownerTimedOutUntil: string | null
  roles: ObservedRole[]
  serverOwnerDiscordUserId: string
}

type ObservedChannelAccess = ObservedServerRoles & {
  channels: ObservedChannel[]
  threads: ObservedThread[]
}

type PermissionFetchRequest = {
  discordGuildId: string
  ownerDiscordUserId: string
}

type ServerRolesTransport = (
  request: PermissionFetchRequest
) => Promise<ObservedServerRoles>

type ChannelAccessTransport = (
  request: PermissionFetchRequest
) => Promise<ObservedChannelAccess>

type PermissionFetchReading = 'channel_access' | 'roles'

type PermissionFetchFailureKind =
  | 'owner_not_member'
  | 'rejected'
  | 'server_unknown'
  | 'unreachable'

type PermissionFetchGuidance = {
  summary: string
  nextAction: string
}

class PermissionFetchOwnerNotMemberError extends Error {}

class PermissionFetchRejectedError extends Error {}

class PermissionFetchServerUnknownError extends Error {}

const permissionFetchFailureCopy = {
  owner_not_member: {
    summary:
      'Discord found no member of this server under DISCORD_OWNER_USER_ID, so there are no roles of yours to read.',
    nextAction:
      'Check DISCORD_OWNER_USER_ID is your own Discord user id and that you are still in the server DISCORD_GUILD_ID names, then ask again.',
  },
  rejected: {
    summary:
      'Discord refused to let the bot read the server, so nothing was read.',
    nextAction:
      'Check the bot is still in the server DISCORD_GUILD_ID names and that DISCORD_BOT_TOKEN is current, then ask again — reading changes nothing in Discord, so another attempt is safe.',
  },
  server_unknown: {
    summary:
      'Discord does not know the server DISCORD_GUILD_ID names, so nothing was read.',
    nextAction:
      'Check DISCORD_GUILD_ID is your server id and that the bot is still in that server — invite it again if it was removed — then ask again.',
  },
  unreachable: {
    summary: 'We could not reach Discord, so nothing was read.',
    nextAction:
      'Check this machine can reach Discord, then ask again — reading changes nothing there, so another attempt is safe.',
  },
} satisfies Record<PermissionFetchFailureKind, PermissionFetchGuidance>

type PermissionGrant =
  | { through: 'server_owner' }
  | { through: 'administrator'; discordRoleIds: string[] }
  | { through: 'your_channel_permissions' }
  | { through: 'role_channel_permissions'; discordRoleIds: string[] }
  | { through: 'everyone_channel_permissions' }
  | { through: 'role_server_permissions'; discordRoleIds: string[] }

type Viewer = {
  discordUserId: string
  heldDiscordRoleIds: string[]
  timedOutUntil: string | null
}

type Server = {
  discordGuildId: string
  roles: ObservedRole[]
  serverOwnerDiscordUserId: string
}

function rolesOf({ discordGuildId, roles }: Server, viewer: Viewer) {
  return roles.filter(
    ({ discordRoleId }) =>
      discordRoleId === discordGuildId ||
      viewer.heldDiscordRoleIds.includes(discordRoleId)
  )
}

function grants(bits: bigint, permission: bigint) {
  return (bits & permission) === permission
}

function idsOf(roles: ObservedRole[]) {
  return roles.map(({ discordRoleId }) => discordRoleId)
}

const keptWhileTimedOut =
  PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ReadMessageHistory

function timeoutThatCounts(server: Server, viewer: Viewer) {
  const exempt =
    viewer.discordUserId === server.serverOwnerDiscordUserId ||
    rolesOf(server, viewer).some(({ permissions }) =>
      grants(permissions, PermissionFlagsBits.Administrator)
    )

  return exempt ? null : viewer.timedOutUntil
}

function grantOf(
  permission: bigint,
  server: Server,
  viewer: Viewer,
  overwrites: ObservedOverwrite[]
): PermissionGrant | null {
  if (viewer.discordUserId === server.serverOwnerDiscordUserId) {
    return { through: 'server_owner' }
  }

  const held = rolesOf(server, viewer)
  const administrators = held.filter(({ permissions }) =>
    grants(permissions, PermissionFlagsBits.Administrator)
  )

  if (administrators.length > 0) {
    return { through: 'administrator', discordRoleIds: idsOf(administrators) }
  }

  if (viewer.timedOutUntil !== null && !grants(keptWhileTimedOut, permission)) {
    return null
  }

  const personal = overwrites.find(
    (overwrite) =>
      overwrite.kind === 'member' &&
      overwrite.discordUserId === viewer.discordUserId
  )

  if (personal && grants(personal.allow, permission)) {
    return { through: 'your_channel_permissions' }
  }

  if (personal && grants(personal.deny, permission)) return null

  const roleOverwrites = overwrites.flatMap((overwrite) =>
    overwrite.kind === 'role' &&
    viewer.heldDiscordRoleIds.includes(overwrite.discordRoleId)
      ? [overwrite]
      : []
  )
  const allowing = roleOverwrites.filter(({ allow }) =>
    grants(allow, permission)
  )

  if (allowing.length > 0) {
    return {
      through: 'role_channel_permissions',
      discordRoleIds: allowing.map(({ discordRoleId }) => discordRoleId),
    }
  }

  if (roleOverwrites.some(({ deny }) => grants(deny, permission))) return null

  const everyone = overwrites.find(
    (overwrite) =>
      overwrite.kind === 'role' &&
      overwrite.discordRoleId === server.discordGuildId
  )

  if (everyone && grants(everyone.allow, permission)) {
    return { through: 'everyone_channel_permissions' }
  }

  if (everyone && grants(everyone.deny, permission)) return null

  const granting = held.filter(({ permissions }) =>
    grants(permissions, permission)
  )

  return granting.length > 0
    ? { through: 'role_server_permissions', discordRoleIds: idsOf(granting) }
    : null
}

type View = PermissionGrant | 'only_if_added' | null

function viewsOf(
  server: Server,
  viewer: Viewer,
  {
    channels,
    threads,
  }: { channels: ObservedChannel[]; threads: ObservedThread[] }
) {
  const views = new Map<string, View>()

  for (const channel of channels) {
    if (channel.isCategory) continue

    views.set(
      channel.discordChannelId,
      grantOf(
        PermissionFlagsBits.ViewChannel,
        server,
        viewer,
        channel.overwrites
      )
    )
  }

  for (const thread of threads) {
    const parent = channels.find(
      ({ discordChannelId, isCategory }) =>
        !isCategory && discordChannelId === thread.parentDiscordChannelId
    )
    const parentView = parent ? views.get(parent.discordChannelId) : null

    if (!parent || !parentView) {
      views.set(thread.discordChannelId, null)
    } else if (!thread.isPrivate) {
      views.set(thread.discordChannelId, parentView)
    } else {
      views.set(
        thread.discordChannelId,
        grantOf(
          PermissionFlagsBits.ManageThreads,
          server,
          viewer,
          parent.overwrites
        ) ?? 'only_if_added'
      )
    }
  }

  return views
}

function serverPermissions(server: Server, viewer: Viewer) {
  const held = rolesOf(server, viewer).reduce(
    (bits, { permissions }) => bits | permissions,
    0n
  )

  return timeoutThatCounts(server, viewer) === null
    ? held
    : held & keptWhileTimedOut
}

function permissionLabelsOf(bits: bigint) {
  const labels: string[] = []
  const seen = new Set<bigint>()

  for (const [flag, bit] of Object.entries(PermissionFlagsBits)) {
    if (seen.has(bit) || !grants(bits, bit)) continue

    seen.add(bit)
    labels.push(permissionLabels[flag as keyof typeof PermissionFlagsBits])
  }

  return labels
}

function counted(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`
}

function listed(names: string[]) {
  if (names.length <= 1) return names.join('')

  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

const channelAccessCoverage =
  'Only what Discord shows the bot is judged here: a channel the bot cannot view may be left out and its active threads always are, archived threads are left out, and so is a private thread you see only because someone added you to it.'

function visibleNowSummary(visible: number) {
  return `You can view ${counted(visible, 'channel or thread', 'channels and threads')} right now; \`grantedBy\` on each names what lets you see it.`
}

type RoleSetAsideOutcome =
  | { kind: 'not_held'; roleName: string }
  | { kind: 'server_owner'; roleName: string }
  | { kind: 'administrator_elsewhere'; roleName: string; through: string[] }
  | {
      kind: 'compared'
      lostChannels: number
      lostPermissions: number
      onlyIfAdded: number
      roleName: string
    }

function roleSetAsideSummary(outcome: RoleSetAsideOutcome) {
  switch (outcome.kind) {
    case 'not_held':
      return `You do not hold ${outcome.roleName}, so nothing changes without it.`
    case 'server_owner':
      return `You are the server owner, so you lose nothing without ${outcome.roleName}.`
    case 'administrator_elsewhere':
      return outcome.through.length === 1
        ? `Another of your roles (${outcome.through[0]}) grants Administrator, so you lose nothing without ${outcome.roleName}.`
        : `Other roles of yours (${listed(outcome.through)}) grant Administrator, so you lose nothing without ${outcome.roleName}.`
    default: {
      const { lostChannels, lostPermissions, onlyIfAdded, roleName } = outcome
      const losses = [
        ...(lostChannels > 0
          ? [
              `${counted(lostChannels, 'channel or thread', 'channels and threads')} you can view now`,
            ]
          : []),
        ...(lostPermissions > 0
          ? [
              counted(
                lostPermissions,
                'server-wide permission',
                'server-wide permissions'
              ),
            ]
          : []),
      ]
      const membershipOnly = `${counted(onlyIfAdded, 'private thread', 'private threads')} would stay visible only if someone added you to ${onlyIfAdded === 1 ? 'it' : 'them'}`

      if (losses.length > 0) {
        const lost = `Without ${roleName} you would lose ${listed(losses)}.`

        return onlyIfAdded > 0 ? `${lost} ${membershipOnly}.` : lost
      }

      return onlyIfAdded > 0
        ? `Without ${roleName} you keep every server-wide permission you have and every channel and thread you can view now, except that ${membershipOnly}.`
        : `Without ${roleName} you keep every channel, thread and server-wide permission you have now.`
    }
  }
}

type TimeoutStanding =
  | { kind: 'counts'; until: string }
  | { kind: 'counts_without_role'; roleName: string; until: string }

function withTimeout(summary: string, standing: TimeoutStanding | null) {
  if (standing === null) return summary

  return standing.kind === 'counts'
    ? `${summary} You are timed out until ${standing.until}, and until then Discord takes away every permission you hold except View Channels and Read Message History, so a private thread you would see by managing threads is left out and no other server-wide permission counts.`
    : `${summary} You are timed out until ${standing.until}. Administrator exempts you from the timeout now, but without ${standing.roleName} Discord would take away every permission you hold except View Channels and Read Message History until then.`
}

const withoutDiscordRoleIdMessage =
  'Pass a `discordRoleId` from roles_list, or leave it out to see your access as it stands'

const everyoneSetAsideMessage =
  'Everyone holds @everyone and nobody can leave it, so there is nothing to compare. Pass the `discordRoleId` of another role from roles_list.'

const unknownRoleMessage =
  'No role with that id exists on the server. List the roles with roles_list to pick a `discordRoleId`.'

const listRolesSchema = z.object({})

const readChannelAccessSchema = z.object({
  withoutDiscordRoleId: z
    .string({ error: withoutDiscordRoleIdMessage })
    .min(1, withoutDiscordRoleIdMessage)
    .optional()
    .describe(
      'The `discordRoleId` of a role you hold, from roles_list. Every channel then also says whether you could still view it without that role, and the answer names the server-wide permissions you would no longer have without it. Left out, you get your access as it stands.'
    ),
})

export {
  PermissionFetchOwnerNotMemberError,
  PermissionFetchRejectedError,
  PermissionFetchServerUnknownError,
  channelAccessCoverage,
  everyoneSetAsideMessage,
  listRolesSchema,
  permissionFetchFailureCopy,
  permissionLabelsOf,
  readChannelAccessSchema,
  roleSetAsideSummary,
  serverPermissions,
  timeoutThatCounts,
  unknownRoleMessage,
  viewsOf,
  visibleNowSummary,
  withTimeout,
}

export type {
  ChannelAccessTransport,
  ObservedChannel,
  ObservedChannelAccess,
  ObservedOverwrite,
  ObservedRole,
  ObservedServerRoles,
  ObservedThread,
  PermissionFetchFailureKind,
  PermissionFetchGuidance,
  PermissionFetchReading,
  PermissionGrant,
  RoleSetAsideOutcome,
  ServerRolesTransport,
  TimeoutStanding,
  View,
  Viewer,
}
