import type { Kysely } from 'kysely'
import { sql } from 'kysely'

const nowIso = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
const messageSendSkipReason = sql`reason in ('channel_not_found', 'channel_not_in_guild', 'empty_content')`
const messageSendFailureKind = sql`kind in ('rejected', 'unreachable')`

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('messageSendRequests')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('channelId', 'text', (col) =>
      col.notNull().references('channels.id')
    )
    .addColumn('content', 'text', (col) => col.notNull())
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .execute()

  await db.schema
    .createIndex('messageSendRequestsChannelIdCreatedAtIndex')
    .on('messageSendRequests')
    .columns(['channelId', 'createdAt desc'])
    .execute()

  await db.schema
    .createTable('messageSendDeliveries')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('messageSendRequestId', 'text', (col) =>
      col.notNull().references('messageSendRequests.id')
    )
    .addColumn('discordMessageId', 'text', (col) => col.notNull())
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .execute()

  await db.schema
    .createIndex('messageSendDeliveriesRequestIdCreatedAtIndex')
    .on('messageSendDeliveries')
    .columns(['messageSendRequestId', 'createdAt desc'])
    .execute()

  await db.schema
    .createTable('messageSendFailures')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('messageSendRequestId', 'text', (col) =>
      col.notNull().references('messageSendRequests.id')
    )
    .addColumn('kind', 'text', (col) =>
      col.notNull().check(messageSendFailureKind)
    )
    .addColumn('errorMessage', 'text', (col) => col.notNull())
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .execute()

  await db.schema
    .createIndex('messageSendFailuresRequestIdCreatedAtIndex')
    .on('messageSendFailures')
    .columns(['messageSendRequestId', 'createdAt desc'])
    .execute()

  await db.schema
    .createTable('messageSendSkips')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('messageSendRequestId', 'text', (col) =>
      col.notNull().references('messageSendRequests.id')
    )
    .addColumn('reason', 'text', (col) =>
      col.notNull().check(messageSendSkipReason)
    )
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .execute()

  await db.schema
    .createIndex('messageSendSkipsRequestIdCreatedAtIndex')
    .on('messageSendSkips')
    .columns(['messageSendRequestId', 'createdAt desc'])
    .execute()

  await db.schema
    .createTable('backfillRuns')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('channelId', 'text', (col) =>
      col.notNull().references('channels.id')
    )
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .execute()

  await db.schema
    .createIndex('backfillRunsChannelIdCreatedAtIndex')
    .on('backfillRuns')
    .columns(['channelId', 'createdAt desc'])
    .execute()

  await db.schema
    .createTable('backfillRunProgress')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('backfillRunId', 'text', (col) =>
      col.notNull().references('backfillRuns.id')
    )
    .addColumn('fetchedMessageCount', 'integer', (col) => col.notNull())
    .addColumn('storedMessageCount', 'integer', (col) => col.notNull())
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .execute()

  await db.schema
    .createIndex('backfillRunProgressRunIdCreatedAtIndex')
    .on('backfillRunProgress')
    .columns(['backfillRunId', 'createdAt desc'])
    .execute()

  await db.schema
    .createTable('backfillRunCompletions')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('backfillRunId', 'text', (col) =>
      col.notNull().references('backfillRuns.id')
    )
    .addColumn('fetchedMessageCount', 'integer', (col) => col.notNull())
    .addColumn('storedMessageCount', 'integer', (col) => col.notNull())
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .execute()

  await db.schema
    .createIndex('backfillRunCompletionsRunIdCreatedAtIndex')
    .on('backfillRunCompletions')
    .columns(['backfillRunId', 'createdAt desc'])
    .execute()

  await db.schema
    .createTable('backfillRunFailures')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('backfillRunId', 'text', (col) =>
      col.notNull().references('backfillRuns.id')
    )
    .addColumn('errorMessage', 'text', (col) => col.notNull())
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .execute()

  await db.schema
    .createIndex('backfillRunFailuresRunIdCreatedAtIndex')
    .on('backfillRunFailures')
    .columns(['backfillRunId', 'createdAt desc'])
    .execute()

  await db.schema
    .createTable('gatewayConnections')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .execute()

  await db.schema
    .createIndex('gatewayConnectionsCreatedAtIndex')
    .on('gatewayConnections')
    .columns(['createdAt desc'])
    .execute()

  await db.schema
    .createTable('gatewayHeartbeats')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .execute()

  await db.schema
    .createIndex('gatewayHeartbeatsCreatedAtIndex')
    .on('gatewayHeartbeats')
    .columns(['createdAt desc'])
    .execute()

  await db.schema
    .createTable('gatewayDisconnections')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .execute()

  await db.schema
    .createIndex('gatewayDisconnectionsCreatedAtIndex')
    .on('gatewayDisconnections')
    .columns(['createdAt desc'])
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('gatewayDisconnections').execute()
  await db.schema.dropTable('gatewayHeartbeats').execute()
  await db.schema.dropTable('gatewayConnections').execute()
  await db.schema.dropTable('backfillRunFailures').execute()
  await db.schema.dropTable('backfillRunCompletions').execute()
  await db.schema.dropTable('backfillRunProgress').execute()
  await db.schema.dropTable('backfillRuns').execute()
  await db.schema.dropTable('messageSendSkips').execute()
  await db.schema.dropTable('messageSendFailures').execute()
  await db.schema.dropTable('messageSendDeliveries').execute()
  await db.schema.dropTable('messageSendRequests').execute()
}
