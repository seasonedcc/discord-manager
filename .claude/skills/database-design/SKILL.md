---
name: database-design
description: Design SQLite tables and migrations under the project's zero-exception append-only, event-sourced doctrine. Use when creating tables, writing migrations, adding columns, modeling a state change, deriving current state, choosing between an identity and an event table, or writing the dev seed.
---

# Database Design

Everything here documents the repository as it is on `main`. If `main` disagrees with this file, `main` wins: follow it and flag the drift.

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
function latestBookmarkEventOf(messageId: Expression<string>) {
  const latestBookmarkEvents = db()
    .selectFrom('bookmarkAdditions')
    .select(['bookmarkAdditions.id', 'bookmarkAdditions.createdAt'])
    .where('bookmarkAdditions.messageId', '=', messageId)
    .unionAll(
      db()
        .selectFrom('bookmarkRemovals')
        .select(['bookmarkRemovals.id', 'bookmarkRemovals.createdAt'])
        .where('bookmarkRemovals.messageId', '=', messageId)
    )
    .orderBy('createdAt', 'desc')
    .orderBy('id', 'desc')
    .limit(1)

  return db()
    .selectFrom(latestBookmarkEvents.as('latestBookmarkEvents'))
    .select('latestBookmarkEvents.id')
}
```

A message is bookmarked while one of its additions is that latest event — the standing bookmark is the `bookmark_additions` row whose id equals `latestBookmarkEventOf(standingBookmarks.messageId)` — and no rows means never bookmarked. The pair is read with this one scalar subquery, each arm correlated to the parent, and the `union all` compound itself carries the `order by … limit 1`: SQLite then merges the two arms' index-ordered seeks and stops at the first row, so a same-millisecond tie still goes to the event recorded last and nothing is sorted. The same `order by` on a query wrapped around the union sorts every one of the parent's events. A pair whose value the reader wants carries it in both arms, `null` on the clearing side (`latestTopicOf` in `app/business/channels.server.ts`).

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

**Latest event wins** — a correlated lookup per parent, ordered `createdAt desc, id desc` and limited to 1, joined by id:

```typescript
function latestRevisionOf(eb: ExpressionBuilder<DB, 'messages'>) {
  return eb
    .selectFrom('messageRevisions')
    .select('messageRevisions.id')
    .whereRef('messageRevisions.messageId', '=', 'messages.id')
    .orderBy('messageRevisions.createdAt', 'desc')
    .orderBy('messageRevisions.id', 'desc')
    .limit(1)
}

db()
  .selectFrom('messages')
  .innerJoin('messageRevisions as latestRevisions', (join) =>
    join.on((eb) => eb('latestRevisions.id', '=', latestRevisionOf(eb)))
  )
