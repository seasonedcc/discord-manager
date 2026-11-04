import { InputError, applySchema } from 'composable-functions'
import { PermissionFlagsBits } from 'discord.js'
import { z } from 'zod'
import { ownerContextSchema } from '~/business/auth.server'
import {
  type ChannelAccessTransport,
  type ObservedChannel,
  type ObservedChannelAccess,
  type ObservedRole,
  type PermissionFetchFailureKind,
  PermissionFetchOwnerNotMemberError,
  PermissionFetchRejectedError,
  PermissionFetchServerUnknownError,
  type PermissionGrant,
  type RoleSetAsideOutcome,
  type ServerRolesTransport,
  type View,
  channelAccessCoverage,
  everyoneSetAsideMessage,
  listRolesSchema,
  permissionFetchFailureCopy,
  permissionLabelsOf,
  readChannelAccessSchema,
  roleSetAsideSummary,
  serverPermissions,
  unknownRoleMessage,
  viewsOf,
  visibleNowSummary,
} from '~/business/roles.common'
import { db } from '~/db/db.server'
import { newId } from '~/framework/db.server'

const rolesContextSchema = ownerContextSchema.extend({
  canReadMessages: z.literal(true),
})

type Owner = z.infer<typeof rolesContextSchema>['owner']

function failureKindOf(error: unknown): PermissionFetchFailureKind {
  if (error instanceof PermissionFetchOwnerNotMemberError) {
    return 'owner_not_member'
  }
  if (error instanceof PermissionFetchServerUnknownError) {
    return 'server_unknown'
  }
  if (error instanceof PermissionFetchRejectedError) return 'rejected'

  return 'unreachable'
}

