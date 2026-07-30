import { fromSuccess, isContextError } from 'composable-functions'
import { listChannels } from '~/business/channels.server'
import { newId } from '~/framework/db.server'
import { createChannel, createGuild, ownerContext } from '~/test/fixtures'
import { db, describe, expect, it } from '~/test/prelude'

describe('listChannels', () => {
  it('describes each channel by its newest detail snapshot', async () => {
    const guild = await createGuild()
    const channel = await createChannel({
      guildId: guild.id,
      name: 'as-first-seen',
      topic: 'as first seen',
      category: 'General',
      isThread: 0,
      position: 0,
    })

    await db()
      .insertInto('channelDetailRevisions')
      .values({
        id: newId(),
        channelId: channel.id,
        name: 'after-the-rename',
        topic: 'after the rename',
        category: 'Product',
        isThread: 1,
        position: 3,
        createdAt: '2099-01-01T00:00:00.000Z',
      })
      .execute()

    const { channels } = await fromSuccess(listChannels)(
      {},
      await ownerContext({ guildId: guild.id })
    )

    expect(channels).toEqual([
      {
        id: channel.id,
        discordChannelId: channel.discordChannelId,
        name: 'after-the-rename',
        topic: 'after the rename',
        category: 'Product',
        isThread: true,
        position: 3,
      },
    ])
  })

  it('leaves out channels the bot no longer sees', async () => {
    const guild = await createGuild()
    const visible = await createChannel({ guildId: guild.id })
    const removed = await createChannel({ guildId: guild.id })

    await db()
      .insertInto('channelRemovals')
      .values({ id: newId(), channelId: removed.id })
      .execute()

    const { channels } = await fromSuccess(listChannels)(
      {},
      await ownerContext({ guildId: guild.id })
    )

    expect(channels.map(({ id }) => id)).toEqual([visible.id])
  })

  it('orders channels by category, then position, then name', async () => {
    const guild = await createGuild()
    const announcements = await createChannel({
      guildId: guild.id,
      category: 'Company',
      position: 0,
      name: 'announcements',
    })
    const watercooler = await createChannel({
      guildId: guild.id,
      category: 'Company',
      position: 1,
      name: 'watercooler',
    })
    const alerts = await createChannel({
      guildId: guild.id,
      category: 'Company',
      position: 1,
      name: 'alerts',
    })
    const roadmap = await createChannel({
      guildId: guild.id,
      category: 'Product',
      position: 0,
      name: 'roadmap',
    })

    const { channels } = await fromSuccess(listChannels)(
      {},
      await ownerContext({ guildId: guild.id })
    )

    expect(channels.map(({ id }) => id)).toEqual([
      announcements.id,
      alerts.id,
      watercooler.id,
      roadmap.id,
    ])
  })

  it('only lists channels of the configured server', async () => {
    const guild = await createGuild()
    const otherGuild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    await createChannel({ guildId: otherGuild.id })

    const { channels } = await fromSuccess(listChannels)(
      {},
      await ownerContext({ guildId: guild.id })
    )

    expect(channels.map(({ id }) => id)).toEqual([channel.id])
  })

  it('refuses a context that cannot read messages', async () => {
    const guild = await createGuild()
    const context = await ownerContext({ guildId: guild.id })

    const result = await listChannels(
      {},
      { ...context, canReadMessages: false }
    )

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(isContextError(result.errors[0])).toBe(true)
  })
})
