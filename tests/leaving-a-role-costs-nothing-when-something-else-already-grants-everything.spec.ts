import assert from 'node:assert/strict'
import { openMcpSession } from './mcp-client'
import { test } from './spec'
import { theTeamServer } from './the-team-server'

type Comparison = {
  channels: { canViewWithoutRole: string; grantedThrough: string }[]
  summary: string
  withoutRole: { lostPermissions: string[]; ownerHolds: boolean }
}

async function compareWithout(
  team: ReturnType<typeof theTeamServer>,
  discordRoleId: string
) {
  const session = await openMcpSession()

  session.discord.holdsServer(team.server)

  const comparison = await session.call<Comparison>('channels_access', {
    withoutDiscordRoleId: discordRoleId,
  })

  await session.close()

  return comparison
}

test('leaving a role costs nothing when something else already grants everything', async () => {
  const owned = theTeamServer({ serverOwnedByTheOwner: true })
  const asOwner = await compareWithout(owned, owned.roles.engineers.id)

  assert.equal(
    asOwner.summary,
    'You are the server owner, so you lose nothing without Engineers.'
  )
  assert.deepEqual(asOwner.withoutRole.lostPermissions, [])
  assert.equal(
    asOwner.channels.length,
    Object.keys(owned.channels).length + Object.keys(owned.threads).length
  )
  assert.equal(
    asOwner.channels.filter(
      ({ canViewWithoutRole, grantedThrough }) =>
        canViewWithoutRole !== 'yes' || grantedThrough !== 'server_owner'
    ).length,
    0
  )

  const administered = theTeamServer({ ownerHolds: ['engineers', 'admins'] })
  const asAdministrator = await compareWithout(
    administered,
    administered.roles.engineers.id
  )

  assert.equal(
    asAdministrator.summary,
    'Another of your roles (Admins) grants Administrator, so you lose nothing without Engineers.'
  )
  assert.deepEqual(asAdministrator.withoutRole.lostPermissions, [])
  assert.equal(
    asAdministrator.channels.filter(
      ({ canViewWithoutRole, grantedThrough }) =>
        canViewWithoutRole !== 'yes' || grantedThrough !== 'administrator'
    ).length,
    0
  )

  const outsider = theTeamServer()
  const notHeld = await compareWithout(outsider, outsider.roles.designers.id)

  assert.equal(
    notHeld.summary,
    'You do not hold Designers, so nothing changes without it.'
  )
  assert.equal(notHeld.withoutRole.ownerHolds, false)
  assert.deepEqual(notHeld.withoutRole.lostPermissions, [])
  assert.equal(
    notHeld.channels.filter(
      ({ canViewWithoutRole }) => canViewWithoutRole !== 'yes'
    ).length,
    0
  )
})