async function fetchThroughDiscord<Observed>(
  reading: 'channel_access' | 'roles',
  owner: Owner,
  read: () => Promise<Observed>
) {
  const request = await db()
    .insertInto('permissionFetchRequests')
    .values({
      discordGuildId: owner.guildId,
      id: newId(),
      ownerDiscordUserId: owner.discordUserId,
      reading,
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  let observed: Observed

  try {
    observed = await read()
  } catch (error) {
    const kind = failureKindOf(error)

    await db()
      .insertInto('permissionFetchFailures')
      .values({
        errorMessage: error instanceof Error ? error.message : String(error),
        id: newId(),
        kind,
        permissionFetchRequestId: request.id,
      })
      .execute()

    return { status: 'failed' as const, ...permissionFetchFailureCopy[kind] }
  }

  await db()
    .insertInto('permissionFetchRetrievals')
    .values({ id: newId(), permissionFetchRequestId: request.id })
    .execute()

  return { status: 'retrieved' as const, observed }
}

function bySnowflake(left: string, right: string) {
  const difference = BigInt(left) - BigInt(right)

  return difference === 0n ? 0 : difference < 0n ? -1 : 1
}

function inDiscordOrder(roles: ObservedRole[]) {
  return [...roles].sort(
    (left, right) =>
      right.position - left.position ||
      bySnowflake(left.discordRoleId, right.discordRoleId)
  )
}

function grantsAdministrator({ permissions }: ObservedRole) {
  return (
    (permissions & PermissionFlagsBits.Administrator) ===
    PermissionFlagsBits.Administrator
  )
}

function listRoles(transport: ServerRolesTransport) {
  return applySchema(
    listRolesSchema,
    rolesContextSchema
  )(async (_input, { owner }) => {
    const fetched = await fetchThroughDiscord('roles', owner, () =>
      transport({
        discordGuildId: owner.guildId,
        ownerDiscordUserId: owner.discordUserId,
      })
    )

    if (fetched.status === 'failed') return fetched

    const { observed } = fetched

    return {
      status: 'retrieved' as const,
      ownerIsServerOwner:
        observed.serverOwnerDiscordUserId === owner.discordUserId,
      roles: inDiscordOrder(observed.roles).map((role) => ({
        discordRoleId: role.discordRoleId,
        name: role.name,
        mentionable: role.mentionable,
        grantsAdministrator: grantsAdministrator(role),
        ownerHolds:
          role.discordRoleId === owner.guildId ||
          observed.ownerDiscordRoleIds.includes(role.discordRoleId),
      })),
    }
  })
}

function inSidebarOrder({ channels, threads }: ObservedChannelAccess) {
  const byPosition = (left: ObservedChannel, right: ObservedChannel) =>
    left.position - right.position ||
    bySnowflake(left.discordChannelId, right.discordChannelId)
  const childrenOf = (parentDiscordChannelId: string | null) =>
    channels
      .filter(
        (channel) =>
          !channel.isCategory &&
          channel.parentDiscordChannelId === parentDiscordChannelId
      )
      .sort(byPosition)
  const threadsOf = ({ discordChannelId }: ObservedChannel) =>
    threads
      .filter(
        ({ parentDiscordChannelId }) =>
          parentDiscordChannelId === discordChannelId
      )
      .sort(
        (left, right) =>
          left.name.localeCompare(right.name) ||
          bySnowflake(left.discordChannelId, right.discordChannelId)
      )
  const categories = channels
    .filter(({ isCategory }) => isCategory)
    .sort(byPosition)
  const uncategorized = channels.filter(
    (channel) =>
      !channel.isCategory &&
      channel.parentDiscordChannelId !== null &&
      !categories.some(
        ({ discordChannelId }) =>
          discordChannelId === channel.parentDiscordChannelId
      )
  )

  return [
    ...[...childrenOf(null), ...uncategorized.sort(byPosition)].map(
      (channel) => ({ category: undefined, channel })
    ),
    ...categories.flatMap((category) =>
      childrenOf(category.discordChannelId).map((channel) => ({
        category: category.name,
        channel,
      }))
    ),
  ].flatMap(({ category, channel }) => [
    {
      category,
      discordChannelId: channel.discordChannelId,
      isThread: false,
      name: channel.name,
    },
    ...threadsOf(channel).map((thread) => ({
      category: channel.name,
      discordChannelId: thread.discordChannelId,
      isThread: true,
      name: thread.name,
    })),
  ])
}

function describeGrant(grant: PermissionGrant, roles: ObservedRole[]) {
  const namesOf = (discordRoleIds: string[]) =>
    inDiscordOrder(
      roles.filter(({ discordRoleId }) =>
        discordRoleIds.includes(discordRoleId)
      )
    ).map(({ name }) => name)

  switch (grant.through) {
    case 'server_owner':
    case 'your_channel_permissions':
      return { grantedThrough: grant.through, grantedBy: [] }
    case 'everyone_channel_permissions':
      return { grantedThrough: grant.through, grantedBy: ['@everyone'] }
    default:
      return {
        grantedThrough: grant.through,
        grantedBy: namesOf(grant.discordRoleIds),
      }
  }
}

function canViewWithout(view: View | undefined) {
  if (view === 'only_if_added') return 'only_if_added'

  return view ? 'yes' : 'no'
}

function readChannelAccess(transport: ChannelAccessTransport) {
  return applySchema(
    readChannelAccessSchema,
    rolesContextSchema
  )(async ({ withoutDiscordRoleId }, { owner }) => {
    if (withoutDiscordRoleId === owner.guildId) {
      throw new InputError(everyoneSetAsideMessage, ['withoutDiscordRoleId'])
    }

    const fetched = await fetchThroughDiscord('channel_access', owner, () =>
      transport({
        discordGuildId: owner.guildId,
        ownerDiscordUserId: owner.discordUserId,
      })
    )

    if (fetched.status === 'failed') return fetched

    const { observed } = fetched

    const roleSetAside = withoutDiscordRoleId
      ? observed.roles.find(
          ({ discordRoleId }) => discordRoleId === withoutDiscordRoleId
        )
      : undefined

    if (withoutDiscordRoleId && !roleSetAside) {
      throw new InputError(unknownRoleMessage, ['withoutDiscordRoleId'])
    }

    const server = {
      discordGuildId: owner.guildId,
      roles: observed.roles,
      serverOwnerDiscordUserId: observed.serverOwnerDiscordUserId,
    }
    const viewer = {
      discordUserId: owner.discordUserId,
      heldDiscordRoleIds: observed.ownerDiscordRoleIds,
    }
    const viewsNow = viewsOf(server, viewer, observed)
    const visible = inSidebarOrder(observed).flatMap(
      ({ category, ...channel }) => {
        const view = viewsNow.get(channel.discordChannelId)

        if (!view || view === 'only_if_added') return []

        return [
          {
            ...channel,
            ...(category === undefined ? {} : { category }),
            ...describeGrant(view, observed.roles),
          },
        ]
      }
    )

    if (!roleSetAside) {
      return {
        status: 'retrieved' as const,
        summary: visibleNowSummary(visible.length),
        coverage: channelAccessCoverage,
        channels: visible,
      }
    }

    const viewerWithout = {
      ...viewer,
      heldDiscordRoleIds: viewer.heldDiscordRoleIds.filter(
        (discordRoleId) => discordRoleId !== roleSetAside.discordRoleId
      ),
    }
    const viewsWithout = viewsOf(server, viewerWithout, observed)
    const channels = visible.map((channel) => ({
      ...channel,
      canViewWithoutRole: canViewWithout(
        viewsWithout.get(channel.discordChannelId)
      ),
    }))
    const ownerHolds = viewer.heldDiscordRoleIds.includes(
      roleSetAside.discordRoleId
    )
    const administratorsElsewhere = inDiscordOrder(
      observed.roles.filter(
        (role) =>
          role.discordRoleId !== roleSetAside.discordRoleId &&
          (role.discordRoleId === owner.guildId ||
            viewer.heldDiscordRoleIds.includes(role.discordRoleId)) &&
          grantsAdministrator(role)
      )
    ).map(({ name }) => name)
    const serverOwner =
      observed.serverOwnerDiscordUserId === owner.discordUserId
    const lostPermissions =
      !ownerHolds || serverOwner || administratorsElsewhere.length > 0
        ? []
        : permissionLabelsOf(
            serverPermissions(server, viewer) &
              ~serverPermissions(server, viewerWithout)
          )
    const roleName = roleSetAside.name
    const countOf = (canViewWithoutRole: ReturnType<typeof canViewWithout>) =>
      channels.filter(
        (channel) => channel.canViewWithoutRole === canViewWithoutRole
      ).length

    function outcome(): RoleSetAsideOutcome {
      if (!ownerHolds) return { kind: 'not_held', roleName }
      if (serverOwner) return { kind: 'server_owner', roleName }
      if (administratorsElsewhere.length > 0) {
        return {
          kind: 'administrator_elsewhere',
          roleName,
          through: administratorsElsewhere,
        }
      }

      return {
        kind: 'compared',
        lostChannels: countOf('no'),
        lostPermissions: lostPermissions.length,
        onlyIfAdded: countOf('only_if_added'),
        roleName,
      }
    }

    return {
      status: 'retrieved' as const,
      summary: roleSetAsideSummary(outcome()),
      coverage: channelAccessCoverage,
      withoutRole: {
        discordRoleId: roleSetAside.discordRoleId,
        name: roleName,
        ownerHolds,
        lostPermissions,
      },
      channels,
    }
  })
}

export { listRoles, readChannelAccess }
