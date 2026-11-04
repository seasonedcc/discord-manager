import assert from 'node:assert/strict'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { test } from './spec'
import { theTeamServer } from './the-team-server'

type Access = {
  channels: { discordChannelId: string }[]
  summary: string
  withoutRole?: { lostPermissions: string[] }
}

test('a timeout leaves you only View Channels and Read Message History', async () => {
  const { clock } = fixtures()
  const timedOutUntil = clock.at(24 * 60)
  const moderating = theTeamServer({
    ownerHolds: ['engineers', 'moderators'],
    ownerTimedOutUntil: timedOutUntil,
  })
  const session = await openMcpSession()

  session.discord.holdsServer(moderating.server)

  const now = await session.call<Access>('channels_access')

  assert.equal(
    now.summary,
    `You can view 8 channels and threads right now; \`grantedBy\` on each names what lets you see it. You are timed out until ${timedOutUntil}, and until then Discord takes away every permission you hold except View Channels and Read Message History, so a private thread you would see by managing threads is left out and no other server-wide permission counts.`
  )
  assert.equal(
    now.channels.filter(
      ({ discordChannelId }) =>
        discordChannelId === moderating.threads.incidentReview.id
    ).length,
    0
  )

  const withoutModerators = await session.call<Access>('channels_access', {
    withoutDiscordRoleId: moderating.roles.moderators.id,
  })

  assert.equal(
    withoutModerators.summary,
    `Without Moderators you keep every channel, thread and server-wide permission you have now. You are timed out until ${timedOutUntil}, and until then Discord takes away every permission you hold except View Channels and Read Message History, so a private thread you would see by managing threads is left out and no other server-wide permission counts.`
  )
  assert.deepEqual(withoutModerators.withoutRole?.lostPermissions, [])

  const administering = theTeamServer({
    ownerHolds: ['admins'],
    ownerTimedOutUntil: timedOutUntil,
  })

  session.discord.holdsServer(administering.server)

  const withoutAdmins = await session.call<Access>('channels_access', {
    withoutDiscordRoleId: administering.roles.admins.id,
  })

  assert.equal(
    withoutAdmins.summary,
    `Without Admins you would lose 6 channels and threads you can view now and 3 server-wide permissions. 1 private thread would stay visible only if someone added you to it. You are timed out until ${timedOutUntil}. Administrator exempts you from the timeout now, but without Admins Discord would take away every permission you hold except View Channels and Read Message History until then.`
  )
  assert.deepEqual(withoutAdmins.withoutRole?.lostPermissions, [
    'Administrator',
    'Add Reactions',
    'Send Messages and Create Posts',
  ])
})
