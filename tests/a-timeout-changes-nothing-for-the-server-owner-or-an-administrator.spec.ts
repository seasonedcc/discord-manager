import assert from 'node:assert/strict'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { test } from './spec'
import { theTeamServer } from './the-team-server'

type Access = {
  channels: { grantedThrough: string }[]
  summary: string
}

test('a timeout changes nothing for the server owner or an administrator', async () => {
  const { clock } = fixtures()
  const ownerTimedOutUntil = clock.at(24 * 60)
  const owned = theTeamServer({
    ownerTimedOutUntil,
    serverOwnedByTheOwner: true,
  })
  const administered = theTeamServer({
    ownerHolds: ['engineers', 'admins'],
    ownerTimedOutUntil,
  })
  const everything =
    Object.keys(owned.channels).length + Object.keys(owned.threads).length
  const session = await openMcpSession()

  session.discord.holdsServer(owned.server)

  const asServerOwner = await session.call<Access>('channels_access')
  const asServerOwnerWithoutEngineers = await session.call<Access>(
    'channels_access',
    { withoutDiscordRoleId: owned.roles.engineers.id }
  )

  assert.equal(
    asServerOwner.summary,
    `You can view ${everything} channels and threads right now; \`grantedBy\` on each names what lets you see it.`
  )
  assert.equal(
    asServerOwner.channels.filter(
      ({ grantedThrough }) => grantedThrough !== 'server_owner'
    ).length,
    0
  )
  assert.equal(
    asServerOwnerWithoutEngineers.summary,
    'You are the server owner, so you lose nothing without Engineers.'
  )

  session.discord.holdsServer(administered.server)

  const asAdministrator = await session.call<Access>('channels_access')
  const asAdministratorWithoutEngineers = await session.call<Access>(
    'channels_access',
    { withoutDiscordRoleId: administered.roles.engineers.id }
  )

  assert.equal(
    asAdministrator.summary,
    `You can view ${everything} channels and threads right now; \`grantedBy\` on each names what lets you see it.`
  )
  assert.equal(
    asAdministrator.channels.filter(
      ({ grantedThrough }) => grantedThrough !== 'administrator'
    ).length,
    0
  )
  assert.equal(
    asAdministratorWithoutEngineers.summary,
    'Another of your roles (Admins) grants Administrator, so you lose nothing without Engineers.'
  )
})
