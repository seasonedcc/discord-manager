import type { Client, GuildBasedChannel } from 'discord.js'
import { Events } from 'discord.js'
import type { z } from 'zod'
import { ownerContext } from '~/business/auth.server'
import type { FetchChannelHistory } from '~/business/ingestion.common'
import {
  backfillIngestedChannels,
  reconcileThreadArchivings,
  recordChannelArchiving,
  recordChannelRemoval,
  recordChannelSnapshot,
  type recordChannelSnapshotSchema,
  recordChannelUnarchiving,
  recordGatewayConnection,
  recordGatewayDisconnection,
  recordIncomingMessage,
  type recordIncomingMessageSchema,
  recordMessageDeletion,
  recordMessageEdit,
  recordOwnerBookmarkReaction,
  recordOwnerBookmarkReactionRemoval,
} from '~/business/ingestion.server'

type ObservedChannel = z.input<typeof recordChannelSnapshotSchema> & {
  archived?: boolean
  discordGuildId: string
}

type ObservedMessage = z.input<typeof recordIncomingMessageSchema> & {
  channel: ObservedChannel
}

type ObservedMessageReference = {
  discordGuildId: string
  discordMessageId: string
}

type ObservedEditedMessage = ObservedMessageReference & {
  content: string
}

type ObservedReaction = ObservedMessageReference & {
  emoji: string
  reactorDiscordUserId: string
}

function belongsToTheOwnersGuild(discordGuildId: string) {
  return discordGuildId === ownerContext().owner.guildId
}

async function handleIncomingMessage(message: ObservedMessage) {
  if (!belongsToTheOwnersGuild(message.channel.discordGuildId)) return

  return await recordIncomingMessage(message, ownerContext())
}

async function handleMessageEdit(message: ObservedEditedMessage) {
  if (!belongsToTheOwnersGuild(message.discordGuildId)) return

  return await recordMessageEdit(
    {
      content: message.content,
      discordMessageId: message.discordMessageId,
    },
    ownerContext()
  )
}

async function handleMessageDeletion(message: ObservedMessageReference) {
  if (!belongsToTheOwnersGuild(message.discordGuildId)) return

  return await recordMessageDeletion(
    { discordMessageId: message.discordMessageId },
    ownerContext()
  )
}

async function handleChannelSnapshot(channel: ObservedChannel) {
  if (!belongsToTheOwnersGuild(channel.discordGuildId)) return

  const snapshot = await recordChannelSnapshot(channel, ownerContext())

  if (channel.archived === undefined) return snapshot

  const recordArchivedState = channel.archived
    ? recordChannelArchiving
    : recordChannelUnarchiving

  await recordArchivedState(
    { discordChannelId: channel.discordChannelId },
    ownerContext()
  )

  return snapshot
}

async function handleChannelRemoval(channel: ObservedChannel) {
  if (!belongsToTheOwnersGuild(channel.discordGuildId)) return

  return await recordChannelRemoval(
    { discordChannelId: channel.discordChannelId },
    ownerContext()
  )
}

async function handleReactionAdded(reaction: ObservedReaction) {
  if (!belongsToTheOwnersGuild(reaction.discordGuildId)) return

  return await recordOwnerBookmarkReaction(
    {
      discordMessageId: reaction.discordMessageId,
      emoji: reaction.emoji,
      reactorDiscordUserId: reaction.reactorDiscordUserId,
    },
    ownerContext()
  )
}

async function handleReactionRemoved(reaction: ObservedReaction) {
  if (!belongsToTheOwnersGuild(reaction.discordGuildId)) return

  return await recordOwnerBookmarkReactionRemoval(
    {
      discordMessageId: reaction.discordMessageId,
      emoji: reaction.emoji,
      reactorDiscordUserId: reaction.reactorDiscordUserId,
    },
    ownerContext()
  )
}

async function handleGatewayConnected({
  activeThreadDiscordChannelIds,
  channels,
  fetchChannelHistory,
}: {
  activeThreadDiscordChannelIds?: string[]
  channels: ObservedChannel[]
  fetchChannelHistory: FetchChannelHistory
}) {
  const connection = await recordGatewayConnection({}, ownerContext())

  for (const channel of channels) {
    await handleChannelSnapshot(channel)
  }

  if (activeThreadDiscordChannelIds) {
    await reconcileThreadArchivings(
      { activeThreadDiscordChannelIds },
      ownerContext()
    )
  }

  backfillIngestedChannels.enqueue({ fetchChannelHistory })

  return connection
}

async function handleGatewayDisconnected() {
  return await recordGatewayDisconnection({}, ownerContext())
}

