import { PermissionFlagsBits } from 'discord.js'
import { nextDiscordId } from './discord-ids'
import { type HeldServer, serverEnvironment } from './mcp-client'

const {
  AddReactions,
  Administrator,
  CreatePrivateThreads,
  ManageMessages,
  ManageThreads,
  MentionEveryone,
  ModerateMembers,
  ReadMessageHistory,
  SendMessages,
  ViewChannel,
} = PermissionFlagsBits

const ownerDiscordUserId = serverEnvironment.DISCORD_OWNER_USER_ID
const everyoneId = serverEnvironment.DISCORD_GUILD_ID

function theTeamServer({
  ownerHolds = ['engineers', 'support'],
  serverOwnedByTheOwner = false,
}: {
  ownerHolds?: (
    | 'admins'
    | 'designers'
    | 'engineers'
    | 'moderators'
    | 'support'
  )[]
  serverOwnedByTheOwner?: boolean
} = {}) {
  const roles = {
    admins: {
      id: nextDiscordId(),
      mentionable: false,
      name: 'Admins',
      permissions: Administrator,
      position: 5,
    },
    moderators: {
      id: nextDiscordId(),
      mentionable: false,
      name: 'Moderators',
      permissions: ManageMessages | ManageThreads | ModerateMembers,
      position: 4,
    },
    engineers: {
      id: nextDiscordId(),
      mentionable: true,
      name: 'Engineers',
      permissions: MentionEveryone | CreatePrivateThreads,
      position: 3,
    },
    support: {
      id: nextDiscordId(),
      mentionable: true,
      name: 'Support',
      permissions: 0n,
      position: 2,
    },
    designers: {
      id: nextDiscordId(),
      mentionable: true,
      name: 'Designers',
      permissions: 0n,
      position: 1,
    },
    everyone: {
      id: everyoneId,
      mentionable: false,
      name: '@everyone',
      permissions:
        ViewChannel | SendMessages | ReadMessageHistory | AddReactions,
      position: 0,
    },
  }
  const keepsEveryoneOut = { deny: ViewChannel, id: everyoneId }
  const product = {
    category: true,
    id: nextDiscordId(),
    name: 'Product',
    position: 0,
  }
  const leadership = {
    category: true,
    id: nextDiscordId(),
    name: 'Leadership',
    position: 1,
  }
  const channels = {
    general: { id: nextDiscordId(), name: 'general', position: 0 },
    announcements: { id: nextDiscordId(), name: 'announcements', position: 1 },
    standup: { id: nextDiscordId(), name: 'standup', position: 2, voice: true },
    launchWarRoom: {
      id: nextDiscordId(),
      name: 'launch-war-room',
      overwrites: [
        keepsEveryoneOut,
        { allow: ViewChannel, id: ownerDiscordUserId, member: true },
      ],
      position: 3,
    },
    engineering: {
      id: nextDiscordId(),
      name: 'engineering',
      overwrites: [
        keepsEveryoneOut,
        { allow: ViewChannel, id: roles.engineers.id },
      ],
      parentId: product.id,
      position: 0,
    },
    supportDesk: {
      id: nextDiscordId(),
      name: 'support-desk',
      overwrites: [
        keepsEveryoneOut,
        { allow: ViewChannel, id: roles.engineers.id },
        { allow: ViewChannel, id: roles.support.id },
      ],
      parentId: product.id,
      position: 1,
    },
    designReviews: {
      id: nextDiscordId(),
      name: 'design-reviews',
      overwrites: [
        keepsEveryoneOut,
        { allow: ViewChannel, id: roles.designers.id },
      ],
      parentId: product.id,
      position: 2,
    },
    leadershipOffsite: {
      id: nextDiscordId(),
      name: 'leadership-offsite',
      overwrites: [keepsEveryoneOut],
      parentId: leadership.id,
      position: 0,
    },
  }
  const threads = {
    releaseChecklist: {
      id: nextDiscordId(),
      name: 'release-checklist',
      parentId: channels.engineering.id,
    },
    onboardingQuestions: {
      id: nextDiscordId(),
      name: 'onboarding-questions',
      parentId: channels.general.id,
    },
    incidentReview: {
      id: nextDiscordId(),
      name: 'incident-review',
      parentId: channels.general.id,
      private: true,
    },
  }
  const server: HeldServer = {
    channels: [product, leadership, ...Object.values(channels)],
    memberRoleIds: {
      [ownerDiscordUserId]: ownerHolds.map((key) => roles[key].id),
    },
    ownerDiscordUserId: serverOwnedByTheOwner
      ? ownerDiscordUserId
      : nextDiscordId(),
    roles: Object.values(roles),
    threads: Object.values(threads),
  }

  return {
    categories: { leadership, product },
    channels,
    roles,
    server,
    threads,
  }
}

export { theTeamServer }
