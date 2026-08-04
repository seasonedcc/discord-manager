import { ContextError, fromSuccess, isContextError } from 'composable-functions'
import { listMembers } from '~/business/members.server'
import { newId } from '~/framework/db.server'
import {
  createChannel,
  createGatewayIdentification,
  createGuild,
  createMember,
  createMessage,
  ownerContext,
} from '~/test/fixtures'
import { db, describe, expect, it } from '~/test/prelude'

async function somebodyWhoPosted(
  channelId: string,
  details: { displayName: string; username: string }
) {
  const member = await createMember(details)

  await createMessage({ authorMemberId: member.id, channelId })

  return member
}

describe('listMembers', () => {
  it('answers with everyone the bot has seen post in the server, by display name', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const omar = await somebodyWhoPosted(channel.id, {
      displayName: 'Omar Duarte',
      username: 'omar',
    })
    const maya = await somebodyWhoPosted(channel.id, {
      displayName: 'Maya Fischer',
      username: 'maya',
    })

    const { members } = await fromSuccess(listMembers)(
      {},
      await ownerContext({ guildId: guild.id })
    )

    expect(members).toEqual([
      {
        discordUserId: maya.discordUserId,
        displayName: 'Maya Fischer',
        username: 'maya',
      },
      {
        discordUserId: omar.discordUserId,
        displayName: 'Omar Duarte',
        username: 'omar',
      },
    ])
  })

  it('answers with the name each person carries right now', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const priya = await somebodyWhoPosted(channel.id, {
      displayName: 'Priya Raman',
      username: 'priya',
    })

    await db()
      .insertInto('memberDetailRevisions')
      .values({
        createdAt: '2099-01-01T00:00:00.000Z',
        displayName: 'Priya R.',
        id: newId(),
        memberId: priya.id,
        username: 'priya.raman',
      })
      .execute()

    const { members } = await fromSuccess(listMembers)(
      {},
      await ownerContext({ guildId: guild.id })
    )

    expect(members).toEqual([
      {
        discordUserId: priya.discordUserId,
        displayName: 'Priya R.',
        username: 'priya.raman',
      },
    ])
  })

  it('matches part of a display name whatever its case, accents included', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const devid = await somebodyWhoPosted(channel.id, {
      displayName: 'Dêvid',
      username: 'devid.souza',
    })
    await somebodyWhoPosted(channel.id, {
      displayName: 'Maya Fischer',
      username: 'maya',
    })

    const { members } = await fromSuccess(listMembers)(
      { query: 'DÊVID' },
      await ownerContext({ guildId: guild.id })
    )

    expect(members).toEqual([
      {
        discordUserId: devid.discordUserId,
        displayName: 'Dêvid',
        username: 'devid.souza',
      },
    ])
  })

  it('matches part of a username the display name never spells', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const devid = await somebodyWhoPosted(channel.id, {
      displayName: 'Dêvid',
      username: 'devid.souza',
    })
    await somebodyWhoPosted(channel.id, {
      displayName: 'Maya Fischer',
      username: 'maya',
    })

    const { members } = await fromSuccess(listMembers)(
      { query: 'SOUZA' },
      await ownerContext({ guildId: guild.id })
    )

    expect(members).toEqual([
      {
        discordUserId: devid.discordUserId,
        displayName: 'Dêvid',
        username: 'devid.souza',
      },
    ])
  })

  it('answers with nobody when no name carries the text asked for', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    await somebodyWhoPosted(channel.id, {
      displayName: 'Maya Fischer',
      username: 'maya',
    })

    const { members } = await fromSuccess(listMembers)(
      { query: `nobody-${crypto.randomUUID()}` },
      await ownerContext({ guildId: guild.id })
    )

    expect(members).toEqual([])
  })

  it('marks the bot this deployment posts through now, and nobody else', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const bot = await somebodyWhoPosted(channel.id, {
      displayName: 'Robin Manager',
      username: 'robin-manager',
    })
    const uptime = await somebodyWhoPosted(channel.id, {
      displayName: 'Uptime Watch',
      username: 'uptime-watch',
    })

    await createGatewayIdentification({
      botDiscordUserId: uptime.discordUserId,
      guildId: guild.id,
      identifiedAt: '2020-01-01T00:00:00.000Z',
    })
    await createGatewayIdentification({
      botDiscordUserId: bot.discordUserId,
      guildId: guild.id,
      identifiedAt: '2099-01-01T00:00:00.000Z',
    })

    const { members } = await fromSuccess(listMembers)(
      {},
      await ownerContext({ guildId: guild.id })
    )

    expect(members).toEqual([
      {
        discordUserId: bot.discordUserId,
        displayName: 'Robin Manager',
        isYourBot: true,
        username: 'robin-manager',
      },
      {
        discordUserId: uptime.discordUserId,
        displayName: 'Uptime Watch',
        username: 'uptime-watch',
      },
    ])
  })

  it('answers with nobody when the bot has seen no one post in the server', async () => {
    const elsewhere = await createGuild()
    const channelElsewhere = await createChannel({ guildId: elsewhere.id })
    await somebodyWhoPosted(channelElsewhere.id, {
      displayName: 'Maya Fischer',
      username: 'maya',
    })

    const guild = await createGuild()

    const { members } = await fromSuccess(listMembers)(
      {},
      await ownerContext({ guildId: guild.id })
    )

    expect(members).toEqual([])
  })

  it('refuses a context that cannot read messages', async () => {
    const guild = await createGuild()
    const context = await ownerContext({ guildId: guild.id })

    const result = await listMembers({}, { ...context, canReadMessages: false })

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    const [error] = result.errors

    expect(isContextError(error)).toBe(true)
    if (!(error instanceof ContextError))
      throw new Error('expected a context error')
    expect(error.path).toEqual(['canReadMessages'])
  })
})
