import { fromSuccess, isContextError } from 'composable-functions'
import { listChannels } from '~/business/channels.server'
import { newId } from '~/framework/db.server'
import { createChannel, createGuild, ownerContext } from '~/test/fixtures'
import { db, describe, expect, it } from '~/test/prelude'

describe('listChannels', () => {
  it('describes each channel by its newest name, thread flag and attributes', async () => {
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
        isThread: 0,
        createdAt: '2099-01-01T00:00:00.000Z',
      })
      .execute()
    await db()
      .insertInto('channelTopicChanges')
      .values({
        id: newId(),
        channelId: channel.id,
        topic: 'after the rename',
        createdAt: '2099-01-01T00:00:00.000Z',
      })
      .execute()
    await db()
      .insertInto('channelCategoryChanges')
      .values({
        id: newId(),
        channelId: channel.id,
        category: 'Product',
        createdAt: '2099-01-01T00:00:00.000Z',
      })
      .execute()
    await db()
      .insertInto('channelPositionChanges')
      .values({
        id: newId(),
        channelId: channel.id,
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
        channelId: channel.id,
        discordChannelId: channel.discordChannelId,
        name: 'after-the-rename',
        topic: 'after the rename',
        category: 'Product',
        isThread: false,
        position: 3,
      },
    ])
  })

  it('leaves out the attributes a channel never had', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id, name: 'loose' })

    const { channels } = await fromSuccess(listChannels)(
      {},
      await ownerContext({ guildId: guild.id })
    )

    expect(channels).toEqual([
      {
        channelId: channel.id,
        discordChannelId: channel.discordChannelId,
        name: 'loose',
        isThread: false,
      },
    ])
  })

  it('tells an emptied topic apart from a topic the channel still carries', async () => {
    const guild = await createGuild()
    const blank = await createChannel({ guildId: guild.id, topic: '' })
    const cleared = await createChannel({
      guildId: guild.id,
      topic: 'about to go',
    })

    await db()
      .insertInto('channelTopicClearings')
      .values({
        id: newId(),
        channelId: cleared.id,
        createdAt: '2099-01-01T00:00:00.000Z',
      })
      .execute()

    const { channels } = await fromSuccess(listChannels)(
      {},
      await ownerContext({ guildId: guild.id })
    )
    const listed = new Map(
      channels.map((channel) => [channel.channelId, channel])
    )

    expect(listed.get(blank.id)).toHaveProperty('topic', '')
    expect(listed.get(cleared.id)).not.toHaveProperty('topic')
  })

  it('reads the newest of a category set, cleared and set again', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id, category: 'Old' })

    await db()
      .insertInto('channelCategoryClearings')
      .values({
        id: newId(),
        channelId: channel.id,
        createdAt: '2099-01-01T00:00:00.000Z',
      })
      .execute()
    await db()
      .insertInto('channelCategoryChanges')
      .values({
        id: newId(),
        channelId: channel.id,
        category: 'New',
        createdAt: '2099-01-02T00:00:00.000Z',
      })
      .execute()

    const { channels } = await fromSuccess(listChannels)(
      {},
      await ownerContext({ guildId: guild.id })
    )

    expect(channels[0].category).toBe('New')
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

    expect(channels.map(({ channelId }) => channelId)).toEqual([visible.id])
  })

  it('sorts uncategorized channels first, then by category, position and name', async () => {
    const guild = await createGuild()
    const loose = await createChannel({ guildId: guild.id, name: 'loose-talk' })
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

    expect(channels.map(({ channelId }) => channelId)).toEqual([
      loose.id,
      announcements.id,
      alerts.id,
      watercooler.id,
      roadmap.id,
    ])
  })

  it('sorts threads after the channels they hang from', async () => {
    const guild = await createGuild()
    const thread = await createChannel({
      guildId: guild.id,
      category: 'Company',
      isThread: 1,
      name: 'a-thread',
    })
    const channel = await createChannel({
      guildId: guild.id,
      category: 'Teams',
      position: 9,
      name: 'z-channel',
    })

    const { channels } = await fromSuccess(listChannels)(
      {},
      await ownerContext({ guildId: guild.id })
    )

    expect(channels.map(({ channelId }) => channelId)).toEqual([
      channel.id,
      thread.id,
    ])
    expect(channels[1]).not.toHaveProperty('position')
  })

  it('says which threads Discord has archived and which are still in use', async () => {
    const guild = await createGuild()
    const inUse = await createChannel({ guildId: guild.id, isThread: 1 })
    const archived = await createChannel({
      guildId: guild.id,
      archived: true,
      isThread: 1,
    })

    const { channels } = await fromSuccess(listChannels)(
      {},
      await ownerContext({ guildId: guild.id })
    )
    const archivedOf = (channelId: string) =>
      channels.find((channel) => channel.channelId === channelId)?.archived

    expect(archivedOf(inUse.id)).toBe(false)
    expect(archivedOf(archived.id)).toBe(true)
  })

  it('counts a thread as in use again once it has been unarchived', async () => {
    const guild = await createGuild()
    const revived = await createChannel({
      guildId: guild.id,
      archived: true,
      isThread: 1,
    })

    await db()
      .insertInto('channelUnarchivings')
      .values({
        id: newId(),
        channelId: revived.id,
        createdAt: '2099-01-01T00:00:00.000Z',
      })
      .execute()

    const { channels } = await fromSuccess(listChannels)(
      {},
      await ownerContext({ guildId: guild.id })
    )

    expect(channels[0].archived).toBe(false)
  })

  it('leaves the archived flag off a channel that is not a thread', async () => {
    const guild = await createGuild()
    await createChannel({ guildId: guild.id })

    const { channels } = await fromSuccess(listChannels)(
      {},
      await ownerContext({ guildId: guild.id })
    )

    expect(channels[0]).not.toHaveProperty('archived')
  })

  it('sorts archived threads after the threads still in use', async () => {
    const guild = await createGuild()
    const archived = await createChannel({
      guildId: guild.id,
      archived: true,
      category: 'Company',
      isThread: 1,
      name: 'a-forgotten-thread',
    })
    const inUse = await createChannel({
      guildId: guild.id,
      category: 'Teams',
      isThread: 1,
      name: 'z-busy-thread',
    })
    const channel = await createChannel({
      guildId: guild.id,
      name: 'a-channel',
    })

    const { channels } = await fromSuccess(listChannels)(
      {},
      await ownerContext({ guildId: guild.id })
    )

    expect(channels.map(({ channelId }) => channelId)).toEqual([
      channel.id,
      inUse.id,
      archived.id,
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

    expect(channels.map(({ channelId }) => channelId)).toEqual([channel.id])
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
