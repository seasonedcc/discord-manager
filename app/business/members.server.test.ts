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
    const jose = await somebodyWhoPosted(channel.id, {
      displayName: 'José Álvarez',
      username: 'zeca.alvarez',
    })
    await somebodyWhoPosted(channel.id, {
      displayName: 'Maya Fischer',
      username: 'maya',
    })

    const { members } = await fromSuccess(listMembers)(
      { query: 'JOSÉ' },
      await ownerContext({ guildId: guild.id })
    )

    expect(members).toEqual([
      {
        discordUserId: jose.discordUserId,
        displayName: 'José Álvarez',
        username: 'zeca.alvarez',
      },
    ])
  })

  it('matches part of a username the display name never spells', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const jose = await somebodyWhoPosted(channel.id, {
      displayName: 'José Álvarez',
      username: 'zeca.alvarez',
    })
    await somebodyWhoPosted(channel.id, {
      displayName: 'Maya Fischer',
      username: 'maya',
    })

    const { members } = await fromSuccess(listMembers)(
      { query: 'ZECA' },
      await ownerContext({ guildId: guild.id })
    )

    expect(members).toEqual([
      {
        discordUserId: jose.discordUserId,
        displayName: 'José Álvarez',
        username: 'zeca.alvarez',
      },
    ])
  })

  it('matches a name spelled with a dotted capital İ from a plainly typed query', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const irem = await somebodyWhoPosted(channel.id, {
      displayName: 'İrem Kaya',
      username: 'kaya',
    })
    await somebodyWhoPosted(channel.id, {
      displayName: 'Maya Fischer',
      username: 'maya',
    })

    const { members } = await fromSuccess(listMembers)(
      { query: 'irem' },
      await ownerContext({ guildId: guild.id })
    )

    expect(members).toEqual([
      {
        discordUserId: irem.discordUserId,
        displayName: 'İrem Kaya',
        username: 'kaya',
      },
    ])
  })

  it('matches a plainly spelled name from a query typed with a dotted capital İ', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const irem = await somebodyWhoPosted(channel.id, {
      displayName: 'Irem Yilmaz',
      username: 'yilmaz',
    })

    const { members } = await fromSuccess(listMembers)(
      { query: 'İREM' },
      await ownerContext({ guildId: guild.id })
    )

    expect(members).toEqual([
      {
        discordUserId: irem.discordUserId,
        displayName: 'Irem Yilmaz',
        username: 'yilmaz',
      },
    ])
  })

  it('matches a plainly spelled name from a query typed with a dotless ı', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const isabel = await somebodyWhoPosted(channel.id, {
      displayName: 'Isabel Ferreira',
      username: 'ferreira',
    })

    const { members } = await fromSuccess(listMembers)(
      { query: 'ısabel' },
      await ownerContext({ guildId: guild.id })
    )

    expect(members).toEqual([
      {
        discordUserId: isabel.discordUserId,
        displayName: 'Isabel Ferreira',
        username: 'ferreira',
      },
    ])
  })

  it('tells an accented letter apart from the plain one it looks like', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const jose = await somebodyWhoPosted(channel.id, {
      displayName: 'José Álvarez',
      username: 'zeca.alvarez',
    })

    const context = await ownerContext({ guildId: guild.id })
    const { members: plain } = await fromSuccess(listMembers)(
      { query: 'jose' },
      context
    )
    const { members: accented } = await fromSuccess(listMembers)(
      { query: 'JOSÉ' },
      context
    )

    expect(plain).toEqual([])
    expect(accented).toEqual([
      {
        discordUserId: jose.discordUserId,
        displayName: 'José Álvarez',
        username: 'zeca.alvarez',
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
