import {
  ChannelType,
  DiscordAPIError,
  RESTJSONErrorCodes,
  type RESTPostAPIChannelMessagesThreadsResult,
  type RESTPostAPIChannelThreadsResult,
  Routes,
} from 'discord.js'
import {
  ThreadCreateAlreadyThreadedError,
  ThreadCreateGoneError,
  ThreadCreateRejectedError,
  type ThreadCreateTransport,
  createThreadSchema,
} from '~/business/threads.common'
import { createThread } from '~/business/threads.server'
import { restClient } from '~/mcp/discord-rest.server'
import type { McpTool } from '~/mcp/tool'

const openThroughDiscord: ThreadCreateTransport = async ({
  anchorDiscordMessageId,
  autoArchiveMinutes,
  discordChannelId,
  name,
}) => {
  try {
    const thread = (await restClient().post(
      Routes.threads(discordChannelId, anchorDiscordMessageId ?? undefined),
      {
        body: {
          auto_archive_duration: autoArchiveMinutes,
          name,
          // A thread anchored on a message takes its type from the channel the
          // message is in; one standing on its own comes back private unless
          // the request says otherwise.
          ...(anchorDiscordMessageId ? {} : { type: ChannelType.PublicThread }),
        },
      }
    )) as
      | RESTPostAPIChannelMessagesThreadsResult
      | RESTPostAPIChannelThreadsResult

    return { discordChannelId: thread.id }
  } catch (error) {
    if (error instanceof DiscordAPIError) {
      if (error.code === RESTJSONErrorCodes.UnknownMessage) {
        throw new ThreadCreateGoneError(error.message)
      }

      if (error.code === RESTJSONErrorCodes.ThreadAlreadyCreatedForMessage) {
        throw new ThreadCreateAlreadyThreadedError(error.message)
      }

      throw new ThreadCreateRejectedError(error.message)
    }

    throw error
  }
}

const threadsTools: McpTool[] = [
  {
    name: 'threads_create',
    description:
      'Create a public thread as your bot, either anchored on a message the bot has ingested (`messageId`) or standing on its own in a channel (`channelId`) — one of the two, never both. Answers with `thread`, whose `status` must be read: created means the thread is live in Discord, skipped means none was created and `reason` says why, failed means Discord refused it or could not be reached. A created thread comes back with a `channelId` of its own — pass that straight to messages_send to post into the thread, which is how several messages stay together instead of interleaving with the rest of the channel. It shows up in channels_list immediately, filed under the name of the channel it hangs in. Discord archives a thread after 7 days without a message, and a new message brings it back. Read `summary` and `nextAction` to the owner rather than creating it again.',
    inputSchema: createThreadSchema,
    wraps: ['threads.createThread'],
    execute: (input, context) =>
      createThread(openThroughDiscord)(input, context),
  },
]

export { threadsTools }
