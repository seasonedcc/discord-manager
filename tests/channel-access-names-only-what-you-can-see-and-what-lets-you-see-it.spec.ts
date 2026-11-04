import assert from 'node:assert/strict'
import { openMcpSession } from './mcp-client'
import { test } from './spec'
import { theTeamServer } from './the-team-server'

type Access = {
  channels: {
    category?: string
    discordChannelId: string
    grantedBy: string[]
    grantedThrough: string
    isThread: boolean
    name: string
  }[]
  coverage: string
  status: string
  summary: string
}

test('channel access names only what you can see, and what lets you see it', async () => {
  const { categories, channels, roles, server, threads } = theTeamServer()
  const session = await openMcpSession()

  session.discord.holdsServer(server)

  const access = await session.call<Access>('channels_access')

  assert.equal(access.status, 'retrieved')
  assert.deepEqual(access.channels, [
    {
      discordChannelId: channels.general.id,
      isThread: false,
      name: channels.general.name,
      grantedThrough: 'role_server_permissions',
      grantedBy: ['@everyone'],
    },
    {
      category: channels.general.name,
      discordChannelId: threads.onboardingQuestions.id,
      isThread: true,
      name: threads.onboardingQuestions.name,
      grantedThrough: 'role_server_permissions',
      grantedBy: ['@everyone'],
    },
    {
      discordChannelId: channels.announcements.id,
      isThread: false,
      name: channels.announcements.name,
      grantedThrough: 'role_server_permissions',
      grantedBy: ['@everyone'],
    },
    {
      discordChannelId: channels.standup.id,
      isThread: false,
      name: channels.standup.name,
      grantedThrough: 'role_server_permissions',
      grantedBy: ['@everyone'],
    },
    {
      discordChannelId: channels.launchWarRoom.id,
      isThread: false,
      name: channels.launchWarRoom.name,
      grantedThrough: 'your_channel_permissions',
      grantedBy: [],
    },
    {
      category: categories.product.name,
      discordChannelId: channels.engineering.id,
      isThread: false,
      name: channels.engineering.name,
      grantedThrough: 'role_channel_permissions',
      grantedBy: [roles.engineers.name],
    },
    {
      category: channels.engineering.name,
      discordChannelId: threads.releaseChecklist.id,
      isThread: true,
      name: threads.releaseChecklist.name,
      grantedThrough: 'role_channel_permissions',
      grantedBy: [roles.engineers.name],
    },
    {
      category: categories.product.name,
      discordChannelId: channels.supportDesk.id,
      isThread: false,
      name: channels.supportDesk.name,
      grantedThrough: 'role_channel_permissions',
      grantedBy: [roles.engineers.name, roles.support.name],
    },
  ])
  assert.equal(
    access.summary,
    'You can view 8 channels and threads right now; `grantedBy` on each names what lets you see it.'
  )
  assert.equal(
    access.coverage,
    'Only what Discord shows the bot is judged here: a channel hidden from the bot is missing whether or not you can view it, archived threads are left out, and so is a private thread you see only because someone added you to it.'
  )

  const answer = JSON.stringify(access)

  for (const hidden of [
    channels.designReviews,
    channels.leadershipOffsite,
    categories.leadership,
    threads.incidentReview,
  ]) {
    assert.equal(answer.includes(hidden.name), false)
    assert.equal(answer.includes(hidden.id), false)
  }
})
