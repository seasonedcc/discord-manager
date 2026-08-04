import { z } from 'zod'

// A send is a single REST call with no scheduled retry, so nothing can still be
// working on a request that has gone this long without recording an outcome.
const messageSendStallThresholdMinutes = 15

const messageContentLimit = 2000

const channelIdMessage =
  'Pass a `channelId` from channels_list, not the Discord channel snowflake'

const contentMessage = `Write the message text to post, up to ${messageContentLimit} characters`

const replyToMessageIdMessage =
  'Pass the `messageId` of a message in the channel you are posting to, from messages_catch_up, mentions_list or bookmarks_list, or leave it out to post on its own'

const requestIdMessage = 'Pass the `requestId` messages_send answered with'

const retryOfRequestIdMessage =
  'Pass the `requestId` of the earlier send this one is another attempt at, or leave it out to post a fresh message'

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
      'Pick a channel from the server this deployment manages, then send that message there.',
  },
  empty_content: {
    summary: 'The message had no visible text, so nothing was posted.',
    nextAction:
      "Write the message text, then send it again with `retryOfRequestId` set to this send's request id.",
  },
} satisfies Record<MessageSendSkipReason, MessageSendGuidance>

const messageSendFailureCopy = {
  rejected: {
    summary: 'Discord refused the message, so it was never posted.',
    nextAction:
      "Give the bot Send Messages (and Send Messages in Threads) in that channel and check DISCORD_BOT_TOKEN, then send it again with `retryOfRequestId` set to this send's request id.",
  },
  unreachable: {
    summary:
      'We could not reach Discord, so the message may or may not have posted.',
    nextAction: 'Check the channel in Discord before sending it again.',
  },
} satisfies Record<MessageSendFailureKind, MessageSendGuidance>

type MessageSendLiveRisk = 'delivered' | 'pending' | 'stalled' | 'unreachable'

type MessageSendRetryGround =
  | MessageSendLiveRisk
  | 'channel_not_found'
  | 'channel_not_in_guild'
  | 'skipped'

const messageSendFailureLiveRisk = {
  rejected: null,
  unreachable: 'unreachable',
} satisfies Record<MessageSendFailureKind, MessageSendLiveRisk | null>

const messageSendSkipRetryGround = {
  channel_not_found: 'channel_not_found',
  channel_not_in_guild: 'channel_not_in_guild',
  empty_content: null,
} satisfies Record<MessageSendSkipReason, MessageSendRetryGround | null>

const messageSendRetryRefusalCopy = {
  channel_not_found:
    'That channel is gone from the bot, so no further attempt at that send can reach it. Pick a channel the bot can still see and send that message fresh.',
  channel_not_in_guild:
    'That channel belongs to a different Discord server than this deployment manages, so no attempt at that send can reach it. Pick a channel from this server and send that message fresh.',
  delivered:
    'That message is already live in the channel, so sending it again would post it twice.',
  pending:
    'That send is still on its way to Discord. Read its status again in a moment to see where it landed.',
  skipped:
    'That send never went out. Read its status for what to change before sending that message again.',
  stalled:
    'We never recorded what happened to that send, so it may already be live in the channel. Check the channel in Discord before sending that message again.',
  unreachable:
    'We could not reach Discord on that send, so it may already be live in the channel. Check the channel in Discord before sending that message again.',
} satisfies Record<MessageSendRetryGround, string>

const messageSendRetryChainRefusalCopy = {
  delivered:
    'A retry of that send is already live in the channel, so sending it again would post it twice.',
  pending:
    'A retry of that send is still on its way to Discord. Read its status again in a moment to see where it landed.',
  stalled:
    'We never recorded what happened to a retry of that send, so it may already be live in the channel. Check the channel in Discord before sending that message again.',
  unreachable:
    'We could not reach Discord on a retry of that send, so it may already be live in the channel. Check the channel in Discord before sending that message again.',
} satisfies Record<MessageSendLiveRisk, string>

function messageSendLiveRisk({
  kind,
  status,
}: {
  kind: MessageSendFailureKind | null
  status: MessageSendStatus
}) {
  switch (status) {
    case 'delivered':
      return 'delivered'
    case 'pending':
      return 'pending'
    case 'stalled':
      return 'stalled'
    case 'failed':
      return messageSendFailureLiveRisk[kind ?? 'unreachable']
    default:
      return null
  }
}

function messageSendRetryGround({
  kind,
  reason,
  status,
}: {
  kind: MessageSendFailureKind | null
  reason: MessageSendSkipReason | null
  status: MessageSendStatus
}) {
  const risk = messageSendLiveRisk({ kind, status })

  if (risk) return risk
  if (status !== 'skipped') return null

  return reason ? messageSendSkipRetryGround[reason] : 'skipped'
}

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
    .string({ error: requestIdMessage })
    .min(1, requestIdMessage)
    .describe('The `requestId` messages_send answered with.'),
})

const sendMessageSchema = z.object({
  channelId: z
    .string({ error: channelIdMessage })
    .min(1, channelIdMessage)
    .describe(
      'The `channelId` from channels_list — not the Discord channel snowflake.'
    ),
  content: z
    .string({ error: contentMessage })
    .min(1, contentMessage)
    .max(messageContentLimit, contentMessage)
    .describe(
      `The message text to post, as the owner would type it. Up to ${messageContentLimit} characters.`
    ),
  replyToMessageId: z
    .string({ error: replyToMessageIdMessage })
    .min(1, replyToMessageIdMessage)
    .optional()
    .describe(
      'The `messageId` of the message to reply to, from messages_catch_up, mentions_list or bookmarks_list — not the Discord message snowflake. It has to be a message in `channelId`: Discord only attaches a reply to a message in the same channel.'
    ),
  retryOfRequestId: z
    .string({ error: retryOfRequestIdMessage })
    .min(1, retryOfRequestIdMessage)
    .optional()
    .describe(
      'The `requestId` of an earlier send this one is another attempt at. The send is refused unless that earlier attempt provably never reached the channel, so retrying can never post the same message twice. Read `canRetry` from messages_send_status first.'
    ),
})

export {
  TransportRejectedError,
  messageSendFailureCopy,
  messageSendGuidance,
  messageSendLiveRisk,
  messageSendRetryChainRefusalCopy,
  messageSendRetryGround,
  messageSendRetryRefusalCopy,
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
