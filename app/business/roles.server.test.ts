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
import { afterEach, describe, expect, it, vi } from '~/test/prelude'

const {
  Administrator,
  EmbedLinks,
  ManageMessages,
  ManageThreads,
  MentionEveryone,
  SendMessages,
  ViewChannel,
} = PermissionFlagsBits

const anHour = 60 * 60 * 1000

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
      permissions: ManageMessages | MentionEveryone | SendMessages | EmbedLinks,
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
      permissions: EmbedLinks,
      position: 1,
    },
  }
  const categoryId = snowflake()
  const channels = {
    product: {
      discordChannelId: snowflake(),
      isCategory: true,
      isVoice: false,
      name: 'Product',
      overwrites: [],
      parentDiscordChannelId: null,
      position: 0,
    },
    general: {
      discordChannelId: snowflake(),
      isCategory: false,
      isVoice: false,
      name: 'general',
      overwrites: [],
      parentDiscordChannelId: null,
      position: 0,
    },
    engineering: {
      discordChannelId: snowflake(),
      isCategory: false,
      isVoice: false,
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
      isVoice: false,
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
      ownerTimedOutUntil: null,
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

async function currentAccess(
  transport: ChannelAccessTransport,
  context: Awaited<ReturnType<typeof ownerContext>>
) {
  const answer = await fromSuccess(readChannelAccess(transport))({}, context)

  if (answer.status !== 'retrieved') {
    throw new Error(`expected a retrieved read, got a ${answer.status} one`)
  }

  return answer
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
  afterEach(() => {
    vi.useRealTimers()
  })

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

  it('lists text channels above voice channels in each group, the way the sidebar does', async () => {
    const { answering, channels, context } = await accessGround()
    const voice = (name: string, position: number, parent: string | null) => ({
      discordChannelId: snowflake(),
      isCategory: false,
      isVoice: true,
      name,
      overwrites: [],
      parentDiscordChannelId: parent,
      position,
    })
    const { transport } = answering({
      channels: [
        ...Object.values(channels),
        voice('standup', 0, null),
        { ...voice('random', 1, null), isVoice: false },
        voice('pairing', 0, channels.product.discordChannelId),
      ],
    })

    const answer = await currentAccess(transport, context)

    expect(answer.channels.map(({ name }) => name)).toEqual([
      'general',
      'random',
      'standup',
      'engineering',
      'release-checklist',
      'pairing',
    ])
  })

  it('sorts a channel whose category is missing among the uncategorized ones, text still above voice', async () => {
    const { answering, channels, context } = await accessGround()
    const { transport } = answering({
      channels: [
        ...Object.values(channels),
        {
          discordChannelId: snowflake(),
          isCategory: false,
          isVoice: true,
          name: 'standup',
          overwrites: [],
          parentDiscordChannelId: null,
          position: 0,
        },
        {
          discordChannelId: snowflake(),
          isCategory: false,
          isVoice: false,
          name: 'hallway',
          overwrites: [],
          parentDiscordChannelId: snowflake(),
          position: 1,
        },
      ],
    })

    const answer = await currentAccess(transport, context)

    expect(
      answer.channels.map(({ category, name }) => ({ category, name }))
    ).toEqual([
      { category: undefined, name: 'general' },
      { category: undefined, name: 'hallway' },
      { category: undefined, name: 'standup' },
      { category: 'Product', name: 'engineering' },
      { category: 'engineering', name: 'release-checklist' },
    ])
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
    const { transport } = answering({
      ownerDiscordRoleIds: [
        roles.engineers.discordRoleId,
        roles.designers.discordRoleId,
      ],
    })

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

  it('costs Administrator itself when the role set aside is the only one granting it', async () => {
    const { answering, channels, context, roles, threads } =
      await accessGround()
    const { transport } = answering({
      ownerDiscordRoleIds: [roles.admins.discordRoleId],
    })

    const answer = await comparedAccess(
      transport,
      roles.admins.discordRoleId,
      context
    )

    expect(answer).toMatchObject({
      summary:
        'Without Admins you would lose 3 channels and threads you can view now and 1 server-wide permission. 1 private thread would stay visible only if someone added you to it.',
      withoutRole: {
        discordRoleId: roles.admins.discordRoleId,
        lostPermissions: ['Administrator'],
        name: 'Admins',
        ownerHolds: true,
      },
    })
    expect(
      answer.channels.map(
        ({ canViewWithoutRole, discordChannelId, grantedThrough }) => ({
          canViewWithoutRole,
          discordChannelId,
          grantedThrough,
        })
      )
    ).toEqual([
      {
        canViewWithoutRole: 'yes',
        discordChannelId: channels.general.discordChannelId,
        grantedThrough: 'administrator',
      },
      {
        canViewWithoutRole: 'only_if_added',
        discordChannelId: threads.incident.discordChannelId,
        grantedThrough: 'administrator',
      },
      {
        canViewWithoutRole: 'no',
        discordChannelId: channels.engineering.discordChannelId,
        grantedThrough: 'administrator',
      },
      {
        canViewWithoutRole: 'no',
        discordChannelId: threads.release.discordChannelId,
        grantedThrough: 'administrator',
      },
      {
        canViewWithoutRole: 'no',
        discordChannelId: channels.leadership.discordChannelId,
        grantedThrough: 'administrator',
      },
    ])
  })

  it('names only the other role when two of the roles held grant Administrator', async () => {
    const { answering, context, roles } = await accessGround()
    const founders = {
      discordRoleId: snowflake(),
      mentionable: false,
      name: 'Founders',
      permissions: Administrator,
      position: 5,
    }
    const { transport } = answering({
      ownerDiscordRoleIds: [roles.admins.discordRoleId, founders.discordRoleId],
      roles: [...Object.values(roles), founders],
    })

    const answer = await comparedAccess(
      transport,
      roles.admins.discordRoleId,
      context
    )

    expect(answer.summary).toBe(
      'Another of your roles (Founders) grants Administrator, so you lose nothing without Admins.'
    )
    expect(answer).toMatchObject({ withoutRole: { lostPermissions: [] } })
    expect(
      answer.channels.filter(
        ({ canViewWithoutRole }) => canViewWithoutRole !== 'yes'
      )
    ).toHaveLength(0)
  })

  it('keeps no promise about a private thread only a channel overwrite let the owner manage', async () => {
    const { answering, channels, context, roles, threads } =
      await accessGround()
    const triage = {
      discordRoleId: snowflake(),
      mentionable: false,
      name: 'Triage',
      permissions: 0n,
      position: 1,
    }
    const { transport } = answering({
      channels: Object.values(channels).map((channel) =>
        channel === channels.general
          ? {
              ...channel,
              overwrites: [
                {
                  allow: ManageThreads,
                  deny: 0n,
                  discordRoleId: triage.discordRoleId,
                  kind: 'role' as const,
                },
              ],
            }
          : channel
      ),
      ownerDiscordRoleIds: [
        roles.engineers.discordRoleId,
        triage.discordRoleId,
      ],
      roles: [...Object.values(roles), triage],
    })

    const answer = await comparedAccess(
      transport,
      triage.discordRoleId,
      context
    )

    expect(answer.channels).toContainEqual({
      category: 'general',
      discordChannelId: threads.incident.discordChannelId,
      isThread: true,
      name: 'incident-review',
      grantedThrough: 'role_channel_permissions',
      grantedBy: ['Triage'],
      canViewWithoutRole: 'only_if_added',
    })
    expect(answer.summary).toBe(
      'Without Triage you keep every server-wide permission you have and every channel and thread you can view now, except that 1 private thread would stay visible only if someone added you to it.'
    )
  })

  it('leaves out a private thread a timed-out owner would see by managing threads, and says why', async () => {
    const { answering, context, roles } = await accessGround()
    const timedOutUntil = new Date(Date.now() + anHour).toISOString()
    const { transport } = answering({
      ownerDiscordRoleIds: [
        roles.engineers.discordRoleId,
        roles.moderators.discordRoleId,
      ],
      ownerTimedOutUntil: timedOutUntil,
    })

    const answer = await currentAccess(transport, context)

    expect(answer.channels.map(({ name }) => name)).toEqual([
      'general',
      'engineering',
      'release-checklist',
    ])
    expect(answer.summary).toBe(
      `You can view 3 channels and threads right now; \`grantedBy\` on each names what lets you see it. You are timed out until ${timedOutUntil}, and until then Discord takes away every permission you hold except View Channels and Read Message History, so a private thread you would see by managing threads is left out and no other server-wide permission counts.`
    )
  })

  it('compares only what a timeout leaves a timed-out owner', async () => {
    const { answering, context, roles } = await accessGround()
    const timedOutUntil = new Date(Date.now() + anHour).toISOString()
    const { transport } = answering({
      ownerDiscordRoleIds: [
        roles.engineers.discordRoleId,
        roles.moderators.discordRoleId,
      ],
      ownerTimedOutUntil: timedOutUntil,
    })

    const answer = await comparedAccess(
      transport,
      roles.moderators.discordRoleId,
      context
    )

    expect(answer).toMatchObject({
      summary: `Without Moderators you keep every channel, thread and server-wide permission you have now. You are timed out until ${timedOutUntil}, and until then Discord takes away every permission you hold except View Channels and Read Message History, so a private thread you would see by managing threads is left out and no other server-wide permission counts.`,
      withoutRole: { lostPermissions: [] },
    })
  })

  it('says when the role set aside is all that exempts a timed-out owner', async () => {
    const { answering, context, roles } = await accessGround()
    const timedOutUntil = new Date(Date.now() + anHour).toISOString()
    const { transport } = answering({
      ownerDiscordRoleIds: [roles.admins.discordRoleId],
      ownerTimedOutUntil: timedOutUntil,
    })

    const answer = await comparedAccess(
      transport,
      roles.admins.discordRoleId,
      context
    )

    expect(answer).toMatchObject({
      summary: `Without Admins you would lose 3 channels and threads you can view now and 2 server-wide permissions. 1 private thread would stay visible only if someone added you to it. You are timed out until ${timedOutUntil}. Administrator exempts you from the timeout now, but without Admins Discord would take away every permission you hold except View Channels and Read Message History until then.`,
      withoutRole: {
        lostPermissions: ['Administrator', 'Send Messages and Create Posts'],
      },
    })
  })

  it('says nothing about a timeout the server owner is exempt from', async () => {
    const { answering, context, roles } = await accessGround()
    const { transport } = answering({
      ownerTimedOutUntil: new Date(Date.now() + anHour).toISOString(),
      serverOwnerDiscordUserId: context.owner.discordUserId,
    })

    const now = await currentAccess(transport, context)
    const withoutEngineers = await comparedAccess(
      transport,
      roles.engineers.discordRoleId,
      context
    )

    expect(now.summary).toBe(
      'You can view 5 channels and threads right now; `grantedBy` on each names what lets you see it.'
    )
    expect(withoutEngineers.summary).toBe(
      'You are the server owner, so you lose nothing without Engineers.'
    )
  })

  it('says nothing about a timeout Administrator exempts the owner from', async () => {
    const { answering, context, roles } = await accessGround()
    const { transport } = answering({
      ownerDiscordRoleIds: [
        roles.engineers.discordRoleId,
        roles.admins.discordRoleId,
      ],
      ownerTimedOutUntil: new Date(Date.now() + anHour).toISOString(),
    })

    const now = await currentAccess(transport, context)
    const withoutEngineers = await comparedAccess(
      transport,
      roles.engineers.discordRoleId,
      context
    )

    expect(now.summary).toBe(
      'You can view 5 channels and threads right now; `grantedBy` on each names what lets you see it.'
    )
    expect(withoutEngineers.summary).toBe(
      'Another of your roles (Admins) grants Administrator, so you lose nothing without Engineers.'
    )
  })

  it('counts a timeout only until the instant it ends', async () => {
    const { answering, context, roles, threads } = await accessGround()
    const instant = Date.now()
    const heldUntil = (ownerTimedOutUntil: number) =>
      answering({
        ownerDiscordRoleIds: [
          roles.engineers.discordRoleId,
          roles.moderators.discordRoleId,
        ],
        ownerTimedOutUntil: new Date(ownerTimedOutUntil).toISOString(),
      }).transport

    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(instant)

    const endingNow = await currentAccess(heldUntil(instant), context)
    const endingNext = await currentAccess(heldUntil(instant + 1), context)

    expect(
      endingNow.channels.map(({ discordChannelId }) => discordChannelId)
    ).toContain(threads.incident.discordChannelId)
    expect(
      endingNext.channels.filter(
        ({ discordChannelId }) =>
          discordChannelId === threads.incident.discordChannelId
      )
    ).toHaveLength(0)
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
