import assert from 'node:assert/strict'
import { openMcpSession } from './mcp-client'
import { test } from './spec'
import { theTeamServer } from './the-team-server'

type Comparison = {
  channels: {
    canViewWithoutRole: string
    discordChannelId: string
    grantedThrough: string
  }[]
  summary: string
  withoutRole: {
    discordRoleId: string
    lostPermissions: string[]
    name: string
    ownerHolds: boolean
  }
}

test('leaving the role that makes you an administrator costs Administrator itself', async () => {
  const { channels, roles, server, threads } = theTeamServer({
    ownerHolds: ['admins'],
  })
  const session = await openMcpSession()

  session.discord.holdsServer(server)

  const comparison = await session.call<Comparison>('channels_access', {
    withoutDiscordRoleId: roles.admins.id,
  })
  const answeringWith = (canViewWithoutRole: string) =>
    comparison.channels
      .filter((channel) => channel.canViewWithoutRole === canViewWithoutRole)
      .map(({ discordChannelId }) => discordChannelId)

  assert.equal(
    comparison.summary,
    'Without Admins you would lose 6 channels and threads you can view now and 1 server-wide permission. 1 private thread would stay visible only if someone added you to it.'
  )
  assert.deepEqual(comparison.withoutRole, {
    discordRoleId: roles.admins.id,
    name: roles.admins.name,
    ownerHolds: true,
    lostPermissions: ['Administrator'],
  })
  assert.equal(
    comparison.channels.filter(
      ({ grantedThrough }) => grantedThrough !== 'administrator'
    ).length,
    0
  )
  assert.deepEqual(answeringWith('no'), [
    channels.engineering.id,
    threads.releaseChecklist.id,
    channels.supportDesk.id,
    channels.designReviews.id,
    channels.supportTicket.id,
    channels.leadershipOffsite.id,
  ])
  assert.deepEqual(answeringWith('only_if_added'), [threads.incidentReview.id])
})
