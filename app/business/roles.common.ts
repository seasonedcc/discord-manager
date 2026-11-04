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

function grantOf(
  permission: bigint,
  server: Server,
  viewer: Viewer,
  overwrites: ObservedOverwrite[] = []
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
  return rolesOf(server, viewer).reduce(
    (bits, { permissions }) => bits | permissions,
    0n
  )
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
  'Only what Discord shows the bot is judged here: a channel hidden from the bot is missing whether or not you can view it, archived threads are left out, and so is a private thread you see only because someone added you to it.'

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
      const losses = [
        ...(outcome.lostChannels > 0
          ? [
              `${counted(outcome.lostChannels, 'channel or thread', 'channels and threads')} you can view now`,
            ]
          : []),
        ...(outcome.lostPermissions > 0
          ? [
              counted(
                outcome.lostPermissions,
                'server-wide permission',
                'server-wide permissions'
              ),
            ]
          : []),
      ]
      const lost =
        losses.length > 0
          ? `Without ${outcome.roleName} you would lose ${listed(losses)}.`
          : `Without ${outcome.roleName} you keep every channel, thread and server-wide permission you have now.`
      const onlyIfAdded =
        outcome.onlyIfAdded === 1
          ? ' 1 private thread would stay visible only if someone added you to it.'
          : outcome.onlyIfAdded > 1
            ? ` ${outcome.onlyIfAdded} private threads would stay visible only if someone added you to them.`
            : ''

      return `${lost}${onlyIfAdded}`
    }
  }
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
      'The `discordRoleId` of a role you hold, from roles_list. Every channel then also says whether you could still view it without that role, and the answer names the server-wide permissions only that role gives you. Left out, you get your access as it stands.'
    ),
})

export {
  PermissionFetchOwnerNotMemberError,
  PermissionFetchRejectedError,
  PermissionFetchServerUnknownError,
  channelAccessCoverage,
  everyoneSetAsideMessage,
  grantOf,
  listRolesSchema,
  permissionFetchFailureCopy,
  permissionLabels,
  permissionLabelsOf,
  readChannelAccessSchema,
  roleSetAsideSummary,
  serverPermissions,
  unknownRoleMessage,
  viewsOf,
  visibleNowSummary,
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
  PermissionGrant,
  RoleSetAsideOutcome,
  ServerRolesTransport,
  View,
  Viewer,
}
