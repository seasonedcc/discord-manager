import { PermissionFlagsBits } from 'discord.js'
import { describe, expect, it } from '~/test/prelude'
import type {
  ObservedChannel,
  ObservedOverwrite,
  ObservedRole,
  ObservedThread,
  PermissionFetchFailureKind,
  Viewer,
} from './roles.common'
import {
  permissionFetchFailureCopy,
  permissionLabelsOf,
  roleSetAsideSummary,
  serverPermissions,
  viewsOf,
  withTimeout,
} from './roles.common'

const {
  Administrator,
  ManageMessages,
  ManageThreads,
  ReadMessageHistory,
  SendMessages,
  ViewChannel,
} = PermissionFlagsBits

const guildId = '900000000000000001'
const ownerId = '900000000000000002'
const somebodyElseId = '900000000000000003'
const timeoutEnd = '2026-11-05T09:00:00.000Z'

function role(
  discordRoleId: string,
  name: string,
  permissions = 0n
): ObservedRole {
  return { discordRoleId, mentionable: false, name, permissions, position: 1 }
}

const everyone = role(guildId, '@everyone', ViewChannel | SendMessages)
const engineers = role('900000000000000011', 'Engineers', ViewChannel)
const support = role('900000000000000012', 'Support')
const moderators = role('900000000000000013', 'Moderators', ManageMessages)
const admins = role('900000000000000014', 'Admins', Administrator)
const designers = role('900000000000000015', 'Designers')

const roles = [everyone, engineers, support, moderators, admins, designers]

function serverWith(
  everyonePermissions = everyone.permissions,
  serverOwnerDiscordUserId = somebodyElseId
) {
  return {
    discordGuildId: guildId,
    roles: roles.map((candidate) =>
      candidate === everyone
        ? { ...everyone, permissions: everyonePermissions }
        : candidate
    ),
    serverOwnerDiscordUserId,
  }
}

function holding(...held: ObservedRole[]) {
  return {
    discordUserId: ownerId,
    heldDiscordRoleIds: held.map(({ discordRoleId }) => discordRoleId),
    timedOutUntil: null,
  }
}

function timedOut(viewer: Viewer) {
  return { ...viewer, timedOutUntil: timeoutEnd }
}

function forRole(
  { discordRoleId }: ObservedRole,
  { allow = 0n, deny = 0n }: { allow?: bigint; deny?: bigint }
): ObservedOverwrite {
  return { allow, deny, discordRoleId, kind: 'role' }
}

function forMember(
  discordUserId: string,
  { allow = 0n, deny = 0n }: { allow?: bigint; deny?: bigint }
): ObservedOverwrite {
  return { allow, deny, discordUserId, kind: 'member' }
}

function channel(
  discordChannelId: string,
  overwrites: ObservedOverwrite[] = []
): ObservedChannel {
  return {
    discordChannelId,
    isCategory: false,
    isVoice: false,
    name: `channel-${discordChannelId}`,
    overwrites,
    parentDiscordChannelId: null,
    position: 0,
  }
}

function thread(
  discordChannelId: string,
  parentDiscordChannelId: string,
  isPrivate: boolean
): ObservedThread {
  return {
    discordChannelId,
    isPrivate,
    name: `thread-${discordChannelId}`,
    parentDiscordChannelId,
  }
}

const everyFailureKind = [
  'owner_not_member',
  'rejected',
  'server_unknown',
  'unreachable',
] satisfies PermissionFetchFailureKind[]

