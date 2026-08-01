import { type Result, fromSuccess } from 'composable-functions'
import { type Client, Events } from 'discord.js'
import { ownerContext } from '~/business/auth.server'
import type {
  BackfilledMessage,
  FetchChannelHistory,
} from '~/business/ingestion.common'
import {
  listBackfillableChannels,
  reconcileThreadArchivings,
  recordChannelRemoval,
  recordChannelSnapshot,
  recordGatewayConnection,
  recordIncomingMessage,
  recordMessageDeletion,
  recordMessageEdit,
  runChannelBackfill,
} from '~/business/ingestion.server'
import type {
  ObservedAttachment,
  ObservedEmbed,
} from '~/business/messages.common'
import {
  handleReactionAdded,
  handleReactionRemoved,
  handleReactionsCleared,
  registerGatewayListeners,
} from '~/ingest/gateway.server'
import { nextDiscordId } from '../discord-ids'
import { waitForTheStoreClockToTick } from './clock'

type SeededMember = {
  discordUserId: string
  displayName: string
  username: string
}

type SeededChannel = {
  category?: string
  discordChannelId: string
  id: string
  isThread: boolean
  name: string
  position?: number
  topic?: string
}

type SeededMessage = {
  attachments: ObservedAttachment[]
  author: SeededMember
  channelId: string
  content: string
  discordChannelId: string
  discordCreatedAt: string
  discordMessageId: string
  id: string
  jumpUrl: string
}

async function withADistinctInstant<Event>(recording: Promise<Event>) {
  const recorded = await recording

  await waitForTheStoreClockToTick()

  return recorded
}

function jumpUrl(discordChannelId: string, discordMessageId: string) {
  return `https://discord.com/channels/${ownerContext().owner.guildId}/${discordChannelId}/${discordMessageId}`
}

function member({
  displayName,
  username,
}: {
  displayName: string
  username: string
}): SeededMember {
  return { discordUserId: nextDiscordId(), displayName, username }
}

async function connectGateway() {
  return await withADistinctInstant(
    fromSuccess(recordGatewayConnection)({}, ownerContext())
  )
}

async function disconnectGateway() {
  const handlers = new Map<string, () => Promise<Result<unknown>>>()
  const scriptedClient = {
    on: (event: string, handler: () => Promise<Result<unknown>>) => {
      handlers.set(event, handler)
    },
  } as unknown as Client

  registerGatewayListeners(scriptedClient, {
    fetchChannelHistory: async () => [],
  })

  const loseTheLink = handlers.get(Events.ShardReconnecting)

  if (!loseTheLink) {
    throw new Error(
      'The gateway listeners ignore a shard that starts reconnecting, so the fake feed cannot drop the link'
    )
  }

  const dropped = await withADistinctInstant(loseTheLink())

  if (!dropped.success) {
    throw new Error('The fake gateway feed could not record the dropped link')
  }
}

async function observeChannel({
  category,
  isThread = false,
  name,
  position,
  topic,
}: {
  category?: string
  isThread?: boolean
  name: string
  position?: number
  topic?: string
}): Promise<SeededChannel> {
  const observed = {
    category,
    discordChannelId: nextDiscordId(),
    isThread,
    name,
    position,
    topic,
  }
  const { channelId } = await withADistinctInstant(
    fromSuccess(recordChannelSnapshot)(observed, ownerContext())
  )

  return { ...observed, id: channelId }
}

async function loseChannel(channel: SeededChannel) {
  await withADistinctInstant(
    fromSuccess(recordChannelRemoval)(
      { discordChannelId: channel.discordChannelId },
      ownerContext()
    )
  )

  return channel
}

async function postMessage({
  attachments = [],
  author,
  channel,
  content,
  discordCreatedAt,
  embeds = [],
  mentioning = [],
}: {
  attachments?: ObservedAttachment[]
  author: SeededMember
  channel: SeededChannel
  content: string
  discordCreatedAt: string
  embeds?: ObservedEmbed[]
  mentioning?: SeededMember[]
}): Promise<SeededMessage> {
  const discordMessageId = nextDiscordId()
  const { messageId } = await withADistinctInstant(
    fromSuccess(recordIncomingMessage)(
      {
        attachments,
        author,
        channel: {
          category: channel.category,
          discordChannelId: channel.discordChannelId,
          isThread: channel.isThread,
          name: channel.name,
          position: channel.position,
          topic: channel.topic,
        },
        content,
        discordCreatedAt,
        discordMessageId,
        embeds,
        mentionedDiscordUserIds: mentioning.map(
          (member) => member.discordUserId
        ),
      },
      ownerContext()
    )
  )

  return {
    attachments,
    author,
    channelId: channel.id,
    content,
    discordChannelId: channel.discordChannelId,
    discordCreatedAt,
    discordMessageId,
    id: messageId,
    jumpUrl: jumpUrl(channel.discordChannelId, discordMessageId),
  }
}

async function editMessage(
  message: SeededMessage,
  content: string,
  {
    attachments = [],
    embeds = [],
    mentioning = [],
  }: {
    attachments?: ObservedAttachment[]
    embeds?: ObservedEmbed[]
    mentioning?: SeededMember[]
  } = {}
) {
  await withADistinctInstant(
    fromSuccess(recordMessageEdit)(
      {
        attachments,
        content,
        discordMessageId: message.discordMessageId,
        embeds,
        mentionedDiscordUserIds: mentioning.map(
          (member) => member.discordUserId
        ),
      },
      ownerContext()
    )
  )

  return {
    ...message,
    attachments,
    content,
    previousContent: message.content,
  }
}

