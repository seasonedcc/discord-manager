import assert from 'node:assert/strict'
import { openMcpSession } from './mcp-client'
import { test } from './spec'
import { theTeamServer } from './the-team-server'

type Roles = {
  ownerIsServerOwner: boolean
  roles: {
    discordRoleId: string
    grantsAdministrator: boolean
    mentionable: boolean
    name: string
    ownerHolds: boolean
  }[]
  status: string
}

test('listing roles says which ones are yours', async () => {
  const { roles, server } = theTeamServer()
  const session = await openMcpSession()

  session.discord.holdsServer(server)

  const listed = await session.call<Roles>('roles_list')

  assert.equal(listed.status, 'retrieved')
  assert.equal(listed.ownerIsServerOwner, false)
  assert.deepEqual(listed.roles, [
    {
      discordRoleId: roles.admins.id,
      name: roles.admins.name,
      mentionable: false,
      grantsAdministrator: true,
      ownerHolds: false,
    },
    {
      discordRoleId: roles.moderators.id,
      name: roles.moderators.name,
      mentionable: false,
      grantsAdministrator: false,
      ownerHolds: false,
    },
    {
      discordRoleId: roles.engineers.id,
      name: roles.engineers.name,
      mentionable: true,
      grantsAdministrator: false,
      ownerHolds: true,
    },
    {
      discordRoleId: roles.support.id,
      name: roles.support.name,
      mentionable: true,
      grantsAdministrator: false,
      ownerHolds: true,
    },
    {
      discordRoleId: roles.designers.id,
      name: roles.designers.name,
      mentionable: true,
      grantsAdministrator: false,
      ownerHolds: false,
    },
    {
      discordRoleId: roles.everyone.id,
      name: '@everyone',
      mentionable: false,
      grantsAdministrator: false,
      ownerHolds: true,
    },
  ])

  const owned = theTeamServer({ serverOwnedByTheOwner: true })

  session.discord.holdsServer(owned.server)

  const asServerOwner = await session.call<Roles>('roles_list')

  assert.equal(asServerOwner.status, 'retrieved')
  assert.equal(asServerOwner.ownerIsServerOwner, true)
})