describe('viewsOf', () => {
  it.each([
    {
      when: 'the owner owns the server, even behind an @everyone deny',
      server: serverWith(everyone.permissions, ownerId),
      viewer: holding(),
      overwrites: [forRole(everyone, { deny: ViewChannel })],
      view: { through: 'server_owner' },
    },
    {
      when: 'a held role grants Administrator, even behind a personal deny',
      server: serverWith(),
      viewer: holding(admins, engineers),
      overwrites: [forMember(ownerId, { deny: ViewChannel })],
      view: {
        through: 'administrator',
        discordRoleIds: [admins.discordRoleId],
      },
    },
    {
      when: 'the channel allows the owner personally over a role deny',
      server: serverWith(),
      viewer: holding(engineers),
      overwrites: [
        forRole(engineers, { deny: ViewChannel }),
        forMember(ownerId, { allow: ViewChannel }),
      ],
      view: { through: 'your_channel_permissions' },
    },
    {
      when: 'the channel denies the owner personally over a role allow',
      server: serverWith(),
      viewer: holding(engineers),
      overwrites: [
        forRole(engineers, { allow: ViewChannel }),
        forMember(ownerId, { deny: ViewChannel }),
      ],
      view: null,
    },
    {
      when: 'the channel lets somebody else in personally over an @everyone deny',
      server: serverWith(),
      viewer: holding(engineers),
      overwrites: [
        forRole(everyone, { deny: ViewChannel }),
        forMember(somebodyElseId, { allow: ViewChannel }),
      ],
      view: null,
    },
    {
      when: 'the channel keeps somebody else out personally over a held role allow',
      server: serverWith(),
      viewer: holding(engineers),
      overwrites: [
        forRole(everyone, { deny: ViewChannel }),
        forRole(engineers, { allow: ViewChannel }),
        forMember(somebodyElseId, { deny: ViewChannel }),
      ],
      view: {
        through: 'role_channel_permissions',
        discordRoleIds: [engineers.discordRoleId],
      },
    },
    {
      when: 'one held role allows the channel and another denies it',
      server: serverWith(),
      viewer: holding(engineers, support),
      overwrites: [
        forRole(support, { deny: ViewChannel }),
        forRole(engineers, { allow: ViewChannel }),
      ],
      view: {
        through: 'role_channel_permissions',
        discordRoleIds: [engineers.discordRoleId],
      },
    },
    {
      when: 'a held role denies the channel over an @everyone allow',
      server: serverWith(),
      viewer: holding(support),
      overwrites: [
        forRole(everyone, { allow: ViewChannel }),
        forRole(support, { deny: ViewChannel }),
      ],
      view: null,
    },
    {
      when: 'only a role the owner does not hold is denied the channel',
      server: serverWith(),
      viewer: holding(engineers),
      overwrites: [forRole(designers, { deny: ViewChannel })],
      view: {
        through: 'role_server_permissions',
        discordRoleIds: [guildId, engineers.discordRoleId],
      },
    },
    {
      when: '@everyone is denied the channel and no held role is let in',
      server: serverWith(),
      viewer: holding(engineers),
      overwrites: [forRole(everyone, { deny: ViewChannel })],
      view: null,
    },
    {
      when: '@everyone is let into the channel though no role grants View Channels',
      server: serverWith(0n),
      viewer: holding(support),
      overwrites: [forRole(everyone, { allow: ViewChannel })],
      view: { through: 'everyone_channel_permissions' },
    },
    {
      when: 'only a held role grants View Channels server-wide',
      server: serverWith(0n),
      viewer: holding(engineers, support),
      overwrites: [],
      view: {
        through: 'role_server_permissions',
        discordRoleIds: [engineers.discordRoleId],
      },
    },
    {
      when: 'nothing grants View Channels',
      server: serverWith(0n),
      viewer: holding(support),
      overwrites: [],
      view: null,
    },
    {
      when: 'the owner is timed out, since a timeout leaves View Channels alone',
      server: serverWith(),
      viewer: timedOut(holding(engineers)),
      overwrites: [
        forRole(everyone, { deny: ViewChannel }),
        forRole(engineers, { allow: ViewChannel }),
      ],
      view: {
        through: 'role_channel_permissions',
        discordRoleIds: [engineers.discordRoleId],
      },
    },
  ])(
    'decides View Channel when $when',
    ({ overwrites, server, view, viewer }) => {
      const judged = channel('900000000000000100', overwrites)

      expect(
        viewsOf(server, viewer, { channels: [judged], threads: [] }).get(
          judged.discordChannelId
        )
      ).toEqual(view)
    }
  )

  const open = channel('900000000000000101')
  const hidden = channel('900000000000000102', [
    forRole(everyone, { deny: ViewChannel }),
  ])
  const moderated = channel('900000000000000103', [
    forRole(moderators, { allow: ManageThreads }),
  ])
  const category = {
    ...channel('900000000000000104'),
    isCategory: true,
  }

  it('lets a public thread answer as the channel it hangs in', () => {
    const views = viewsOf(serverWith(), holding(), {
      channels: [open, hidden],
      threads: [
        thread('900000000000000201', open.discordChannelId, false),
        thread('900000000000000202', hidden.discordChannelId, false),
      ],
    })

    expect(views.get('900000000000000201')).toEqual(
      views.get(open.discordChannelId)
    )
    expect(views.get('900000000000000201')).toEqual({
      through: 'role_server_permissions',
      discordRoleIds: [guildId],
    })
    expect(views.get('900000000000000202')).toBeNull()
  })

  it('shows a private thread to whoever manages threads where it hangs', () => {
    const views = viewsOf(serverWith(), holding(moderators), {
      channels: [moderated],
      threads: [thread('900000000000000203', moderated.discordChannelId, true)],
    })

    expect(views.get('900000000000000203')).toEqual({
      through: 'role_channel_permissions',
      discordRoleIds: [moderators.discordRoleId],
    })
  })

  it('leaves a private thread to its membership when the owner cannot manage threads there', () => {
    const views = viewsOf(serverWith(), holding(engineers), {
      channels: [moderated, hidden],
      threads: [
        thread('900000000000000204', moderated.discordChannelId, true),
        thread('900000000000000205', hidden.discordChannelId, true),
      ],
    })

    expect(views.get('900000000000000204')).toBe('only_if_added')
    expect(views.get('900000000000000205')).toBeNull()
  })

  it('leaves a timed-out owner a private thread only through membership, since a timeout takes Manage Threads away', () => {
    const views = viewsOf(serverWith(), timedOut(holding(moderators)), {
      channels: [moderated],
      threads: [thread('900000000000000207', moderated.discordChannelId, true)],
    })

    expect(views.get(moderated.discordChannelId)).toEqual({
      through: 'role_server_permissions',
      discordRoleIds: [guildId],
    })
    expect(views.get('900000000000000207')).toBe('only_if_added')
  })

  it('keeps showing a timed-out administrator or server owner every private thread', () => {
    const privateThread = thread(
      '900000000000000208',
      moderated.discordChannelId,
      true
    )
    const asAdministrator = viewsOf(serverWith(), timedOut(holding(admins)), {
      channels: [moderated],
      threads: [privateThread],
    })
    const asServerOwner = viewsOf(
      serverWith(everyone.permissions, ownerId),
      timedOut(holding()),
      { channels: [moderated], threads: [privateThread] }
    )

    expect(asAdministrator.get(privateThread.discordChannelId)).toEqual({
      through: 'administrator',
      discordRoleIds: [admins.discordRoleId],
    })
    expect(asServerOwner.get(privateThread.discordChannelId)).toEqual({
      through: 'server_owner',
    })
  })

  it('judges no category and no thread whose channel Discord did not show', () => {
    const views = viewsOf(serverWith(), holding(), {
      channels: [category],
      threads: [thread('900000000000000206', category.discordChannelId, false)],
    })

    expect(views.has(category.discordChannelId)).toBe(false)
    expect(views.get('900000000000000206')).toBeNull()
  })
})

