import assert from 'node:assert/strict'
import { openMcpSession } from './mcp-client'
import { test } from './spec'
import { theTeamServer } from './the-team-server'

type Failed = {
  nextAction: string
  status: string
  summary: string
}

test('a permission read Discord refuses comes back as guidance, not vendor noise', async () => {
  const team = theTeamServer()
  const session = await openMcpSession()

  const unknownServer = await session.call<Failed>('roles_list')

  assert.deepEqual(unknownServer, {
    status: 'failed',
    summary:
      'Discord does not know the server DISCORD_GUILD_ID names, so nothing was read.',
    nextAction:
      'Check DISCORD_GUILD_ID is your server id and that the bot is still in that server — invite it again if it was removed — then ask again.',
  })

  session.discord.holdsServer({ ...team.server, memberRoleIds: {} })

  const notAMember = await session.call<Failed>('roles_list')

  assert.deepEqual(notAMember, {
    status: 'failed',
    summary:
      'Discord found no member of this server under DISCORD_OWNER_USER_ID, so there are no roles of yours to read.',
    nextAction:
      'Check DISCORD_OWNER_USER_ID is your own Discord user id and that you are still in the server DISCORD_GUILD_ID names, then ask again.',
  })

  session.discord.refuseServerReads()

  const refused = await session.call<Failed>('channels_access', {
    withoutDiscordRoleId: team.roles.engineers.id,
  })

  assert.deepEqual(refused, {
    status: 'failed',
    summary:
      'Discord refused to let the bot read the server, so nothing was read.',
    nextAction:
      'Check the bot is still in the server DISCORD_GUILD_ID names and that DISCORD_BOT_TOKEN is current, then ask again — reading changes nothing in Discord, so another attempt is safe.',
  })

  for (const answer of [unknownServer, notAMember, refused].map((failed) =>
    JSON.stringify(failed)
  )) {
    for (const vendorNoise of [
      'Unknown Guild',
      'Unknown Member',
      'Missing Access',
      '10004',
      '10007',
      '50001',
    ]) {
      assert.equal(answer.includes(vendorNoise), false)
    }
  }
})
