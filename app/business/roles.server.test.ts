import { ContextError, InputError, fromSuccess } from 'composable-functions'
import { PermissionFlagsBits } from 'discord.js'
import {
  type ChannelAccessTransport,
  type ObservedChannelAccess,
  PermissionFetchOwnerNotMemberError,
  PermissionFetchRejectedError,
  PermissionFetchServerUnknownError,
  channelAccessCoverage,
  everyoneSetAsideMessage,
  permissionFetchFailureCopy,
  unknownRoleMessage,
} from '~/business/roles.common'
import { listRoles, readChannelAccess } from '~/business/roles.server'
import { db } from '~/db/db.server'
import { createGuild, ownerContext, snowflake } from '~/test/fixtures'
import { describe, expect, it } from '~/test/prelude'

const {
  Administrator,
  ManageMessages,
  ManageThreads,
  MentionEveryone,
  SendMessages,
  ViewChannel,
} = PermissionFlagsBits

async function accessGround() {
  const guild = await createGuild()
  const context = await ownerContext({ guildId: guild.id })
  const everyoneId = context.owner.guildId
  const roles = {
    everyone: {
      discordRoleId: everyoneId,
      mentionable: false,
      name: '@everyone',
      permissions: ViewChannel | SendMessages,
      position: 0,
    },
    engineers: {
      discordRoleId: snowflake(),
      mentionable: true,
      name: 'Engineers',
      permissions: ManageMessages | MentionEveryone,
      position: 2,
    },
    moderators: {
      discordRoleId: snowflake(),
      mentionable: false,
      name: 'Moderators',
      permissions: ManageThreads,
      position: 3,
    },
    admins: {
      discordRoleId: snowflake(),
      mentionable: false,
      name: 'Admins',
      permissions: Administrator,
      position: 4,
    },
    designers: {
      discordRoleId: snowflake(),
      mentionable: true,
      name: 'Designers',
      permissions: 0n,
      position: 1,
    },
  }
  const categoryId = snowflake()
  const channels = {
    product: {
      discordChannelId: snowflake(),
      isCategory: true,
      name: 'Product',
      overwrites: [],
      parentDiscordChannelId: null,
      position: 0,
    },
    general: {
      discordChannelId: snowflake(),
      isCategory: false,
      name: 'general',
      overwrites: [],
      parentDiscordChannelId: null,
      position: 0,
    },
    engineering: {
      discordChannelId: snowflake(),
      isCategory: false,
      name: 'engineering',
      overwrites: [
        {
          allow: 0n,
          deny: ViewChannel,
          discordRoleId: everyoneId,
          kind: 'role' as const,
        },
        {
          allow: ViewChannel,
          deny: 0n,
          discordRoleId: roles.engineers.discordRoleId,
          kind: 'role' as const,
        },
      ],
      parentDiscordChannelId: categoryId,
      position: 1,
    },
    leadership: {
      discordChannelId: snowflake(),
      isCategory: false,
      name: 'leadership-offsite',
      overwrites: [
        {
          allow: 0n,
          deny: ViewChannel,
          discordRoleId: everyoneId,
          kind: 'role' as const,
        },
      ],
      parentDiscordChannelId: categoryId,
      position: 2,
    },
  }
  channels.product.discordChannelId = categoryId
  const threads = {
    release: {
      discordChannelId: snowflake(),
      isPrivate: false,
      name: 'release-checklist',
      parentDiscordChannelId: channels.engineering.discordChannelId,
    },
    incident: {
      discordChannelId: snowflake(),
      isPrivate: true,
      name: 'incident-review',
      parentDiscordChannelId: channels.general.discordChannelId,
    },
  }

  function snapshot(
    overrides: Partial<ObservedChannelAccess> = {}
  ): ObservedChannelAccess {
    return {
      channels: Object.values(channels),
      ownerDiscordRoleIds: [roles.engineers.discordRoleId],
      roles: Object.values(roles),
      serverOwnerDiscordUserId: snowflake(),
      threads: Object.values(threads),
      ...overrides,
    }
  }

  function answering(overrides: Partial<ObservedChannelAccess> = {}) {
    const requests: Parameters<ChannelAccessTransport>[0][] = []
    const transport: ChannelAccessTransport = async (request) => {
      requests.push(request)

      return snapshot(overrides)
    }

    return { requests, transport }
  }

  return { answering, channels, context, roles, threads }
}