```

`innerJoin` drops a parent with no event and `leftJoin` keeps it with null fields. Never rank a whole event table with `row_number()` and join the ranking: that is a pass over every event on every call, and SQLite drives the join from the ranking — a server-wide catch-up on a real store took minutes and froze every other tool call. A `row_number()` ranking is reserved for a standing set inside one parent, such as each reactor's latest reaction to one message, correlated to that parent so its cost is bounded by that parent's events. *Reading latest state* in `docs/architecture.md` is the reference for every shape and the plan it gets.

The `id desc` tie-break is mandatory: SQLite's `strftime` clock has millisecond resolution, so two events in one transaction can share a timestamp, and without the tie-break a repeated read can return different rows. Still avoid creating the tie — one observed action appends one event per parent per transaction.

**Newest instant** — a reader that needs only when a table's newest row happened asks for `max(createdAt)`: rows sharing that instant agree on it, so there is no tie-break to decide, and the table's `createdAt` index answers with one seek (`newestEventAt` in `app/business/ingestion-status.server.ts`).

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

**Indexes**: `(parentId, createdAt desc, id desc)` is the shape a latest-event lookup wants — the index delivers the tie-break too, so the lookup seeks without sorting — and `(parentId, createdAt desc)` serves an existence probe. Wanting the shape is not a reason to create the index. An index ships with the reader it serves and with the plan guard proving that reader chooses it (see *Performance: derive with lookups, prove the plan with a guard*). A table created before any query reads it ships with no index at all; the index arrives in the change that adds the query.

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

When such an attribute can be **cleared after being set**, one table cannot say so without a sentinel value, and a sentinel is a lie the schema will keep telling. Model it as a reversible pair instead: `channel_topic_changes` carries the value, `channel_topic_clearings` carries nothing, and the newer of the two latest rows wins — a change row means the attribute is present, a clearing row or no rows at all means it is absent. A reader looks the pair up as one scalar subquery (see *One-way events and paired toggles*), and both tables index on `(parentId, createdAt desc, id desc)` once that reader exists and its plan guard reaches both indexes.

A **set-valued attribute stamped per version of its parent** — the users a message pings, fixed by the vendor at each edit — attaches its zero-or-more rows to the *revision* row, not the parent: `message_revision_user_mentions` references `message_revisions`. The current set is simply the latest revision's rows, so "this version cleared the set" is zero rows under a new revision — no sentinel, no clearing table, and no latest-wins machinery beyond what the revisions already have. Keying such rows to the parent instead makes an emptied set indistinguishable from a set never observed. A unique constraint over `(revisionId, member)` is correct here — it states the set-membership fact and serves the reader's exact lookup.

## No `updatedAt` columns

Never add `updatedAt` to any table, and never add `editedAt`. The event row's `createdAt` *is* the timestamp of the change. In a schema where rows are never updated, an `updatedAt` column is meaningless.

## No derivable columns

Never store a column whose value can be inferred from event rows. Identity tables carry no `status`, no `archived`, no `isBookmarked`, no `current*` columns: all of it derives from events. A status that is always written alongside an event row is redundant and creates sync risk — the event row *is* the status.

## No unique constraints on event table FKs

Event tables never carry a unique constraint on the parent foreign key. Multiple rows per parent are the point: actions rerun, and historical results are preserved. The latest row by `createdAt` is the current state.

Unique constraints on **identity** tables are correct and expected — `messages.discordMessageId`, `channels.discordChannelId`, `members.discordUserId` are unique so ingestion can be idempotent through `.onConflict((oc) => oc.doNothing())`.

One child table is an exception, because it is not really an event table: the record of an optional fact that is fixed at the parent's birth and can never change. The message a reply answers is the example — Discord stamps it when the reply is posted, no later edit can move it, and a non-reply simply never has one. `message_reply_references` records it as a zero-or-one-row child of `messages`, written in the same transaction that creates the message and never written again.

Nothing ever happens to such a fact after birth, so there is no history to keep and nothing for latest-wins to resolve: a second row for the same message could only be the same fact recorded twice by mistake. That is why a unique constraint on the parent foreign key is correct there — it states that a message answers at most one message, and it guarantees the at-most-one-row assumption every reader relies on when it looks the reference up with a subquery.

Qualify for this exception strictly: the fact must be unchangeable because Discord fixed it, not because our code happens to write it only once today. If any future event could legitimately change the value, it is an ordinary event table and this rule applies to it in full.

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

A catalog the product advertises — the default bookmark reasons are one — is delivered by migration, and every addition to it ships as a new append-only backfill migration in the same PR. Editing the original migration, or adding the entry only to the dev seed, looks perfect in every gate — unit, E2E, and the seed smoke all migrate from an empty database — and reaches zero existing stores. In a self-hosted product every user's store is production.

## The dev seed builds demo state onto an empty database

`app/db/dev-seed/` is empty-database-only. `seed.ts` asserts the database is empty before any section runs, aborting unless every application table is empty (Kysely's migration bookkeeping is the only exemption). There is no idempotency machinery — no "already seeded" guards, no per-natural-key convergence. Each section assumes a blank database and only inserts. Run it with `pnpm run db:seed:dev`. CI runs it too, against a freshly migrated scratch database, so a section that no longer works fails the build rather than the next self-hoster.

There is deliberately no reset script. Because the seed only builds onto an empty database, reseeding is a manual delete of the database file, then `pnpm run db:migrate` and `pnpm run db:seed:dev` — every run is a complete build from a known-clean slate, never a patch over existing rows.

`seed.ts` is a thin ordered orchestrator; each surface owns one file. A section's prerequisite lookup — the channel a message needs, the message a bookmark needs — throws naming the missing key rather than falling back to a default: a blank-database run has no earlier state to lean on, so a missing prerequisite is a seed-ordering bug to surface loudly.

Three rules keep a section demo-ready and durable:

- Compute every date relative to `now` in SQL (`strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 days')`), never a hardcoded calendar date, which rots.
- Prerequisite lookups key on natural keys (a Discord channel id, a channel name), never on insertion order. Bulk-seeded rows share timestamps, so `orderBy('createdAt')` is undefined; `orderBy('id')` does resolve, but only to the order the seed happened to write in, so the day a later section inserts earlier in the pipeline that lookup silently returns a different row.
- Sections drive real business functions, not raw inserts, so the seed exercises the same validation the product does — and because `applySchema` accepts `unknown`, that validation is runtime only. Tie every payload to its schema (`satisfies z.input<typeof recordIncomingMessageSchema>`, or a type alias derived from it) so a shape change breaks the build instead of the self-hoster's first `db:seed:dev`.

The timestamp tie also decides read order. Sibling rows inserted in one transaction share that transaction's clock to the millisecond, so any derivation ordering them by `createdAt` falls through to its id tiebreak and reshuffles on every reseed — which flips digest output nondeterministically. When a seeded reading's row order matters, stagger the siblings' `createdAt` with small now-relative offsets; never change the product query's ordering to compensate.

A seed lookup that can match more than one row orders deterministically down to a unique tiebreaker — a natural key, or `createdAt` plus a final `id`. An unordered `executeTakeFirstOrThrow` reads whatever order the query plan returns and silently switches rows the day a later section inserts earlier in the pipeline.

## Performance: derive with lookups, prove the plan with a guard

Query-time derivation is the default, written as the per-row lookups above from the start. Every reader that derives latest state is held by a plan guard (load `testing`) that proves, without timing anything, that its lookups seek through their indexes, sort nothing, and read no table whole beyond the rows the reader walks.

An index ships with proof it is *chosen*: the guard names the index's `SEARCH <table> USING INDEX <name>` step, so dropping the index fails it — otherwise the index is decoration that taxes every insert. When the planner refuses, the query's shape is the reason, and the fix is reshaping it so the rows the reader walks drive the query, never shipping the unused index anyway.

Guild scope is part of that shape. A reader that walks a window of messages, the standing bookmarks, or a lookup's own table scopes the guild with a correlated `exists` against the row's channel, or a scalar subquery on the unique key of `guilds`, never a constant filter on a joined `guilds`: that join lets the planner start from the one guild row and sort everything it reaches before the limit applies.

Never write a derived value back into the application schema from application code — a cache that lives in an app table is a mutable column with extra steps.