function observeChannel(channel: GuildBasedChannel): ObservedChannel {
  return {
    archived:
      'archived' in channel ? (channel.archived ?? undefined) : undefined,
    category:
      channel.parent && 'name' in channel.parent
        ? channel.parent.name
        : undefined,
    discordChannelId: channel.id,
    discordGuildId: channel.guildId,
    isThread: channel.isThread(),
    name: channel.name,
    position: 'position' in channel ? channel.position : undefined,
    topic: 'topic' in channel ? (channel.topic ?? undefined) : undefined,
  }
}

function observableChannels(client: Client): ObservedChannel[] {
  return client.channels.cache
    .filter(
      (channel): channel is GuildBasedChannel =>
        !channel.isDMBased() && channel.isTextBased()
    )
    .map(observeChannel)
}

async function fetchActiveThreadDiscordChannelIds(client: Client) {
  try {
    const guild = client.guilds.cache.get(ownerContext().owner.guildId)

    if (!guild) return undefined

    const { threads } = await guild.channels.fetchActiveThreads()

    return [...threads.keys()]
  } catch {
    return undefined
  }
}

function registerGatewayListeners(
  client: Client,
  { fetchChannelHistory }: { fetchChannelHistory: FetchChannelHistory }
) {
  async function reconnect(connectedClient: Client) {
    await handleGatewayConnected({
      activeThreadDiscordChannelIds:
        await fetchActiveThreadDiscordChannelIds(connectedClient),
      channels: observableChannels(connectedClient),
      fetchChannelHistory,
    })
  }

  client.on(Events.ClientReady, reconnect)

  client.on(Events.ShardDisconnect, async () => {
    await handleGatewayDisconnected()
  })

  client.on(Events.ShardReady, async () => {
    await reconnect(client)
  })

  client.on(Events.ShardResume, async () => {
    await reconnect(client)
  })

  client.on(Events.MessageCreate, async (message) => {
    if (!message.inGuild() || !message.channel.isTextBased()) return

    await handleIncomingMessage({
      author: {
        discordUserId: message.author.id,
        displayName: message.author.displayName,
        username: message.author.username,
      },
      channel: observeChannel(message.channel),
      content: message.content,
      discordCreatedAt: message.createdAt.toISOString(),
      discordMessageId: message.id,
    })
  })

  client.on(Events.MessageUpdate, async (_oldMessage, newMessage) => {
    const message = newMessage.partial ? await newMessage.fetch() : newMessage

    if (!message.inGuild()) return

    await handleMessageEdit({
      content: message.content,
      discordGuildId: message.guildId,
      discordMessageId: message.id,
    })
  })

  client.on(Events.MessageDelete, async (message) => {
    if (!message.guildId) return

    await handleMessageDeletion({
      discordGuildId: message.guildId,
      discordMessageId: message.id,
    })
  })

  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    const resolved = reaction.partial ? await reaction.fetch() : reaction

    if (!resolved.message.guildId) return

    await handleReactionAdded({
      discordGuildId: resolved.message.guildId,
      discordMessageId: resolved.message.id,
      emoji: resolved.emoji.name ?? '',
      reactorDiscordUserId: user.id,
    })
  })

  client.on(Events.MessageReactionRemove, async (reaction, user) => {
    const resolved = reaction.partial ? await reaction.fetch() : reaction

    if (!resolved.message.guildId) return

    await handleReactionRemoved({
      discordGuildId: resolved.message.guildId,
      discordMessageId: resolved.message.id,
      emoji: resolved.emoji.name ?? '',
      reactorDiscordUserId: user.id,
    })
  })

  client.on(Events.ChannelCreate, async (channel) => {
    await handleChannelSnapshot(observeChannel(channel))
  })

  client.on(Events.ChannelUpdate, async (_oldChannel, newChannel) => {
    if (newChannel.isDMBased()) return

    await handleChannelSnapshot(observeChannel(newChannel))
  })

  client.on(Events.ChannelDelete, async (channel) => {
    if (channel.isDMBased()) return

    await handleChannelRemoval(observeChannel(channel))
  })

  client.on(Events.ThreadCreate, async (thread) => {
    await handleChannelSnapshot(observeChannel(thread))
  })

  client.on(Events.ThreadUpdate, async (_oldThread, newThread) => {
    await handleChannelSnapshot(observeChannel(newThread))
  })

  client.on(Events.ThreadDelete, async (thread) => {
    await handleChannelRemoval(observeChannel(thread))
  })
}

export {
  handleChannelRemoval,
  handleChannelSnapshot,
  handleGatewayConnected,
  handleGatewayDisconnected,
  handleIncomingMessage,
  handleMessageDeletion,
  handleMessageEdit,
  handleReactionAdded,
  handleReactionRemoved,
  registerGatewayListeners,
}
export type {
  ObservedChannel,
  ObservedEditedMessage,
  ObservedMessage,
  ObservedMessageReference,
  ObservedReaction,
}
