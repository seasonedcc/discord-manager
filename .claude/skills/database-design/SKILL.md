---
name: database-design
description: Design SQLite tables and migrations under the project's zero-exception append-only, event-sourced doctrine. Use when creating tables, writing migrations, adding columns, modeling a state change, deriving current state, choosing between an identity and an event table, or writing the dev seed.
---

# Database Design

ALWAYS load the "kysely" skill before anything else. These principles govern every table and every migration in `app/db/migrations/`.

## The doctrine: 100% append-only, event-sourced, zero exceptions

The application schema is insert-only. `INSERT` is the only write the application ever performs. No `UPDATE`, no `DELETE`, no `TRUNCATE`, no `ON CONFLICT ... DO UPDATE`. This holds for every application table with zero exceptions — including anything that feels "infrastructural". A design that seems to require mutating a row is wrong: model the change as a new event row.

What this buys:

- A complete audit trail with no extra machinery — the schema *is* the audit trail
- Time travel: any past state is reconstructed by filtering events by `createdAt`
- No lost-update bugs, no races between readers and writers of the same row
- No sync risk between stored state and the events that produced it

The only table outside the rule is Kysely's own migration bookkeeping table, which mutates itself internally. Never design tables there and never write to it directly.

## Two kinds of tables

Every application table is one of two kinds.

**Identity tables** hold what is immutable by design: `id`, `createdAt`, ownership foreign keys that can never change, and the external identifier the row exists to pin. Nothing else. When it is unclear whether an attribute is truly immutable for the row's entire life, it is not — it belongs in an event table.

**Event tables** hold everything that happens to an entity after (and including) its birth. Each row is a fact that occurred at `createdAt` and is never modified.

```
messages                      -- identity: which message exists
  id                  text PK
  channel_id          text not null (FK)
  author_member_id    text not null (FK)
  discord_message_id  text not null unique
  discord_created_at  text not null
  created_at          text not null

message_revisions             -- event: what the message says
  id          text PK
  message_id  text not null (FK)
  content     text not null
  created_at  text not null   -- latest revision wins

message_deletions             -- event: the message was deleted
  id          text PK
  message_id  text not null (FK)
  created_at  text not null
```

## Event tables: one per cohesive concern

Slice mutable state into event tables **per cohesive concern** — fields that change together through one observed action share one table.

- A "revision" table snapshots **all** fields of its concern per change, never a diff, so reading current state needs only the latest row. `channel_detail_revisions` carries the name and `isThread` together because every channel always has both; the optional ones — topic, category, position — are their own event tables (see *No nullable columns*).
- Separately-actioned state changes each get their own narrow event table: `message_deletions`, `channel_removals`, `bookmark_snoozes`.
- Not per-field (table explosion, N-way joins to assemble current state), and not forced whole-entity (couples unrelated concerns).

**Creation is a transaction**: recording an entity writes the identity row plus the first row of each relevant event table in one transaction. A message's first `message_revisions` row lands with ingestion. "Latest event wins" then needs no special case for freshly created entities, and no column ever needs to be nullable while waiting for data.

**Naming**: identity tables are plural nouns (`messages`, `channels`, `members`); event tables are `<entity>_<past-action-plural>` (`message_revisions`, `bookmark_additions`, `gateway_disconnections`).

## One-way events and paired toggles

Model each transition by its real shape.

- **One-way transitions** (deletion, removal, completion): a single event table; the existence of a row *is* the state. A `message_deletions` row means the message is deleted, forever.
- **Reversible toggles** (bookmark/unbookmark): a pair of event tables; the newer of the two latest events wins. Each direction carries its own direction-specific data — `bookmark_additions` and `bookmark_removals` both carry `source` (`reaction` or `mcp`) so a public un-react and a private MCP resolve stay distinguishable facts.

```typescript
const bookmarkEvents = db()
  .selectFrom('bookmarkAdditions')
  .select(['messageId', 'createdAt', 'id', sql<number>`1`.as('bookmarked')])
  .unionAll(
    db()
      .selectFrom('bookmarkRemovals')
      .select(['messageId', 'createdAt', 'id', sql<number>`0`.as('bookmarked')])
  )
```