function refusing(error: Error) {
  const transport: ChannelAccessTransport = async () => {
    throw error
  }

  return transport
}

function telemetryOf({
  owner,
}: {
  owner: { discordUserId: string; guildId: string }
}) {
  return {
    async failures() {
      return await db()
        .selectFrom('permissionFetchFailures')
        .innerJoin(
          'permissionFetchRequests',
          'permissionFetchRequests.id',
          'permissionFetchFailures.permissionFetchRequestId'
        )
        .selectAll('permissionFetchFailures')
        .where('permissionFetchRequests.discordGuildId', '=', owner.guildId)
        .execute()
    },
    async requests() {
      return await db()
        .selectFrom('permissionFetchRequests')
        .selectAll()
        .where('discordGuildId', '=', owner.guildId)
        .where('ownerDiscordUserId', '=', owner.discordUserId)
        .execute()
    },
    async retrievals() {
      return await db()
        .selectFrom('permissionFetchRetrievals')
        .innerJoin(
          'permissionFetchRequests',
          'permissionFetchRequests.id',
          'permissionFetchRetrievals.permissionFetchRequestId'
        )
        .selectAll('permissionFetchRetrievals')
        .where('permissionFetchRequests.discordGuildId', '=', owner.guildId)
        .execute()
    },
  }
}

async function comparedAccess(
  transport: ChannelAccessTransport,
  withoutDiscordRoleId: string,
  context: Awaited<ReturnType<typeof ownerContext>>
) {
  const answer = await fromSuccess(readChannelAccess(transport))(
    { withoutDiscordRoleId },
    context
  )

  if (!('withoutRole' in answer) || !answer.withoutRole) {
    throw new Error(`expected a comparison, got a ${answer.status} read`)
  }

  return answer
}

describe('listRoles', () => {
  it("answers with every role in Discord's order and records the read", async () => {
    const { answering, context, roles } = await accessGround()
    const { requests, transport } = answering({
      ownerDiscordRoleIds: [
        roles.engineers.discordRoleId,
        roles.designers.discordRoleId,
      ],
    })

    const answer = await fromSuccess(listRoles(transport))({}, context)
    const telemetry = telemetryOf(context)
    const [request] = await telemetry.requests()

    expect(answer).toEqual({
      status: 'retrieved',
      ownerIsServerOwner: false,
      roles: [
        {
          discordRoleId: roles.admins.discordRoleId,
          name: 'Admins',
          mentionable: false,
          grantsAdministrator: true,
          ownerHolds: false,
        },
        {
          discordRoleId: roles.moderators.discordRoleId,
          name: 'Moderators',
          mentionable: false,
          grantsAdministrator: false,
          ownerHolds: false,
        },
        {
          discordRoleId: roles.engineers.discordRoleId,
          name: 'Engineers',
          mentionable: true,
          grantsAdministrator: false,
          ownerHolds: true,
        },
        {
          discordRoleId: roles.designers.discordRoleId,
          name: 'Designers',
          mentionable: true,
          grantsAdministrator: false,
          ownerHolds: true,
        },
        {
          discordRoleId: roles.everyone.discordRoleId,
          name: '@everyone',
          mentionable: false,
          grantsAdministrator: false,
          ownerHolds: true,
        },
      ],
    })
    expect(requests).toEqual([
      {
        discordGuildId: context.owner.guildId,
        ownerDiscordUserId: context.owner.discordUserId,
      },
    ])
    expect(request).toMatchObject({ reading: 'roles' })
    expect(await telemetry.retrievals()).toHaveLength(1)
    expect(await telemetry.failures()).toHaveLength(0)
  })

  it('says when the owner owns the server', async () => {
    const { answering, context } = await accessGround()
    const { transport } = answering({
      serverOwnerDiscordUserId: context.owner.discordUserId,
    })

    const answer = await fromSuccess(listRoles(transport))({}, context)

    expect(answer).toMatchObject({ ownerIsServerOwner: true })
  })

  it('refuses a context that cannot read messages', async () => {
    const { answering, context } = await accessGround()
    const { requests, transport } = answering()

    const result = await listRoles(transport)(
      {},
      { ...context, canReadMessages: false }
    )

    expect(result.success).toBe(false)
    expect(result.errors[0]).toBeInstanceOf(ContextError)
    expect(requests).toHaveLength(0)
  })
})

