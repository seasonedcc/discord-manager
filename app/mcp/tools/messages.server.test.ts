import { isContextError } from 'composable-functions'
import { messageFetchSkipCopy } from '~/business/messages.common'
import { db } from '~/db/db.server'
import { newId } from '~/framework/db.server'
import { callTool } from '~/mcp/server.server'
import {
  createChannel,
  createGuild,
  createMessage,
  ownerContext,
} from '~/test/fixtures'
import { describe, expect, it } from '~/test/prelude'

async function callAsOwner(name: string, input: unknown, context: unknown) {
  const result = await callTool({ name, arguments: input }, context)
  const [content] = result.content

  if (content?.type !== 'text') throw new Error('expected a text tool result')

  return { isError: result.isError === true, payload: JSON.parse(content.text) }
}

describe('messages_fetch', () => {
  it('records the skip when the store already knows the message was deleted', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const message = await createMessage({ channelId: channel.id })

    await db()
      .insertInto('messageDeletions')
      .values({ id: newId(), messageId: message.id })
      .execute()

    const { isError, payload } = await callAsOwner(
      'messages_fetch',
      { messageId: message.id },
      await ownerContext({ guildId: guild.id })
    )

    const skips = await db()
      .selectFrom('messageFetchSkips')
      .innerJoin(
        'messageFetchRequests',
        'messageFetchRequests.id',
        'messageFetchSkips.messageFetchRequestId'
      )
      .selectAll('messageFetchSkips')
      .where('messageFetchRequests.messageId', '=', message.id)
      .execute()

    expect(isError).toBe(false)
    expect(payload.message).toMatchObject({
      messageId: message.id,
      reason: 'message_deleted',
      status: 'skipped',
      ...messageFetchSkipCopy.message_deleted,
    })
    expect(skips).toHaveLength(1)
    expect(skips[0].reason).toBe('message_deleted')
  })

  it('refuses a context that cannot read messages', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const message = await createMessage({ channelId: channel.id })
    const context = await ownerContext({ guildId: guild.id })

    const { isError, payload } = await callAsOwner(
      'messages_fetch',
      { messageId: message.id },
      { ...context, canReadMessages: false }
    )

    expect(isError).toBe(true)
    expect(isContextError(payload.errors[0])).toBe(true)
    expect(payload.errors[0].path).toEqual(['canReadMessages'])
  })
})