The latest row per `messageId` says whether the message is bookmarked; no rows means never bookmarked.

## Identifiers are generated in application code

SQLite has no `gen_random_uuid()`. Primary keys are `text` columns declared `primaryKey().notNull()` with **no default**, and the value comes from `newId()` in the insert helper — a monotonic UUIDv7, so ids issued by one process sort in issue order. That is what keeps the latest-event-wins `id desc` tie-break deterministic when two events land in the same millisecond; `crypto.randomUUID()` would decide those ties by chance. A migration never invents an id-generating default, and no insert site may omit the id.

The guarantee stops at the process boundary. Two processes writing to the same reversible pair within one millisecond leave the winner undefined, because neither knows the other's sequence. That is accepted, not a gap to close: the daemon is the only gateway writer, MCP writes are transactional, and no ordering machinery exists here (see *One writer, no ordering machinery*).

## Timestamps are ISO-8601 UTC text

Every timestamp column is `text` holding an ISO-8601 UTC instant with millisecond precision. `createdAt` defaults to `strftime('%Y-%m-%dT%H:%M:%fZ','now')`, which is always UTC. Lexicographic order equals chronological order, so `order by createdAt` is correct without any casting.

```typescript
.addColumn('createdAt', 'text', (col) =>
  col.defaultTo(sql`strftime('%Y-%m-%dT%H:%M:%fZ','now')`).notNull(),
)
```

Never store a Unix integer, never store local time, and never store a timestamp without the trailing `Z`. Timestamps observed from Discord (`discordCreatedAt`) are stored in the same format so they sort against the store's own timestamps.

In an event-sourced schema `createdAt` *is* the event time — the one timestamp every table has and every derivation orders by.

## Booleans are integer 0/1

SQLite has no boolean type. Boolean columns are `integer` with a `notNull()` and a `check` constraint restricting the value to `0` or `1`. Zod coerces at the boundary; application code never compares against a string.

## Reasons are CHECK constraints, not enum types

SQLite has no `CREATE TYPE`. A column with a closed vocabulary — a skip reason, a bookmark `source` — is a `text` column with a check constraint listing the allowed values, paired with a TypeScript union in the domain's `.common.ts`. The constraint and the union are added in the same change, and adding a value means a new migration plus a ruling on its copy (load `integration-telemetry` for the copy rule).

## Deriving current state

Current state is always computed at query time from events. The canonical patterns:

**Latest event wins** — a `row_number()` window function, filtered to 1:

```typescript
db()
  .with('ranked', (qb) =>
    qb
      .selectFrom('messageRevisions')
      .selectAll()
      .select(
        sql<number>`row_number() over (
          partition by message_id order by created_at desc, id desc
        )`.as('rank')
      )
  )
  .selectFrom('ranked')
  .selectAll()
  .where('rank', '=', 1)
```

The `id desc` tie-break is mandatory: SQLite's `strftime` clock has millisecond resolution, so two events in one transaction can share a timestamp, and without the tie-break a repeated read can return different rows. Still avoid creating the tie — one observed action appends one event per parent per transaction.

**Existence is state** — `EXISTS` / `NOT EXISTS`:

```typescript
.where(({ not, exists, selectFrom }) =>
  not(
    exists(
      selectFrom('messageDeletions')
        .select('id')
        .whereRef('messageDeletions.messageId', '=', 'messages.id')
    )
  )
)
```

**Aggregates over events** — counts and totals are computed from event rows, never stored.

**Status from event existence** — a `case` over `exists` chains: a completion row exists → completed, a failure row exists → failed, neither → pending. Only build the derivation when a tool or a business rule actually needs it.

**Indexes**: `(parentId, createdAt desc)` is the shape a latest-wins or existence derivation wants, but wanting the shape is not a reason to create the index. An index ships with the reader it serves and with the plan proving that reader chooses it (see *Performance: derive first, then escalate*). A table created before any query reads it ships with no index at all; the index arrives in the change that adds the query.

## One writer, no ordering machinery

The database runs in WAL mode and two processes share the file: the ingest daemon and the MCP server. The daemon is the **only** gateway writer, and MCP writes are transactional, so events cannot interleave in a way any derivation reads wrongly. There are no advisory locks, no shared lock families, and no monotonic sequence to assign — do not introduce any.