async function deleteMessage(message: SeededMessage) {
  await withADistinctInstant(
    fromSuccess(recordMessageDeletion)(
      { discordMessageId: message.discordMessageId },
      ownerContext()
    )
  )

  return message
}

function recordedByTheGateway(
  recorded: Record<string, Result<unknown>> | undefined
) {
  if (!recorded) {
    throw new Error(
      'The fake gateway feed aimed a reaction at a server this deployment does not manage'
    )
  }

  for (const [what, result] of Object.entries(recorded)) {
    if (!result.success) {
      throw new Error(
        `The fake gateway feed could not record the ${what} of a reaction: ${result.errors.map((error) => error.message).join(', ')}`
      )
    }
  }

  return recorded
}

async function reactToMessage({
  emoji,
  message,
  reactor,
}: {
  emoji: string
  message: SeededMessage
  reactor: SeededMember
}) {
  return recordedByTheGateway(
    await withADistinctInstant(
      handleReactionAdded({
        discordGuildId: ownerContext().owner.guildId,
        discordMessageId: message.discordMessageId,
        emoji: { name: emoji },
        reactorDiscordUserId: reactor.discordUserId,
      })
    )
  )
}

async function undoReaction({
  emoji,
  message,
  reactor,
}: {
  emoji: string
  message: SeededMessage
  reactor: SeededMember
}) {
  return recordedByTheGateway(
    await withADistinctInstant(
      handleReactionRemoved({
        discordGuildId: ownerContext().owner.guildId,
        discordMessageId: message.discordMessageId,
        emoji: { name: emoji },
        reactorDiscordUserId: reactor.discordUserId,
      })
    )
  )
}

async function clearReactions({
  emoji,
  message,
}: {
  emoji?: string
  message: SeededMessage
}) {
  return recordedByTheGateway(
    await withADistinctInstant(
      handleReactionsCleared({
        discordGuildId: ownerContext().owner.guildId,
        discordMessageId: message.discordMessageId,
        emoji: emoji === undefined ? undefined : { name: emoji },
      })
    )
  )
}

function draftHistory({
  attachments = [],
  author,
  content,
  discordCreatedAt,
  embeds = [],
  mentioning = [],
  reactedTo = [],
  reactorsDiscordRefusedToList = false,
}: {
  attachments?: ObservedAttachment[]
  author: SeededMember
  content: string
  discordCreatedAt: string
  embeds?: ObservedEmbed[]
  mentioning?: SeededMember[]
  reactedTo?: { emoji: string; reactors: SeededMember[] }[]
  reactorsDiscordRefusedToList?: boolean
}): BackfilledMessage {
  return {
    attachments,
    author,
    content,
    discordCreatedAt,
    discordMessageId: nextDiscordId(),
    embeds,
    mentionedDiscordUserIds: mentioning.map((member) => member.discordUserId),
    reactions: reactorsDiscordRefusedToList
      ? undefined
      : reactedTo.map(({ emoji, reactors }) => ({
          emoji: { animated: false, name: emoji },
          reactorDiscordUserIds: reactors.map((member) => member.discordUserId),
        })),
  }
}

async function backfillChannel({
  channel,
  history,
}: {
  channel: SeededChannel
  history: BackfilledMessage[]
}) {
  let servedPages = 0
  const fetchChannelHistory: FetchChannelHistory = async () => {
    servedPages += 1

    return servedPages === 1 ? history : []
  }

  const run = await withADistinctInstant(
    fromSuccess(runChannelBackfill)(
      { channelId: channel.id, fetchChannelHistory },
      ownerContext()
    )
  )

  return {
    ...run,
    messages: history.map((message) => ({
      ...message,
      channelId: channel.id,
      discordChannelId: channel.discordChannelId,
      jumpUrl: jumpUrl(channel.discordChannelId, message.discordMessageId),
    })),
  }
}

async function reconnectGateway({
  activeThreadDiscordChannelIds,
  walkingTheHistoryOf = [],
}: {
  activeThreadDiscordChannelIds: string[]
  walkingTheHistoryOf?: {
    channel: SeededChannel
    history: BackfilledMessage[]
  }[]
}) {
  await connectGateway()
  await withADistinctInstant(
    fromSuccess(reconcileThreadArchivings)(
      { activeThreadDiscordChannelIds },
      ownerContext()
    )
  )

  const backfillable = await fromSuccess(listBackfillableChannels)(
    {},
    ownerContext()
  )
  const backfillableChannelIds = backfillable.map((channel) => channel.id)
  const walked = []

  for (const { channel, history } of walkingTheHistoryOf) {
    if (!backfillableChannelIds.includes(channel.id)) continue

    walked.push(await backfillChannel({ channel, history }))
  }

  return {
    backfillableChannelIds,
    messages: walked.flatMap((run) => run.messages),
    runs: walked,
  }
}

const feed = {
  backfillChannel,
  clearReactions,
  connectGateway,
  deleteMessage,
  disconnectGateway,
  draftHistory,
  editMessage,
  loseChannel,
  member,
  observeChannel,
  postMessage,
  reactToMessage,
  reconnectGateway,
  undoReaction,
}

export { feed }
export type { SeededChannel, SeededMember, SeededMessage }