describe('readChannelAccess', () => {
  it('lists only what the owner can view, each with what grants it', async () => {
    const { answering, channels, context, roles, threads } =
      await accessGround()
    const { transport } = answering()

    const answer = await fromSuccess(readChannelAccess(transport))({}, context)

    expect(answer).toEqual({
      status: 'retrieved',
      summary:
        'You can view 3 channels and threads right now; `grantedBy` on each names what lets you see it.',
      coverage: channelAccessCoverage,
      channels: [
        {
          discordChannelId: channels.general.discordChannelId,
          isThread: false,
          name: 'general',
          grantedThrough: 'role_server_permissions',
          grantedBy: ['@everyone'],
        },
        {
          category: 'Product',
          discordChannelId: channels.engineering.discordChannelId,
          isThread: false,
          name: 'engineering',
          grantedThrough: 'role_channel_permissions',
          grantedBy: [roles.engineers.name],
        },
        {
          category: 'engineering',
          discordChannelId: threads.release.discordChannelId,
          isThread: true,
          name: 'release-checklist',
          grantedThrough: 'role_channel_permissions',
          grantedBy: [roles.engineers.name],
        },
      ],
    })
  })

  it('never names a channel or a private thread the owner may not see', async () => {
    const { answering, context } = await accessGround()
    const { transport } = answering()

    const answer = JSON.stringify(
      await fromSuccess(readChannelAccess(transport))({}, context)
    )

    expect(answer).not.toContain('leadership-offsite')
    expect(answer).not.toContain('incident-review')
  })

  it('lists a private thread the owner sees by managing threads, and what leaving that role does to it', async () => {
    const { answering, context, roles, threads } = await accessGround()
    const { transport } = answering({
      ownerDiscordRoleIds: [
        roles.engineers.discordRoleId,
        roles.moderators.discordRoleId,
      ],
    })

    const answer = await comparedAccess(
      transport,
      roles.moderators.discordRoleId,
      context
    )

    expect(answer.channels).toContainEqual({
      category: 'general',
      discordChannelId: threads.incident.discordChannelId,
      isThread: true,
      name: 'incident-review',
      grantedThrough: 'role_server_permissions',
      grantedBy: [roles.moderators.name],
      canViewWithoutRole: 'only_if_added',
    })
    expect(answer).toMatchObject({
      summary:
        'Without Moderators you would lose 1 server-wide permission. 1 private thread would stay visible only if someone added you to it.',
      withoutRole: {
        discordRoleId: roles.moderators.discordRoleId,
        lostPermissions: ['Manage Threads and Posts'],
        name: 'Moderators',
        ownerHolds: true,
      },
    })
  })

  it('names the channels and server-wide permissions only that role gives', async () => {
    const { answering, channels, context, roles, threads } =
      await accessGround()
    const { transport } = answering()

    const answer = await comparedAccess(
      transport,
      roles.engineers.discordRoleId,
      context
    )

    expect(
      answer.channels.map(({ canViewWithoutRole, discordChannelId }) => ({
        canViewWithoutRole,
        discordChannelId,
      }))
    ).toEqual([
      {
        canViewWithoutRole: 'yes',
        discordChannelId: channels.general.discordChannelId,
      },
      {
        canViewWithoutRole: 'no',
        discordChannelId: channels.engineering.discordChannelId,
      },
      {
        canViewWithoutRole: 'no',
        discordChannelId: threads.release.discordChannelId,
      },
    ])
    expect(answer).toMatchObject({
      status: 'retrieved',
      summary:
        'Without Engineers you would lose 2 channels and threads you can view now and 2 server-wide permissions.',
      coverage: channelAccessCoverage,
      withoutRole: {
        discordRoleId: roles.engineers.discordRoleId,
        lostPermissions: [
          'Manage Messages',
          'Mention @everyone, @here, and All Roles',
        ],
        name: 'Engineers',
        ownerHolds: true,
      },
    })
  })

  it('loses nothing for the server owner', async () => {
    const { answering, context, roles } = await accessGround()
    const { transport } = answering({
      serverOwnerDiscordUserId: context.owner.discordUserId,
    })

    const answer = await comparedAccess(
      transport,
      roles.engineers.discordRoleId,
      context
    )

    expect(answer.summary).toBe(
      'You are the server owner, so you lose nothing without Engineers.'
    )
    expect(answer).toMatchObject({ withoutRole: { lostPermissions: [] } })
    expect(answer.channels.map(({ name }) => name)).toEqual([
      'general',
      'incident-review',
      'engineering',
      'release-checklist',
      'leadership-offsite',
    ])
    expect(
      answer.channels.filter(
        ({ canViewWithoutRole, grantedThrough }) =>
          grantedThrough !== 'server_owner' || canViewWithoutRole !== 'yes'
      )
    ).toHaveLength(0)
  })

  it('loses nothing when another held role grants Administrator', async () => {
    const { answering, context, roles } = await accessGround()
    const { transport } = answering({
      ownerDiscordRoleIds: [
        roles.engineers.discordRoleId,
        roles.admins.discordRoleId,
      ],
    })

    const answer = await comparedAccess(
      transport,
      roles.engineers.discordRoleId,
      context
    )

    expect(answer.summary).toBe(
      'Another of your roles (Admins) grants Administrator, so you lose nothing without Engineers.'
    )
    expect(answer).toMatchObject({ withoutRole: { lostPermissions: [] } })
  })

  it('answers that nothing changes without a role the owner does not hold', async () => {
    const { answering, context, roles } = await accessGround()
    const { transport } = answering()

    const answer = await comparedAccess(
      transport,
      roles.designers.discordRoleId,
      context
    )

    expect(answer).toMatchObject({
      summary: 'You do not hold Designers, so nothing changes without it.',
      withoutRole: {
        discordRoleId: roles.designers.discordRoleId,
        lostPermissions: [],
        name: 'Designers',
        ownerHolds: false,
      },
    })
  })

  it('refuses @everyone before asking Discord anything', async () => {
    const { answering, context } = await accessGround()
    const { requests, transport } = answering()

    const result = await readChannelAccess(transport)(
      { withoutDiscordRoleId: context.owner.guildId },
      context
    )

    expect(result.success).toBe(false)
    expect(result.errors[0]).toBeInstanceOf(InputError)
    expect(result.errors[0].message).toBe(everyoneSetAsideMessage)
    expect(requests).toHaveLength(0)
    expect(await telemetryOf(context).requests()).toHaveLength(0)
  })

  it('refuses a role the server does not have, after recording the read', async () => {
    const { answering, context } = await accessGround()
    const { transport } = answering()

    const result = await readChannelAccess(transport)(
      { withoutDiscordRoleId: snowflake() },
      context
    )
    const telemetry = telemetryOf(context)

    expect(result.success).toBe(false)
    expect(result.errors[0]).toBeInstanceOf(InputError)
    expect(result.errors[0].message).toBe(unknownRoleMessage)
    expect((result.errors[0] as InputError).path).toEqual([
      'withoutDiscordRoleId',
    ])
    expect(await telemetry.requests()).toMatchObject([
      { reading: 'channel_access' },
    ])
    expect(await telemetry.retrievals()).toHaveLength(1)
  })

  it.each([
    {
      error: new PermissionFetchOwnerNotMemberError('Unknown Member'),
      kind: 'owner_not_member' as const,
    },
    {
      error: new PermissionFetchServerUnknownError('Unknown Guild'),
      kind: 'server_unknown' as const,
    },
    {
      error: new PermissionFetchRejectedError('Missing Access'),
      kind: 'rejected' as const,
    },
    { error: new Error('connect ECONNREFUSED'), kind: 'unreachable' as const },
  ])(
    'records a $kind failure and answers with its mapped copy alone',
    async ({ error, kind }) => {
      const { context } = await accessGround()

      const answer = await fromSuccess(readChannelAccess(refusing(error)))(
        {},
        context
      )
      const telemetry = telemetryOf(context)
      const failures = await telemetry.failures()

      expect(answer).toEqual({
        status: 'failed',
        ...permissionFetchFailureCopy[kind],
      })
      expect(failures).toMatchObject([{ errorMessage: error.message, kind }])
      expect(await telemetry.retrievals()).toHaveLength(0)
      expect(JSON.stringify(answer)).not.toContain('errorMessage')
      expect(JSON.stringify(answer)).not.toContain(error.message)
    }
  )
})
