import type { Kysely } from 'kysely'
import { sql } from 'kysely'

const nowIso = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
const isThreadFlag = sql`is_thread in (0, 1)`

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('guilds')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('discordGuildId', 'text', (col) => col.notNull().unique())
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .execute()

  await db.schema
    .createTable('channels')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('guildId', 'text', (col) =>
      col.notNull().references('guilds.id')
    )
    .addColumn('discordChannelId', 'text', (col) => col.notNull().unique())
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .execute()

  await db.schema
    .createIndex('channelsGuildIdCreatedAtIndex')
    .on('channels')
    .columns(['guildId', 'createdAt desc'])
    .execute()

  await db.schema
    .createTable('members')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('discordUserId', 'text', (col) => col.notNull().unique())
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .execute()

  await db.schema
    .createTable('messages')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('channelId', 'text', (col) =>
      col.notNull().references('channels.id')
    )
    .addColumn('authorMemberId', 'text', (col) =>
      col.notNull().references('members.id')
    )
    .addColumn('discordMessageId', 'text', (col) => col.notNull().unique())
    .addColumn('discordCreatedAt', 'text', (col) => col.notNull())
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .execute()

  await db.schema
    .createIndex('messagesChannelIdDiscordCreatedAtIndex')
    .on('messages')
    .columns(['channelId', 'discordCreatedAt desc'])
    .execute()

  await db.schema
    .createIndex('messagesAuthorMemberIdDiscordCreatedAtIndex')
    .on('messages')
    .columns(['authorMemberId', 'discordCreatedAt desc'])
    .execute()

  await db.schema
    .createTable('channelDetailRevisions')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('channelId', 'text', (col) =>
      col.notNull().references('channels.id')
    )
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('isThread', 'integer', (col) =>
      col.notNull().check(isThreadFlag)
    )
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .execute()

  await db.schema
    .createIndex('channelDetailRevisionsChannelIdCreatedAtIndex')
    .on('channelDetailRevisions')
    .columns(['channelId', 'createdAt desc'])
    .execute()

  await db.schema
    .createTable('channelTopicChanges')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('channelId', 'text', (col) =>
      col.notNull().references('channels.id')
    )
    .addColumn('topic', 'text', (col) => col.notNull())
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .execute()

  await db.schema
    .createIndex('channelTopicChangesChannelIdCreatedAtIndex')
    .on('channelTopicChanges')
    .columns(['channelId', 'createdAt desc'])
    .execute()

  await db.schema
    .createTable('channelTopicClearings')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('channelId', 'text', (col) =>
      col.notNull().references('channels.id')
    )
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .execute()

  await db.schema
    .createIndex('channelTopicClearingsChannelIdCreatedAtIndex')
    .on('channelTopicClearings')
    .columns(['channelId', 'createdAt desc'])
    .execute()

  await db.schema
    .createTable('channelCategoryChanges')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('channelId', 'text', (col) =>
      col.notNull().references('channels.id')
    )
    .addColumn('category', 'text', (col) => col.notNull())
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .execute()

  await db.schema
    .createIndex('channelCategoryChangesChannelIdCreatedAtIndex')
    .on('channelCategoryChanges')
    .columns(['channelId', 'createdAt desc'])
    .execute()

  await db.schema
    .createTable('channelCategoryClearings')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('channelId', 'text', (col) =>
      col.notNull().references('channels.id')
    )
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .execute()

  await db.schema
    .createIndex('channelCategoryClearingsChannelIdCreatedAtIndex')
    .on('channelCategoryClearings')
    .columns(['channelId', 'createdAt desc'])
    .execute()

  await db.schema
    .createTable('channelPositionChanges')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('channelId', 'text', (col) =>
      col.notNull().references('channels.id')
    )
    .addColumn('position', 'integer', (col) => col.notNull())
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .execute()

  await db.schema
    .createIndex('channelPositionChangesChannelIdCreatedAtIndex')
    .on('channelPositionChanges')
    .columns(['channelId', 'createdAt desc'])
    .execute()

  await db.schema
    .createTable('channelPositionClearings')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('channelId', 'text', (col) =>
      col.notNull().references('channels.id')
    )
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .execute()

  await db.schema
    .createIndex('channelPositionClearingsChannelIdCreatedAtIndex')
    .on('channelPositionClearings')
    .columns(['channelId', 'createdAt desc'])
    .execute()

  await db.schema
    .createTable('channelRemovals')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('channelId', 'text', (col) =>
      col.notNull().references('channels.id')
    )
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .execute()

  await db.schema
    .createIndex('channelRemovalsChannelIdCreatedAtIndex')
    .on('channelRemovals')
    .columns(['channelId', 'createdAt desc'])
    .execute()

  await db.schema
    .createTable('memberDetailRevisions')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('memberId', 'text', (col) =>
      col.notNull().references('members.id')
    )
    .addColumn('username', 'text', (col) => col.notNull())
    .addColumn('displayName', 'text', (col) => col.notNull())
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .execute()

  await db.schema
    .createIndex('memberDetailRevisionsMemberIdCreatedAtIndex')
    .on('memberDetailRevisions')
    .columns(['memberId', 'createdAt desc'])
    .execute()

  await db.schema
    .createTable('messageRevisions')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('messageId', 'text', (col) =>
      col.notNull().references('messages.id')
    )
    .addColumn('content', 'text', (col) => col.notNull())
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .execute()

  await db.schema
    .createIndex('messageRevisionsMessageIdCreatedAtIndex')
    .on('messageRevisions')
    .columns(['messageId', 'createdAt desc'])
    .execute()

  await db.schema
    .createTable('messageDeletions')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('messageId', 'text', (col) =>
      col.notNull().references('messages.id')
    )
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .execute()

  await db.schema
    .createIndex('messageDeletionsMessageIdCreatedAtIndex')
    .on('messageDeletions')
    .columns(['messageId', 'createdAt desc'])
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('messageDeletions').execute()
  await db.schema.dropTable('messageRevisions').execute()
  await db.schema.dropTable('memberDetailRevisions').execute()
  await db.schema.dropTable('channelRemovals').execute()
  await db.schema.dropTable('channelPositionClearings').execute()
  await db.schema.dropTable('channelPositionChanges').execute()
  await db.schema.dropTable('channelCategoryClearings').execute()
  await db.schema.dropTable('channelCategoryChanges').execute()
  await db.schema.dropTable('channelTopicClearings').execute()
  await db.schema.dropTable('channelTopicChanges').execute()
  await db.schema.dropTable('channelDetailRevisions').execute()
  await db.schema.dropTable('messages').execute()
  await db.schema.dropTable('members').execute()
  await db.schema.dropTable('channels').execute()
  await db.schema.dropTable('guilds').execute()
}