describe('permissionLabelsOf', () => {
  it("names each permission once, in Discord's order, as Discord's settings word it", () => {
    expect(
      permissionLabelsOf(
        PermissionFlagsBits.MentionEveryone |
          PermissionFlagsBits.ManageGuildExpressions |
          Administrator |
          ManageMessages
      )
    ).toEqual([
      'Administrator',
      'Manage Messages',
      'Mention @everyone, @here, and All Roles',
      'Manage Expressions',
    ])
  })
})

describe('serverPermissions', () => {
  it("adds up @everyone's server-wide permissions and every held role's", () => {
    expect(serverPermissions(serverWith(), holding(moderators))).toBe(
      ViewChannel | SendMessages | ManageMessages
    )
    expect(
      serverPermissions(serverWith(), holding(engineers)) & ManageMessages
    ).toBe(0n)
  })

  it('keeps only View Channels and Read Message History while the owner is timed out', () => {
    expect(
      serverPermissions(
        serverWith(ViewChannel | SendMessages | ReadMessageHistory),
        timedOut(holding(moderators))
      )
    ).toBe(ViewChannel | ReadMessageHistory)
  })

  it('leaves a timed-out administrator or server owner every permission they hold', () => {
    expect(serverPermissions(serverWith(), timedOut(holding(admins)))).toBe(
      ViewChannel | SendMessages | Administrator
    )
    expect(
      serverPermissions(
        serverWith(everyone.permissions, ownerId),
        timedOut(holding(moderators))
      )
    ).toBe(ViewChannel | SendMessages | ManageMessages)
  })
})

