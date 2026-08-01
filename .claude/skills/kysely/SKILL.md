---
name: kysely
description: Write Kysely queries and SQLite migrations following project conventions — CamelCasePlugin naming, builder over raw SQL, transactions, and regenerating app/db/types.d.ts. Use when writing a migration, creating a table or index, adding a column, writing a database query, using a transaction, or running db:migrate, db:rollback, or db:generate.
---

# Kysely

Everything here documents the repository as it is on `main`. If `main` disagrees with this file, `main` wins: follow it and flag the drift.

These conventions govern every Kysely query and migration in this project. The database is SQLite through `better-sqlite3`, and the connection is built with `CamelCasePlugin`, which converts identifiers from camelCase to snake_case automatically.

## INSERT is the only write

The application schema is 100% append-only — load the `database-design` skill for the full doctrine. Application code never calls `updateTable`, `deleteFrom`, or `truncate` on application tables, and never uses `.onConflict((oc) => oc.doUpdateSet(...))`, because an upsert's update arm is an UPDATE. State changes are new event rows; current state is derived at query time.

`.onConflict((oc) => oc.doNothing())` is fine: it makes an insert idempotent without mutating anything, which is exactly what re-observing an already-ingested Discord message needs.

## Prefer the builder over raw SQL

Use the schema builder for anything Kysely expresses natively. Reserve `sql` template literals for what it cannot.

Instead of:
```typescript
await sql`create index message_revisions_message_id_created_at on message_revisions (message_id, created_at desc)`.execute(db)
```

Do:
```typescript
await db.schema
  .createIndex('messageRevisionsMessageIdCreatedAt')
  .on('messageRevisions')
  .columns(['messageId', 'createdAt desc'])
  .execute()
```

SQLite column types that work as string literals: `'text'`, `'integer'`, `'real'`, `'blob'`. There are no other storage classes — `text` covers ids, timestamps, and JSON payloads; `integer` covers booleans and counts.

## When raw SQL is appropriate

Use `sql` template literals for:

- **Function calls in defaults**: ``col.defaultTo(sql`strftime('%Y-%m-%dT%H:%M:%fZ','now')`)``
- **Check constraints**: ``.addCheckConstraint('bookmarkAdditionsSource', sql`source in ('reaction','mcp')`)``
- **Window functions**: ``sql<number>`row_number() over (partition by message_id order by created_at desc, id desc)` ``
- **Pragmas**: WAL mode and foreign-key enforcement are set once in `app/framework/db.server.ts`, never in a migration
- **Complex expressions**: filtered aggregates, raw subqueries inside a CTE

## CamelCasePlugin awareness

The plugin transforms identifiers in builder calls from camelCase to snake_case. Raw SQL bypasses it entirely.

- Builder methods take **camelCase**: `createTable('messageRevisions')` produces `create table message_revisions`
- Raw SQL is written in **snake_case**: ``sql`partition by message_id` `` stays as written

The trap that bites most: a query builder joining a table under a camelCase alias has that alias rewritten too, so a raw `sql` fragment in the same query must reference the alias in snake_case or the reference silently fails to resolve.

## Always await `.execute()`

Every Kysely operation that calls `.execute()` is awaited. A missing `await` creates a race where a later operation runs before the current one finishes.

Instead of:
```typescript
db.schema.createTable('messages').execute()
await db.schema.createIndex('messagesChannelId').on('messages').column('channelId').execute()
```

Do:
```typescript
await db.schema.createTable('messages').execute()
await db.schema.createIndex('messagesChannelId').on('messages').column('channelId').execute()
```

## camelCase in migrations

Use camelCase for every identifier in a builder call — table names, column names, constraint names, index names. Only raw SQL strings are written in snake_case.

```typescript
await db.schema
  .createTable('messageRevisions')                       // becomes message_revisions
  .addColumn('id', 'text', (col) => col.primaryKey().notNull())
  .addColumn('messageId', 'text', (col) =>               // becomes message_id
    col.notNull().references('messages.id'),
  )
  .addColumn('content', 'text', (col) => col.notNull())
  .addColumn('createdAt', 'text', (col) =>               // becomes created_at
    col.defaultTo(sql`strftime('%Y-%m-%dT%H:%M:%fZ','now')`).notNull(),
  )
  .execute()
```

Primary keys carry no default — ids come from application code. Timestamps are ISO-8601 UTC text. Load `database-design` for the reasoning behind both.

