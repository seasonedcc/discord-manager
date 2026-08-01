import { InputError, applySchema } from 'composable-functions'
import { z } from 'zod'
import { ownerContextSchema } from '~/business/auth.server'
import {
  type MessageFetchFailureKind,
  MessageFetchGoneError,
  MessageFetchRejectedError,
  type MessageFetchTransport,
  fetchMessageSchema,
  messageFetchGuidance,
  renderEmbed,
} from '~/business/messages.common'
import { db } from '~/db/db.server'
import { newId } from '~/framework/db.server'

const messagesContextSchema = ownerContextSchema.extend({
  canReadMessages: z.literal(true),
})

function failureKindOf(error: unknown): MessageFetchFailureKind {
  if (error instanceof MessageFetchGoneError) return 'gone'
  if (error instanceof MessageFetchRejectedError) return 'rejected'

  return 'unreachable'
}

function fetchMessage(transport: MessageFetchTransport) {
  return applySchema(
    fetchMessageSchema,
    messagesContextSchema
  )(async ({ messageId }, context) => {
    const found = await db()
      .selectFrom('messages')
      .innerJoin('channels', 'channels.id', 'messages.channelId')
      .innerJoin('guilds', 'guilds.id', 'channels.guildId')
      .where('messages.id', '=', messageId)
      .where('guilds.discordGuildId', '=', context.owner.guildId)
      .select((eb) => [
        'messages.id as messageId',
        'messages.channelId',
        'messages.discordMessageId',
        'channels.discordChannelId',
        'guilds.discordGuildId',
        eb
          .exists(
            eb
              .selectFrom('messageDeletions')
              .select('messageDeletions.id')
              .whereRef('messageDeletions.messageId', '=', 'messages.id')
          )
          .$castTo<number>()
          .as('deleted'),
      ])
      .executeTakeFirst()

    if (!found) {
      throw new InputError(
        'No message with that id has been ingested. Catch up on a channel to pick one.',
        ['messageId']
      )
    }

    const { deleted, discordGuildId, ...message } = found
    const located = {
      ...message,
      jumpUrl: `https://discord.com/channels/${discordGuildId}/${message.discordChannelId}/${message.discordMessageId}`,
    }

    const request = await db()
      .insertInto('messageFetchRequests')
      .values({ id: newId(), messageId: message.messageId })
      .returning('id')
      .executeTakeFirstOrThrow()

    if (deleted === 1) {
      const reason = 'message_deleted' as const

      await db()
        .insertInto('messageFetchSkips')
        .values({ id: newId(), messageFetchRequestId: request.id, reason })
        .execute()

      return {
        message: {
          ...located,
          status: 'skipped' as const,
          reason,
          ...messageFetchGuidance({ reason, status: 'skipped' }),
        },
      }
    }

    let live: Awaited<ReturnType<MessageFetchTransport>>

    try {
      live = await transport({
        discordChannelId: message.discordChannelId,
        discordMessageId: message.discordMessageId,
      })
    } catch (error) {
      const kind = failureKindOf(error)

      await db()
        .insertInto('messageFetchFailures')
        .values({
          id: newId(),
          kind,
          messageFetchRequestId: request.id,
          errorMessage: error instanceof Error ? error.message : String(error),
        })
        .execute()

      return {
        message: {
          ...located,
          status: 'failed' as const,
          ...messageFetchGuidance({ kind, status: 'failed' }),
        },
      }
    }

    const retrieval = await db()
      .insertInto('messageFetchRetrievals')
      .values({ id: newId(), messageFetchRequestId: request.id })
      .returning('createdAt')
      .executeTakeFirstOrThrow()

    return {
      message: {
        ...located,
        attachments: live.attachments,
        content: live.content,
        embeds: live.embeds.flatMap((embed) => {
          const text = renderEmbed(embed)

          return text ? [text] : []
        }),
        fetchedAt: retrieval.createdAt,
        reactions: live.reactions.map(
          ({ count, emoji, reactorDiscordUserIds }) => ({
            count,
            emoji,
            ownerReacted: reactorDiscordUserIds.includes(
              context.owner.discordUserId
            ),
          })
        ),
        status: 'retrieved' as const,
        ...messageFetchGuidance({ status: 'retrieved' }),
      },
    }
  })
}

export { fetchMessage }
