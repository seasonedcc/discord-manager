import assert from 'node:assert/strict'
import { openMcpSession } from './mcp-client'
import { test } from './spec'
import { theTeamServer } from './the-team-server'

type Comparison = {
  channels: {
    canViewWithoutRole: string
    discordChannelId: string
    name: string
  }[]
  status: string
  summary: string
  withoutRole: {
    discordRoleId: string
    lostPermissions: string[]
    name: string
    ownerHolds: boolean
  }
}

test('leaving a role says which channels and permissions go with it', async () => {
  const { channels, roles, server, threads } = theTeamServer()
  const session = await openMcpSession()

  session.discord.holdsServer(server)

  const comparison = await session.call<Comparison>('channels_access', {
    withoutDiscordRoleId: roles.engineers.id,
  })

  assert.equal(comparison.status, 'retrieved')
  assert.equal(
    comparison.summary,
    'Without Engineers you would lose 2 channels and threads you can view now and 2 server-wide permissions.'
  )
  assert.deepEqual(comparison.withoutRole, {
    discordRoleId: roles.engineers.id,
    name: roles.engineers.name,
    ownerHolds: true,
    lostPermissions: [
      'Mention @everyone, @here, and All Roles',
      'Create Private Threads',
    ],
  })
  assert.deepEqual(
    comparison.channels.map(({ canViewWithoutRole, discordChannelId }) => ({
      canViewWithoutRole,
      discordChannelId,
    })),
    [
      { canViewWithoutRole: 'yes', discordChannelId: channels.general.id },
      {
        canViewWithoutRole: 'yes',
        discordChannelId: threads.onboardingQuestions.id,
      },
      {
        canViewWithoutRole: 'yes',
        discordChannelId: channels.announcements.id,
      },
      { canViewWithoutRole: 'yes', discordChannelId: channels.standup.id },
      {
        canViewWithoutRole: 'yes',
        discordChannelId: channels.launchWarRoom.id,
      },
      { canViewWithoutRole: 'no', discordChannelId: channels.engineering.id },
      {
        canViewWithoutRole: 'no',
        discordChannelId: threads.releaseChecklist.id,
      },
      { canViewWithoutRole: 'yes', discordChannelId: channels.supportDesk.id },
    ]
  )
})