## No application imports in migrations

Migration files import only from `kysely` and Node built-ins. Never from `~/business/`, `~/framework/`, or any other application code. Logic a migration needs is duplicated inside it. Load `database-design` for the full rationale.

## Migration scripts and generated types

- `pnpm run db:migration` scaffolds a timestamped, prose-named migration file in `app/db/migrations/`.
- `pnpm run db:migrate` runs pending migrations against the configured store and then regenerates `app/db/types.d.ts`.
- `pnpm run db:rollback` reverts the most-recently-executed migration on the configured store and regenerates types.
- `pnpm run db:generate` regenerates types alone.

**Generation never reads the configured store.** `app/db/scripts/generate.ts` applies every migration in `app/db/migrations` to a throwaway SQLite file under `tests/.artifacts/`, runs kysely-codegen against that, and deletes it, so `app/db/types.d.ts` is a pure function of the migrations folder — identical on every machine whatever `DATABASE_PATH` points at. That is also why `db:rollback` leaves the types fully migrated: rolling a store back to N-1 removes no migration file, and the migrate → rollback → migrate ritual ends fully migrated anyway. `app/db/scripts/generate.test.ts` regenerates the file on every `test:unit` run and fails when the committed copy has drifted.

**Never hand-merge `app/db/types.d.ts`.** After any rebase or conflict, take either side, then run `pnpm run db:generate` and diff: expect byte-identical, or a clean additions-only result. Git happily auto-merges a semantically wrong types file. When two branches both carry migrations, the one merging second re-rebases and regenerates after the first lands.

**`db:rollback` reverts the most-recently-EXECUTED migration on that database, not the highest-timestamped file.** After a rebase, migrations can have run out of filename order, so a rollback may hit a different migration than intended. To prove a specific migration's `down()`, point `DATABASE_PATH` at a throwaway file where the exact set of executed migrations is known.

**Prove `down()` against dirtied data, not only a pristine round trip.** Run the feature (or its tests) so the database holds data only the new schema can represent, then roll back. If the old schema genuinely cannot hold that data, `down()` fails with a descriptive pre-check error, never a raw constraint violation.

SQLite's `alter table` is narrow, and that never becomes a problem here: migrations add tables, add columns, and add indexes. Reshaping an existing event table is forbidden by the doctrine, so the table-rebuild dance never comes up.

## Deterministic ordering for reads

When a query orders rows by a non-unique column — a timestamp, a count — add a tiebreak on a stable meaningful column before any final `orderBy('id')`. Primary keys sort in the order the writing process issued them, so an id-only tiebreak orders tied rows by when they happened to be written rather than by anything the owner would recognise — and two processes writing in the same millisecond leave even that undefined.

A Discord snowflake is a number stored as text, so ordering by it needs `cast(discord_message_id as integer)`: lexicographic order breaks the moment ids differ in length, and in JavaScript the comparison is `BigInt`, never `localeCompare`.

```typescript
.orderBy('messages.discordCreatedAt', 'asc')
.orderBy('messages.discordMessageId', 'asc')
.orderBy('messages.id', 'asc')
```

Rows tie far more often than seed data suggests: a busy channel produces same-millisecond timestamps constantly.

## Minimize database roundtrips

Compose operations into a single query instead of interleaving JS with several roundtrips. Use returning clauses, subqueries, and CTEs to keep logic in SQL.

### Append instead of check-then-branch

The mutable-schema instinct is "check whether a row exists, then insert or update". In an append-only schema there is nothing to branch on: every action appends its event row, and the latest event wins at read time.

Instead of:
```typescript
const existing = await db().selectFrom('bookmarkAdditions').where('messageId', '=', messageId).executeTakeFirst()
if (existing) {
  // mutate the existing row
} else {
  // insert a new row
}
```

Do:
```typescript
await db()
  .insertInto('bookmarkAdditions')
  .values({ id: newId(), messageId, source })
  .executeTakeFirstOrThrow()
```

Whether the message is bookmarked derives from the latest of its addition and removal events. When an insert must be idempotent — a re-delivered gateway event, a re-run backfill page — put a unique constraint on the natural key and add `.onConflict((oc) => oc.doNothing())`.

### Use `.returning()` instead of a separate SELECT after a write

Instead of:
```typescript
await db().insertInto('messages').values(values).execute()
const record = await db().selectFrom('messages').where('discordMessageId', '=', values.discordMessageId).executeTakeFirstOrThrow()
```

