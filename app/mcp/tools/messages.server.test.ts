import { randomUUID } from 'node:crypto'
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

describe('messages_count', () => {
  it('answers with a count per day and the reach of the matching history', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const needle = randomUUID()

    for (const discordCreatedAt of [
      '2026-03-02T09:00:00.000Z',
      '2026-03-02T21:00:00.000Z',
      '2026-03-05T09:00:00.000Z',
    ]) {
      await createMessage({
        channelId: channel.id,
        content: '',
        discordCreatedAt,
        embeds: [`Checkout is failing, ${needle}`],
      })
    }

    const { isError, payload } = await callAsOwner(
      'messages_count',
      {
        channelId: channel.id,
        contentContains: `checkout is failing, ${needle}`,
        groupBy: 'day',
      },
      await ownerContext({ guildId: guild.id })
    )

    expect(isError).toBe(false)
    expect(payload).toEqual({
      days: [
        { date: '2026-03-02', count: 2 },
        { date: '2026-03-05', count: 1 },
      ],
      newestMatch: '2026-03-05T09:00:00.000Z',
      oldestMatch: '2026-03-02T09:00:00.000Z',
      total: 3,
    })
  })

  it('leaves days out of the answer when no grouping was asked for', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const needle = randomUUID()

    await createMessage({
      channelId: channel.id,
      content: `alarm, ${needle}`,
      discordCreatedAt: '2026-03-02T09:00:00.000Z',
    })

    const { isError, payload } = await callAsOwner(
      'messages_count',
      { channelId: channel.id, contentContains: needle },
      await ownerContext({ guildId: guild.id })
    )

    expect(isError).toBe(false)
    expect(payload).toEqual({
      newestMatch: '2026-03-02T09:00:00.000Z',
      oldestMatch: '2026-03-02T09:00:00.000Z',
      total: 1,
    })
  })

  it('refuses a context that cannot read messages', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const context = await ownerContext({ guildId: guild.id })

    const { isError, payload } = await callAsOwner(
      'messages_count',
      { channelId: channel.id },
      { ...context, canReadMessages: false }
    )

    expect(isError).toBe(true)
    expect(isContextError(payload.errors[0])).toBe(true)
    expect(payload.errors[0].path).toEqual(['canReadMessages'])
  })
})
