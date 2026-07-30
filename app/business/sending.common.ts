import { z } from 'zod'

// A send is a single REST call with no scheduled retry, so nothing can still be
// working on a request that has gone this long without recording an outcome.
const messageSendStallThresholdMinutes = 15

type MessageSendFailureKind = 'rejected' | 'unreachable'

type MessageSendSkipReason =
  | 'channel_not_found'
  | 'channel_not_in_guild'
  | 'empty_content'

type MessageSendStatus =
  | 'delivered'
  | 'failed'
  | 'pending'
  | 'skipped'
  | 'stalled'

type MessageSendGuidance = {
  summary: string
  nextAction: string
}

type MessageSendTransport = (request: {
  content: string
  discordChannelId: string
  replyToDiscordMessageId: string | null
}) => Promise<{ discordMessageId: string }>

class TransportRejectedError extends Error {}

const messageSendSkipCopy = {
  channel_not_found: {
    summary: 'That channel is gone from the bot, so nothing was posted.',
    nextAction:
      'List the channels again and pick one the bot can still see, then send.',
  },
  channel_not_in_guild: {
    summary:
      'That channel belongs to a different Discord server than this deployment manages.',
    nextAction:
      'Pick a channel from the server this deployment manages, then send it again.',
  },
  empty_content: {
    summary: 'The message had no visible text, so nothing was posted.',
    nextAction: 'Write the message text, then send it again.',
  },
} satisfies Record<MessageSendSkipReason, MessageSendGuidance>

const messageSendFailureCopy = {
  rejected: {
    summary: 'Discord refused the message, so it was never posted.',
    nextAction:
      'Give the bot Send Messages (and Send Messages in Threads) in that channel and check DISCORD_BOT_TOKEN, then send it again.',
  },
  unreachable: {
    summary:
      'We could not reach Discord, so the message may or may not have posted.',
    nextAction: 'Check the channel in Discord before sending it again.',
  },
} satisfies Record<MessageSendFailureKind, MessageSendGuidance>

const messageSendStatusCopy = {
  delivered: {
    summary: 'The message is live in the channel.',
    nextAction: 'Open the channel in Discord to follow the conversation.',
  },
  pending: {
    summary: 'The message is on its way to Discord.',
    nextAction: 'Read this send again in a moment to see where it landed.',
  },
  skipped: {
    summary: 'The message was not posted.',
    nextAction: 'Read the skip reason and adjust before sending again.',
  },
  stalled: {
    summary: 'We never recorded what happened to this send.',
    nextAction: 'Check the channel in Discord before sending it again.',
  },
} satisfies Record<Exclude<MessageSendStatus, 'failed'>, MessageSendGuidance>

function messageSendGuidance({
  kind,
  reason,
  status,
}: {
  kind: MessageSendFailureKind | null
  reason: MessageSendSkipReason | null
  status: MessageSendStatus
}) {
  switch (status) {
    case 'failed':
      return messageSendFailureCopy[kind ?? 'unreachable']
    case 'skipped':
      return reason
        ? messageSendSkipCopy[reason]
        : messageSendStatusCopy.skipped
    default:
      return messageSendStatusCopy[status]
  }
}

const readMessageSendStatusSchema = z.object({
  requestId: z
    .string()
    .min(1)
    .describe('The `requestId` messages_send answered with.'),
})

const sendMessageSchema = z.object({
  channelId: z
    .string()
    .min(1)
    .describe(
      'The `channelId` from channels_list — not the Discord channel snowflake.'
    ),
  content: z
    .string()
    .min(1)
    .max(2000)
    .describe(
      'The message text to post, as the owner would type it. Up to 2000 characters.'
    ),
  replyToMessageId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'The `messageId` of the message to reply to, from messages_catch_up, mentions_list or bookmarks_list — not the Discord message snowflake.'
    ),
})

export {
  TransportRejectedError,
  messageSendFailureCopy,
  messageSendGuidance,
  messageSendSkipCopy,
  messageSendStallThresholdMinutes,
  messageSendStatusCopy,
  readMessageSendStatusSchema,
  sendMessageSchema,
}

export type {
  MessageSendFailureKind,
  MessageSendGuidance,
  MessageSendSkipReason,
  MessageSendStatus,
  MessageSendTransport,
}
