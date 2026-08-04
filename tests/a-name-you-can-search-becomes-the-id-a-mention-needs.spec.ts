import assert from 'node:assert/strict'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { test } from './spec'

type MemberList = {
  members: {
    discordUserId: string
    displayName: string
    isYourBot?: boolean
    username: string
  }[]
}

type Digest = {
  messages: { content: string; messageId: string }[]
}

test('a name you can search becomes the id a mention needs', async () => {
  const { bot, botAnswers, clock, members, owner } = fixtures()
  const session = await openMcpSession()

  const found = await session.call<MemberList>('members_list', {
    query: 'FISCH',
  })

  assert.deepEqual(found.members, [
    {
      discordUserId: members.maya.discordUserId,
      displayName: members.maya.displayName,
      username: members.maya.username,
    },
  ])

  const everyone = await session.call<MemberList>('members_list')
  const entryFor = (discordUserId: string) =>
    everyone.members.filter((member) => member.discordUserId === discordUserId)

  for (const person of [
    members.maya,
    members.omar,
    members.priya,
    members.uptime,
    owner,
  ]) {
    assert.deepEqual(entryFor(person.discordUserId), [
      {
        discordUserId: person.discordUserId,
        displayName: person.displayName,
        username: person.username,
      },
    ])
  }

  assert.deepEqual(entryFor(bot.discordUserId), [
    {
      discordUserId: bot.discordUserId,
      displayName: bot.displayName,
      isYourBot: true,
      username: bot.username,
    },
  ])

  const placeOf = (discordUserId: string) =>
    everyone.members.findIndex(
      (member) => member.discordUserId === discordUserId
    )

  assert.ok(
    placeOf(members.maya.discordUserId) < placeOf(members.omar.discordUserId)
  )
  assert.ok(
    placeOf(members.omar.discordUserId) < placeOf(members.priya.discordUserId)
  )
  assert.ok(
    placeOf(members.priya.discordUserId) < placeOf(members.uptime.discordUserId)
  )

  const digest = await session.call<Digest>('messages_catch_up', {
    since: clock.at(16),
  })
  const [asked] = digest.messages.filter(
    ({ messageId }) => messageId === botAnswers.request.id
  )
  const [, pingedDiscordUserId] = asked.content.match(/<@(\d+)>/) ?? []
  const [whoWasPinged] = entryFor(pingedDiscordUserId)

  assert.equal(whoWasPinged.displayName, bot.displayName)
  assert.equal(whoWasPinged.isYourBot, true)
})
