import { isContextError, isInputError } from 'composable-functions'
import {
  messageSendRetryRefusalCopy,
  messageSendSkipCopy,
} from '~/business/sending.common'
import { newId } from '~/framework/db.server'
import { callTool } from '~/mcp/server.server'
import { createChannel, createGuild, ownerContext } from '~/test/fixtures'
import { db, describe, expect, it } from '~/test/prelude'

async function callAsOwner(name: string, input: unknown, context: unknown) {
  const result = await callTool({ name, arguments: input }, context)
  const [content] = result.content

  if (content?.type !== 'text') throw new Error('expected a text tool result')

  return { isError: result.isError === true, payload: JSON.parse(content.text) }
}

describe('messages_send', () => {
  it('records the skip when a message carries no visible text', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })

    const { isError, payload } = await callAsOwner(
      'messages_send',
      { channelId: channel.id, content: '   ' },
      await ownerContext({ guildId: guild.id })
    )

    const skips = await db()
      .selectFrom('messageSendSkips')
      .selectAll()
      .where('messageSendRequestId', '=', payload.send.requestId)
      .execute()

    expect(isError).toBe(false)
    expect(payload.send).toMatchObject({
      status: 'skipped',
      reason: 'empty_content',
      ...messageSendSkipCopy.empty_content,
    })
    expect(skips).toHaveLength(1)
    expect(skips[0].reason).toBe('empty_content')
  })

  it('refuses a context that cannot send messages', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const context = await ownerContext({ guildId: guild.id })

    const { isError, payload } = await callAsOwner(
      'messages_send',
      { channelId: channel.id, content: 'not allowed' },
      { ...context, canSendMessages: false }
    )

    expect(isError).toBe(true)
    expect(isContextError(payload.errors[0])).toBe(true)
    expect(payload.errors[0].path).toEqual(['canSendMessages'])
  })

  it('refuses to retry a send that was skipped for a channel the bot lost', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const lostChannel = await createChannel({ guildId: guild.id })
    const context = await ownerContext({ guildId: guild.id })

    await db()
      .insertInto('channelRemovals')
      .values({ id: newId(), channelId: lostChannel.id })
      .execute()

    const skipped = await callAsOwner(
      'messages_send',
      { channelId: lostChannel.id, content: 'anybody there' },
      context
    )
    const { isError, payload } = await callAsOwner(
      'messages_send',
      {
        channelId: channel.id,
        content: 'anybody there',
        retryOfRequestId: skipped.payload.send.requestId,
      },
      context
    )

    expect(isError).toBe(true)
    expect(isInputError(payload.errors[0])).toBe(true)
    expect(payload.errors[0].message).toBe(
      messageSendRetryRefusalCopy.channel_not_found
    )
    expect(payload.errors[0].path).toEqual(['retryOfRequestId'])
  })
})

describe('messages_send_status', () => {
  it('reads where a send the owner issued ended up', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const context = await ownerContext({ guildId: guild.id })

    const sent = await callAsOwner(
      'messages_send',
      { channelId: channel.id, content: '   ' },
      context
    )
    const { isError, payload } = await callAsOwner(
      'messages_send_status',
      { requestId: sent.payload.send.requestId },
      context
    )

    expect(isError).toBe(false)
    expect(payload.send).toMatchObject({
      requestId: sent.payload.send.requestId,
      status: 'skipped',
      reason: 'empty_content',
      canRetry: true,
      retryOfRequestId: null,
      retries: [],
      ...messageSendSkipCopy.empty_content,
    })
  })

  it('refuses a context that cannot send messages', async () => {
    const guild = await createGuild()
    const context = await ownerContext({ guildId: guild.id })

    const { isError, payload } = await callAsOwner(
      'messages_send_status',
      { requestId: newId() },
      { ...context, canSendMessages: false }
    )

    expect(isError).toBe(true)
    expect(isContextError(payload.errors[0])).toBe(true)
    expect(payload.errors[0].path).toEqual(['canSendMessages'])
  })
})
