import { z } from 'zod'

// Seven days, the longest Discord offers, so a thread the owner opens for a
// conversation outlives a weekend of silence before Discord archives it.
const threadAutoArchiveMinutes = 10080

const threadNameLimit = 100

const channelIdMessage =
  'Pass a `channelId` from channels_list to create a thread of its own in that channel, not the Discord channel snowflake'

const messageIdMessage =
  'Pass a `messageId` from messages_catch_up, mentions_list or bookmarks_list to anchor the thread on that message, not the Discord message snowflake'

const nameMessage = `Write the thread name people will see, up to ${threadNameLimit} characters`

const oneAnchorMessage =
  'Pass either `channelId` to create a thread of its own in a channel, or `messageId` to anchor it on a message — one of the two, never both'

type ThreadCreationFailureKind =
  | 'gone'
  | 'rejected'
  | 'thread_already_exists'
  | 'unreachable'

type ThreadCreationSkipReason =
  | 'anchor_message_deleted'
  | 'channel_is_a_thread'
  | 'channel_not_found'
  | 'channel_not_in_guild'
  | 'thread_already_exists'

type ThreadCreationOutcome =
  | { status: 'created' }
  | { status: 'failed'; kind: ThreadCreationFailureKind }
  | { status: 'skipped'; reason: ThreadCreationSkipReason }

type ThreadCreationGuidance = {
  summary: string
  nextAction: string
}

type ThreadCreateTransport = (request: {
  anchorDiscordMessageId: string | null
  autoArchiveMinutes: number
  discordChannelId: string
  name: string
}) => Promise<{ discordChannelId: string }>

class ThreadCreateAlreadyThreadedError extends Error {}

class ThreadCreateGoneError extends Error {}

class ThreadCreateRejectedError extends Error {}

const threadCreationCopy = {
  summary: 'The thread is live in the channel.',
  nextAction:
    'Post into it with messages_send, passing the `channelId` this answer carries.',
} satisfies ThreadCreationGuidance

const threadCreationFailureCopy = {
  gone: {
    summary:
      'Discord no longer has that message, so no thread was created on it.',
    nextAction:
      "Catch up on that channel to pick a message that still stands, or pass the channel's `channelId` to create the thread on its own.",
  },
  rejected: {
    summary: 'Discord refused to create the thread, so none exists.',
    nextAction:
      'Give the bot View Channel and Create Public Threads in that channel, check DISCORD_BOT_TOKEN, or try a plainer name, then create it again — no thread was created, so a second attempt cannot leave two.',
  },
  thread_already_exists: {
    summary:
      'Discord says that message already carries a thread, so none was created, and that thread is not among the channels the bot can see.',
    nextAction:
      "List the channels to find that thread once the ingest daemon records it, then post into it with messages_send. If it never shows up there, pass the channel's `channelId` to create the thread on its own.",
  },
  unreachable: {
    summary:
      'We could not reach Discord, so the thread may or may not have been created.',
    nextAction:
      'List the channels before creating it again — one Discord did create shows up there once the ingest daemon records it.',
  },
} satisfies Record<ThreadCreationFailureKind, ThreadCreationGuidance>

const threadCreationSkipCopy = {
  anchor_message_deleted: {
    summary: 'That message was deleted in Discord, so no thread was created.',
    nextAction:
      "Catch up on that channel to pick a message that still stands, or pass the channel's `channelId` to create the thread on its own.",
  },
  channel_is_a_thread: {
    summary:
      'That channel is itself a thread, and Discord does not put a thread inside a thread.',
    nextAction:
      'Post into that thread with messages_send, or create the new thread in the channel it hangs under.',
  },
  channel_not_found: {
    summary: 'That channel is gone from the bot, so no thread was created.',
    nextAction:
      'List the channels again and pick one the bot can still see, then create the thread there.',
  },
  channel_not_in_guild: {
    summary:
      'That channel belongs to a different Discord server than this deployment manages.',
    nextAction:
      'Pick a channel from the server this deployment manages, then create the thread there.',
  },
  thread_already_exists: {
    summary:
      'That message already carries a thread, and Discord gives a message only one.',
    nextAction:
      'List the channels to find that thread, then post into it with messages_send.',
  },
} satisfies Record<ThreadCreationSkipReason, ThreadCreationGuidance>

function threadCreationGuidance(outcome: ThreadCreationOutcome) {
  switch (outcome.status) {
    case 'failed':
      return threadCreationFailureCopy[outcome.kind]
    case 'skipped':
      return threadCreationSkipCopy[outcome.reason]
    default:
      return threadCreationCopy
  }
}

const createThreadSchema = z
  .object({
    channelId: z
      .string({ error: channelIdMessage })
      .min(1, channelIdMessage)
      .optional()
      .describe(
        'The `channelId` from channels_list — not the Discord channel snowflake. Creates a thread of its own in that channel. Leave it out when you pass `messageId`.'
      ),
    messageId: z
      .string({ error: messageIdMessage })
      .min(1, messageIdMessage)
      .optional()
      .describe(
        'The `messageId` from messages_catch_up, mentions_list or bookmarks_list — not the Discord message snowflake. Anchors the thread on that message, the way Discord does when you start a thread from one. Leave it out when you pass `channelId`.'
      ),
    name: z
      .string({ error: nameMessage })
      .min(1, nameMessage)
      .max(threadNameLimit, nameMessage)
      .describe(
        `The name people will see on the thread, as the owner would type it. Up to ${threadNameLimit} characters.`
      ),
  })
  .refine(
    ({ channelId, messageId }) =>
      (channelId === undefined) !== (messageId === undefined),
    { error: oneAnchorMessage }
  )

export {
  ThreadCreateAlreadyThreadedError,
  ThreadCreateGoneError,
  ThreadCreateRejectedError,
  createThreadSchema,
  oneAnchorMessage,
  threadAutoArchiveMinutes,
  threadCreationCopy,
  threadCreationFailureCopy,
  threadCreationGuidance,
  threadCreationSkipCopy,
}

export type {
  ThreadCreateTransport,
  ThreadCreationFailureKind,
  ThreadCreationGuidance,
  ThreadCreationSkipReason,
}