Two consequences to hold:

- No event family may mix delta events with absolute-set events over the same derived value. That is the one shape that would need commit-order guarantees the single-writer design does not provide. A new family that wants both is a design to rework, not a lock to add.
- Not every check-then-act sequence is a problem. Before treating one as a race, do the harm analysis: if the raced-in event is invisible to every current-state derivation (filtered out by a latest-wins or not-deleted predicate), no derived value can go wrong and check-then-append is fine.

## No mutable columns — period

A column either lives on an identity table because it is immutable by design, or it lives in an event table. There is no third kind.

## Deletion is an event

Never `DELETE`. Removal is a fact that happened, so it is recorded like any other fact:

- Discord reports a deleted message → a `message_deletions` row; queries exclude deleted messages
- A channel disappears from the bot's view → a `channel_removals` row
- Data was recorded in error → append a correction event; the erroneous event stays in history

Because rows are never deleted, `ON DELETE CASCADE` has nothing to attach to — foreign keys are plain references with no delete behavior.

## No nullable columns — zero exceptions

Every column in every table is non-nullable. Data unavailable at insert time belongs in a separate event table created when that data becomes available.

Instead of:
```
messages
  id                  text not null
  edited_at           text          -- nullable, filled on edit
```

Do:
```
messages
  id                  text not null

message_revisions
  id          text not null
  message_id  text not null (FK)
  content     text not null
  created_at  text not null
```

"Optional" attributes are not nullable columns either: model them as their own event table with zero-or-more rows per parent. A channel's topic, its category, its position, and a bookmark's snooze are all this shape — no rows means the parent never had one.

When such an attribute can be **cleared after being set**, one table cannot say so without a sentinel value, and a sentinel is a lie the schema will keep telling. Model it as a reversible pair instead: `channel_topic_changes` carries the value, `channel_topic_clearings` carries nothing, and the newer of the two latest rows wins — a change row means the attribute is present, a clearing row or no rows at all means it is absent. Both tables index on `(parentId, createdAt desc)` once a reader derives the attribute from them and the plan shows the index chosen.

A **set-valued attribute stamped per version of its parent** — the users a message pings, fixed by the vendor at each edit — attaches its zero-or-more rows to the *revision* row, not the parent: `message_revision_user_mentions` references `message_revisions`. The current set is simply the latest revision's rows, so "this version cleared the set" is zero rows under a new revision — no sentinel, no clearing table, and no latest-wins machinery beyond what the revisions already have. Keying such rows to the parent instead makes an emptied set indistinguishable from a set never observed. A unique constraint over `(revisionId, member)` is correct here — it states the set-membership fact and serves the reader's exact lookup.

## No `updatedAt` columns

Never add `updatedAt` to any table, and never add `editedAt`. The event row's `createdAt` *is* the timestamp of the change. In a schema where rows are never updated, an `updatedAt` column is meaningless.

## No derivable columns

Never store a column whose value can be inferred from event rows. Identity tables carry no `status`, no `archived`, no `isBookmarked`, no `current*` columns: all of it derives from events. A status that is always written alongside an event row is redundant and creates sync risk — the event row *is* the status.

## No unique constraints on event table FKs

Event tables never carry a unique constraint on the parent foreign key. Multiple rows per parent are the point: actions rerun, and historical results are preserved. The latest row by `createdAt` is the current state.

Unique constraints on **identity** tables are correct and expected — `messages.discordMessageId`, `channels.discordChannelId`, `members.discordUserId` are unique so ingestion can be idempotent through `.onConflict((oc) => oc.doNothing())`.

## No unnecessary defaults

Use `defaultTo(...)` only for `createdAt`. Any other default makes Kysely's generator emit `Generated<T>`, which turns the column optional on insert and silently loses the compile error that would have caught a missing value.

Instead of:
```typescript
.addColumn('source', 'text', (col) => col.defaultTo('reaction').notNull())
```

Do:
```typescript
.addColumn('source', 'text', (col) => col.notNull())
```

