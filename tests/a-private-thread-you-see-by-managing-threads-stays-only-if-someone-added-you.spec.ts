import assert from 'node:assert/strict'
import { openMcpSession } from './mcp-client'
import { test } from './spec'
import { theTeamServer } from './the-team-server'

type Access = {
  channels: {
    canViewWithoutRole?: string
    category?: string
    discordChannelId: string
    grantedBy: string[]
    grantedThrough: string
    isThread: boolean
    name: string
  }[]
  summary: string
  withoutRole?: { lostPermissions: string[] }
}

test('a private thread you see by managing threads stays only if someone added you', async () => {
  const { channels, roles, server, threads } = theTeamServer({
    ownerHolds: ['engineers', 'moderators'],
  })
  const session = await openMcpSession()

  session.discord.holdsServer(server)

  const now = await session.call<Access>('channels_access')

  assert.deepEqual(
    now.channels.find(
      ({ discordChannelId }) => discordChannelId === threads.incidentReview.id
    ),
    {
      category: channels.general.name,
      discordChannelId: threads.incidentReview.id,
      isThread: true,
      name: threads.incidentReview.name,
      grantedThrough: 'role_server_permissions',
      grantedBy: [roles.moderators.name],
    }
  )

  const comparison = await session.call<Access>('channels_access', {
    withoutDiscordRoleId: roles.moderators.id,
  })

  assert.equal(
    comparison.channels.find(
      ({ discordChannelId }) => discordChannelId === threads.incidentReview.id
    )?.canViewWithoutRole,
    'only_if_added'
  )
  assert.equal(
    comparison.summary,
    'Without Moderators you would lose 3 server-wide permissions. 1 private thread would stay visible only if someone added you to it.'
  )
  assert.deepEqual(comparison.withoutRole?.lostPermissions, [
    'Manage Messages',
    'Manage Threads and Posts',
    'Timeout Members',
  ])
})
