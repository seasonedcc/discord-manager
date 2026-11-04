import assert from 'node:assert/strict'
import { nextDiscordId } from './discord-ids'
import { openMcpSession } from './mcp-client'
import { test } from './spec'
import { theTeamServer } from './the-team-server'

test('asking about a role the server does not have points back to roles_list', async () => {
  const { roles, server } = theTeamServer()
  const session = await openMcpSession()

  session.discord.holdsServer(server)

  const unknown = await session.callExpectingRefusal('channels_access', {
    withoutDiscordRoleId: nextDiscordId(),
  })

  assert.deepEqual(unknown.errors, [
    {
      message:
        'No role with that id exists on the server. List the roles with roles_list to pick a `discordRoleId`.',
      name: 'InputError',
      path: ['withoutDiscordRoleId'],
    },
  ])

  const readsBefore = session.discord.serverReads.length
  const everyone = await session.callExpectingRefusal('channels_access', {
    withoutDiscordRoleId: roles.everyone.id,
  })

  assert.deepEqual(everyone.errors, [
    {
      message:
        'Everyone holds @everyone and nobody can leave it, so there is nothing to compare. Pass the `discordRoleId` of another role from roles_list.',
      name: 'InputError',
      path: ['withoutDiscordRoleId'],
    },
  ])
  assert.equal(session.discord.serverReads.length, readsBefore)
})