Do:
```typescript
const record = await db()
  .insertInto('messages')
  .values(values)
  .returning(['id', 'discordMessageId', 'createdAt'])
  .executeTakeFirstOrThrow()
```

### Use subqueries in `.values()` instead of fetching into JS

Instead of:
```typescript
const channel = await db().selectFrom('channels').select('id').where('discordChannelId', '=', discordChannelId).executeTakeFirstOrThrow()
await db().insertInto('messages').values({ id: newId(), channelId: channel.id, ... }).execute()
```

Do:
```typescript
await db()
  .insertInto('messages')
  .values((eb) => ({
    id: newId(),
    channelId: eb.selectFrom('channels').select('id').where('discordChannelId', '=', discordChannelId),
    ...rest,
  }))
  .execute()
```

### Use transactions for multi-step writes

When several writes must succeed or fail together — an identity row plus the first row of each of its event tables — wrap them in a transaction. The callback receives `trx`; use it instead of `db()` for every query inside:

```typescript
const message = await db()
  .transaction()
  .execute(async (trx) => {
    const record = await trx
      .insertInto('messages')
      .values(messageValues)
      .returning('id')
      .executeTakeFirstOrThrow()

    await trx
      .insertInto('messageRevisions')
      .values({ id: newId(), messageId: record.id, content })
      .execute()

    return record
  })
```

Transactions auto-rollback on exceptions, and the callback's return value becomes the return value of `.execute()`.

**Never open a transaction from inside a transaction.** SQLite has one write connection; a nested `db().transaction()` inside an open transaction is an error, not a queue. Logic needed inside a transaction takes the transaction as a parameter:

```typescript
import type { Transaction } from 'kysely'
import type { DB } from '~/db/types'

async function insertMessageWithRevision(trx: Transaction<DB>, values: MessageValues) {
  const record = await trx
    .insertInto('messages')
    .values(values)
    .returning('id')
    .executeTakeFirstOrThrow()

  return await trx
    .insertInto('messageRevisions')
    .values({ id: newId(), messageId: record.id, content: values.content })
    .returning('id')
    .executeTakeFirstOrThrow()
}
```

A function written this way is callable from both a standalone write and a larger transaction.

### Use `case()` for conditional computed columns

Use the expression builder's `case()` for SQL CASE expressions instead of deriving values in JS after the query. This keeps the logic in SQL and avoids a post-processing `.map()`.

```typescript
.select((eb) =>
  eb
    .case()
    .when(eb.exists(eb.selectFrom('backfillRunFailures').select('id').whereRef('backfillRunFailures.backfillRunId', '=', 'backfillRuns.id')))
    .then('failed')
    .when(eb.exists(eb.selectFrom('backfillRunCompletions').select('id').whereRef('backfillRunCompletions.backfillRunId', '=', 'backfillRuns.id')))
    .then('completed')
    .else('pending')
    .end()
    .$castTo<BackfillRunStatus>()
    .as('status'),
)
```

Key patterns:
- `eb.and([...])` / `eb.or([...])` for compound conditions
- `eb.ref('columnName')` for column-to-column comparisons on the right-hand side
- `$castTo<Type>()` to narrow the result to a union of string literals
- Mix `eb()` (camelCase, goes through the plugin) with `sql` template literals (snake_case) for SQLite functions

### Type-annotate `sql` fragments used as `eb()` operands

A `sql` template literal used as the right-hand operand of an `eb()` comparison needs a type annotation matching the column's type. Without it, TypeScript infers `RawBuilder<unknown>`, which is not assignable.

Instead of:
```typescript
eb('createdAt', '<', sql`strftime('%Y-%m-%dT%H:%M:%fZ','now','-15 minutes')`)
```

Do:
```typescript
eb('createdAt', '<', sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ','now','-15 minutes')`)
```

Timestamps are `string` columns, counts are `number`, booleans are `number` (0/1).

### Use `.with()` to name a subquery referenced more than once

A ranked-events CTE is referenced by the derivation and often by a second join in the same query. Name it once with `.with()` rather than repeating the window function:

```typescript
db()
  .with('latestRevision', (qb) => rankedRevisions(qb))
  .selectFrom('messages')
  .innerJoin('latestRevision', 'latestRevision.messageId', 'messages.id')
  .where('latestRevision.rank', '=', 1)
```

Load `database-design` for the derivation patterns themselves.