The first generates `source: Generated<string>` (optional on insert). The second generates `source: string` (required), forcing every insert site to state the value.

## Store full resource locators

When persisting a reference to something outside the store, keep every component needed to locate it again. A stored Discord message reference carries `discordGuildId`, `discordChannelId`, and `discordMessageId` — all three — so the permalink can be rebuilt without a join and without reading configuration that may have changed. The same rule applies to any external attachment reference: store the id *and* whatever container identifies where it lives.

## Self-contained migrations

Never import application code (`~/business/`, `~/framework/`, anything) in a migration. Migrations are frozen snapshots — they must produce the same result regardless of how the application evolves after they were written. Logic a migration needs is duplicated inside the migration file. The only allowed imports are `kysely` (with its `sql` helper) and Node built-ins.

Migrations evolve the schema and are bound by the doctrine's spirit: a backfill populates a new structure with `INSERT`s derived from existing rows; a migration never rewrites or erases recorded events. When an existing event table needs a new `not null` column, introduce a new event table for the extended concern instead of reshaping history.

## The dev seed builds demo state onto an empty database

`app/db/dev-seed/` is empty-database-only. `seed.ts` asserts the database is empty before any section runs, aborting unless every application table is empty (Kysely's migration bookkeeping is the only exemption). There is no idempotency machinery — no "already seeded" guards, no per-natural-key convergence. Each section assumes a blank database and only inserts. Run it with `pnpm run db:seed:dev`.

There is deliberately no reset script. Because the seed only builds onto an empty database, reseeding is a manual delete of the database file, then `pnpm run db:migrate` and `pnpm run db:seed:dev` — every run is a complete build from a known-clean slate, never a patch over existing rows.

`seed.ts` is a thin ordered orchestrator; each surface owns one file. A section's prerequisite lookup — the channel a message needs, the message a bookmark needs — throws naming the missing key rather than falling back to a default: a blank-database run has no earlier state to lean on, so a missing prerequisite is a seed-ordering bug to surface loudly.

Three rules keep a section demo-ready and durable:

- Compute every date relative to `now` in SQL (`strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 days')`), never a hardcoded calendar date, which rots.
- Prerequisite lookups key on natural keys (a Discord channel id, a channel name), never on insertion order. Bulk-seeded rows share timestamps, so `orderBy('createdAt')` is undefined; `orderBy('id')` does resolve, but only to the order the seed happened to write in, so the day a later section inserts earlier in the pipeline that lookup silently returns a different row.
- Sections drive real business functions, not raw inserts, so the seed exercises the same validation the product does.

The timestamp tie also decides read order. Sibling rows inserted in one transaction share that transaction's clock to the millisecond, so any derivation ordering them by `createdAt` falls through to its id tiebreak and reshuffles on every reseed — which flips digest output nondeterministically. When a seeded reading's row order matters, stagger the siblings' `createdAt` with small now-relative offsets; never change the product query's ordering to compensate.

A seed lookup that can match more than one row orders deterministically down to a unique tiebreaker — a natural key, or `createdAt` plus a final `id`. An unordered `executeTakeFirstOrThrow` reads whatever order the query plan returns and silently switches rows the day a later section inserts earlier in the pipeline.

## Performance: derive first, then escalate

Query-time derivation is the default and stays the default until a real query is measurably slow. When that happens, the sanctioned response is `EXPLAIN QUERY PLAN` plus indexes: composite `(parentId, createdAt desc)` indexes, partial indexes, and covering indexes serve every latest-wins and existence derivation. Add the index the plan asks for, and re-measure.

An index ships with proof it is *chosen*: `EXPLAIN QUERY PLAN` on the exact query it serves must show `SEARCH <table> USING INDEX <name>`, and dropping the index must degrade the plan (`SCAN`) — otherwise the index is decoration that taxes every insert. When the planner refuses, the query's shape is usually the reason — a window function over a whole child table forces the child to drive the join and demotes the parent's indexed filter to a residual — and the fix is reshaping the query so the filtered table drives (a correlated per-row lookup instead of a global window), never shipping the unused index anyway.

Never write a derived value back into the application schema from application code — a cache that lives in an app table is a mutable column with extra steps.