describe('roleSetAsideSummary', () => {
  it('states each short-circuit plainly', () => {
    expect(
      roleSetAsideSummary({ kind: 'not_held', roleName: 'Engineers' })
    ).toBe('You do not hold Engineers, so nothing changes without it.')
    expect(
      roleSetAsideSummary({ kind: 'server_owner', roleName: 'Engineers' })
    ).toBe('You are the server owner, so you lose nothing without Engineers.')
    expect(
      roleSetAsideSummary({
        kind: 'administrator_elsewhere',
        roleName: 'Engineers',
        through: ['Admins'],
      })
    ).toBe(
      'Another of your roles (Admins) grants Administrator, so you lose nothing without Engineers.'
    )
    expect(
      roleSetAsideSummary({
        kind: 'administrator_elsewhere',
        roleName: 'Engineers',
        through: ['Admins', 'Founders', 'Ops'],
      })
    ).toBe(
      'Other roles of yours (Admins, Founders and Ops) grant Administrator, so you lose nothing without Engineers.'
    )
  })

  it('counts what a comparison loses, with honest plurals', () => {
    expect(
      roleSetAsideSummary({
        kind: 'compared',
        lostChannels: 1,
        lostPermissions: 2,
        onlyIfAdded: 0,
        roleName: 'Engineers',
      })
    ).toBe(
      'Without Engineers you would lose 1 channel or thread you can view now and 2 server-wide permissions.'
    )
    expect(
      roleSetAsideSummary({
        kind: 'compared',
        lostChannels: 3,
        lostPermissions: 0,
        onlyIfAdded: 1,
        roleName: 'Engineers',
      })
    ).toBe(
      'Without Engineers you would lose 3 channels and threads you can view now. 1 private thread would stay visible only if someone added you to it.'
    )
    expect(
      roleSetAsideSummary({
        kind: 'compared',
        lostChannels: 0,
        lostPermissions: 1,
        onlyIfAdded: 2,
        roleName: 'Engineers',
      })
    ).toBe(
      'Without Engineers you would lose 1 server-wide permission. 2 private threads would stay visible only if someone added you to them.'
    )
    expect(
      roleSetAsideSummary({
        kind: 'compared',
        lostChannels: 0,
        lostPermissions: 0,
        onlyIfAdded: 0,
        roleName: 'Engineers',
      })
    ).toBe(
      'Without Engineers you keep every channel, thread and server-wide permission you have now.'
    )
  })

  it('keeps no promise about the private threads only membership would leave you', () => {
    expect(
      roleSetAsideSummary({
        kind: 'compared',
        lostChannels: 0,
        lostPermissions: 0,
        onlyIfAdded: 1,
        roleName: 'Moderators',
      })
    ).toBe(
      'Without Moderators you keep every server-wide permission you have and every channel and thread you can view now, except that 1 private thread would stay visible only if someone added you to it.'
    )
    expect(
      roleSetAsideSummary({
        kind: 'compared',
        lostChannels: 0,
        lostPermissions: 0,
        onlyIfAdded: 2,
        roleName: 'Moderators',
      })
    ).toBe(
      'Without Moderators you keep every server-wide permission you have and every channel and thread you can view now, except that 2 private threads would stay visible only if someone added you to them.'
    )
  })
})

describe('withTimeout', () => {
  const summary = 'You can view 3 channels and threads right now.'

  it('leaves the summary alone when no timeout counts', () => {
    expect(withTimeout(summary, null)).toBe(summary)
  })

  it('says until when a timeout counts, and what it takes away', () => {
    expect(withTimeout(summary, { kind: 'counts', until: timeoutEnd })).toBe(
      `${summary} You are timed out until ${timeoutEnd}, and until then Discord takes away every permission you hold except View Channels and Read Message History, so a private thread you would see by managing threads is left out and no other server-wide permission counts.`
    )
  })

  it('says when only the role set aside exempts the owner from a timeout', () => {
    expect(
      withTimeout(summary, {
        kind: 'counts_without_role',
        roleName: 'Admins',
        until: timeoutEnd,
      })
    ).toBe(
      `${summary} You are timed out until ${timeoutEnd}. Administrator exempts you from the timeout now, but without Admins Discord would take away every permission you hold except View Channels and Read Message History until then.`
    )
  })
})

describe('permissionFetchFailureCopy', () => {
  it('gives every failure kind a summary and a next action to take', () => {
    expect([...everyFailureKind].sort()).toEqual(
      Object.keys(permissionFetchFailureCopy).sort()
    )
    expect(
      Object.values(permissionFetchFailureCopy).filter(
        ({ nextAction, summary }) => summary.trim() && nextAction.trim()
      )
    ).toHaveLength(everyFailureKind.length)
  })
})
