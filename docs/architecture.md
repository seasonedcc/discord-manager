# Discord Manager — architecture

Discord Manager is a headless, self-hosted product: each person on the team runs their own
Discord bot and their own local stack. The MCP server is the entire user surface — you use
the product by talking to an AI assistant connected to it. There is no web UI.

Every deployment is single-owner: one bot token, one configured owner (a Discord user id),
one guild, one local SQLite database. Teammates each clone this repo and provision their own
Discord app, so nothing is shared between deployments.

## What it does

- **Ingests** the company server's messages through the bot's gateway connection into a
  local append-only event store, with a REST backfill for history and gap recovery.
- **Bookmarks without Nitro**: when the owner reacts to any message with 🔖, the bot records
  a bookmark event. Removing the reaction removes the bookmark. Bookmarks can also be added,
  resolved, and snoozed through MCP tools.
- **Serves the owner's AI** over MCP: catch-up digests since a timestamp, mention triage,
  bookmark management, channel listing, ingestion health, and draft-and-send (posting as the
  owner's bot).

## Runtime topology

Two processes share one SQLite database file (WAL mode makes this safe):

- `pnpm run ingest` — the long-running daemon: a discord.js gateway client that writes
  message, reaction, and metadata events, plus the in-process work queue that runs the
  startup backfill, the gap sweeps triggered on connect and resume, and the liveness
  heartbeat cron.
- The MCP server — a stdio process the owner's AI client spawns per session (wired via
  `.mcp.json`). It only reads the store and calls Discord's REST API for sends.

Both processes are thin shells over `app/business/` functions.

## Stack

Node ^22, pnpm 10, TypeScript ESM (strict, no `any`, inference-first), Biome (single
quotes, semicolons as needed, trailing commas es5), Kysely + better-sqlite3 with
`CamelCasePlugin` (snake_case on disk, camelCase in code), kysely-codegen for `app/db/types.d.ts`,
discord.js v14, `composable-functions` + Zod for the business layer,
`@modelcontextprotocol/sdk` for the MCP server, Vitest for unit tests, and MCP-driven
end-to-end specs (see Testing).

## Folder layout

```
app/
  framework/        Zero app-specific logic; extractable as a package at any time.
    db.server.ts        makeDb, newId, migrator, createDbMigration, migrateDbToLatest/Down
    db-backup.server.ts append-stable text dump of any SQLite store + verifying restore
    env.server.ts       framework-only typed env (make-typed-env + camelKeys)
    scheduler.server.ts makeJob, makeCronJob, makeSchedulerRunner (in-process; no queue)
    globals.ts          getOrSetGlobal (HMR/test-safe singletons)
  business/         The product. Domain-named files, no cross-imports, one export block.
    auth.server.ts             owner context: env + db -> ownerContext; ownerContextSchema
    channels.server.ts         channel listing from its detail and attribute events
    ingestion.server.ts        message/reaction/member event recording; backfill; heartbeat
    ingestion-status.server.ts gateway activity + backfill health derivations
    digests.server.ts          catch-up + mention triage derivations
    messages.common.ts         observed embed/attachment shapes + canonical embed rendering
    messages.server.ts         one message read live from Discord, with its telemetry
    bookmarks.server.ts        add/remove/resolve/snooze + list derivation
    sending.server.ts          draft-and-send with its telemetry family
    jobs.server.ts             registered jobs array
    *.common.ts                schemas, copy maps, named constants per domain
  db/
    migrations/         timestamped, prose-named, self-contained
    scripts/            migration.ts, migrate.ts, rollback.ts, generate.ts,
                        export.ts, import.ts
    db.server.ts        the product's Kysely instance (makeDb<DB>())
    types.d.ts          generated — never hand-edited
    dev-seed/           local seed, refused unless the ids are digits and the store is empty
  env.server.ts     the product's typed env, plus the startup guard both entrypoints call
  mcp/
    tool.ts             McpTool shape
    server.server.ts    stdio server: listTools/callTool, JSON-schema projection
    registry.server.ts  accumulate-only tool array
    run.ts              stdio entrypoint
    tools/<domain>.server.ts
    parity.test.ts      every business capability wrapped xor exempt, with reasons
    parity-exemptions.ts
  ingest/
    gateway.server.ts   discord.js client wiring gateway events -> business functions
    run.ts              daemon entrypoint
  test/
    prelude.ts          describe/expect/it/vi + db
    global-setup.ts     throwaway unit database: create, migrate, guard
    fixtures.ts         createGuild/createChannel/createMessage/ownerContext factories
tests/
  *.spec.ts             behavior-sentence specs driving the real MCP server over stdio
  spec.ts               the one-test-per-file registrar
  run-e2e.ts            fresh store, seed, run every spec, then the coverage gate
  mcp-client.ts         stdio client harness + the local Discord double
  discord-ids.ts        run-unique Discord snowflakes for seeds and specs
  coverage/gate.ts      every registered MCP tool must be exercised by the suite
  coverage/pending.ts   tools no spec reaches yet; the list only ever shrinks
  coverage/exclusions.ts  tools excluded with a written rationale
  seed/                 per-run fresh-store E2E seed built from a fake gateway feed
```

## Database doctrine

The bettr-manager append-only doctrine applies unchanged: `INSERT` is the only write,
identity tables + event tables are the only two kinds, no nullable columns, no `updatedAt`,
no derived/status columns, deletion is an event, state is computed at query time.

SQLite adaptations (the only sanctioned divergences, mirrored in CLAUDE.md):

- **ids** are monotonic UUIDv7 values from `newId()` in application code — SQLite has no
  `gen_random_uuid()`, and a random id would make the `id desc` tie-break a coin flip
  whenever two events share a millisecond. Insert helpers own this; migrations declare
  `text` primary keys. The guarantee is per process: two processes appending to one
  reversible pair inside the same millisecond stay unordered, which is accepted rather
  than fixed — there is no cross-process ordering machinery.
- **Timestamps** are ISO-8601 UTC `text` columns: `createdAt` defaults to
  `strftime('%Y-%m-%dT%H:%M:%fZ','now')`. Lexicographic order equals chronological order.
- **Latest-event-wins** uses a window function instead of `distinct on`:
  `row_number() over (partition by parentId order by createdAt desc, id desc)` filtered to 1.
  The `id desc` tie-break stays mandatory.
- **Booleans** are `integer` 0/1 at the schema level; Zod coerces at the boundary.
- Single-writer WAL replaces Postgres advisory locks; the ingest daemon is the only
  gateway writer and MCP writes are transactional, so no cross-process ordering machinery.

### Schema (initial)

Identity: `guilds` (discordGuildId unique), `channels` (guildId FK, discordChannelId
unique), `members` (discordUserId unique), `messages` (channelId FK, authorMemberId FK,
discordMessageId unique, discordCreatedAt).

Events, each indexed by its parent — `(parentId, createdAt desc)` wherever latest-event-wins
reads them, and a unique key on the parent plus what tells its rows apart where a parent's
rows are one set read whole (`message_revision_user_mentions`, `message_revision_embeds`,
`message_revision_attachments`):

- `channel_detail_revisions` — full snapshot of what every channel always has: name and
  isThread.
- `channel_topic_changes` / `channel_topic_clearings`, `channel_category_changes` /
  `channel_category_clearings`, `channel_position_changes` / `channel_position_clearings`
  — the optional attributes, each a reversible pair: the newer of the two latest rows
  wins, and no rows at all means the channel never had one. A thread simply never gets a
  position row.
- `channel_archivings` / `channel_unarchivings` — reversible pair; the newer of the two
  latest rows says whether Discord currently has the thread archived, and no rows at all
  means it never was. Only threads ever get rows.
- `channel_removals` — existence is state (channel deleted/hidden from the bot).
- `member_detail_revisions` — username, displayName.
- `message_revisions` — full content snapshot; the first revision lands with ingestion,
  one more per observed edit. Never an `editedAt` column.
- `message_revision_user_mentions` — zero or more rows per revision, one per user
  Discord's own `mentions` array says that revision pinged. The set belongs to the
  revision rather than the message because an edit can change it, so the current set is
  the rows of the latest revision — an edit that drops the ping leaves the new revision
  with no rows at all, which is a fact one table can state without a sentinel.
- `message_revision_embeds` — zero or more rows per revision, one per embed Discord
  attached to that version of the message, each carrying `position` (its place in the
  message) and `content` (the embed rendered to the text a person would read). Rendering
  happens once, at capture, so every reader shows the same words; the structured embed
  is not kept, and neither is any part the text does not carry. Embeds the message flags
  as suppressed are never recorded, because Discord does not show them either.
- `message_revision_attachments` — zero or more rows per revision, one per file, each
  carrying `position`, `filename`, `size` in bytes, and the Discord `url`. Reference
  only: no bytes are ever downloaded, and the URL is signed and short-lived, so it names
  a file rather than links to one forever. `contentType` is deliberately not stored — it
  is optional upstream and adds nothing a text-triage reader uses.
- `message_deletions` — existence is state.
- `bookmark_additions` / `bookmark_removals` — reversible pair; newest of the two latest
  wins. Both carry `source` (`reaction` or `mcp`) so a public un-react and a private MCP
  resolve stay distinguishable facts.
- `bookmark_snoozes` — until timestamp; latest wins; a snoozed bookmark leaves the default
  list until `until` passes.
- `bookmark_reasons` — identity: which reason exists. `bookmark_reason_detail_revisions`
  snapshots its name and description together; latest wins.
  `bookmark_reason_retirements` is one-way — a row means the reason takes nothing new.
  `bookmark_reason_assignments` carries `messageId` + `reasonId`; latest wins.

### Bookmark reasons

Every bookmark is filed under a reason, and the reason is **derived, never stored on the
bookmark**: the newest `bookmark_reason_assignments` row for the message wins, and a
bookmark with no assignment rows at all reads as the shipped **Inbox** reason. That
fallback is the whole design. A 🔖 reaction physically cannot carry intent, so the
reaction recorder appends nothing but its `bookmark_additions` row and the capture reads
as Inbox honestly — no intent is invented for it, and bookmarks that predate the feature
stay valid. The derivation is a `coalesce` against the Inbox id inside the bookmark
readers, so listing bookmarks stays one query.

A reason's displayed name and description always come from its latest detail revision,
including once it is retired, so a bookmark never loses its label when the owner stops
using that reason. Retirement only closes the reason to *new* assignments.

The six defaults (*Answer later*, *To-do*, *Follow up*, *Read later*, *Reference*,
*Inbox*) are seeded by the migration that creates the tables, under fixed literal ids
every deployment shares. Seeding there is deliberate: it runs exactly once per store, so a
default the owner later retires or rewords stays retired or reworded — there is no
re-ensure logic anywhere, and nothing reintroduces a reason the owner removed. Inbox is
the one reason the product keeps for itself: `bookmarks.common.ts` exports its id as a
named constant (pinned by a test against a freshly migrated store), and both editing and
retiring it are refused, because it has to stay a valid landing place for every capture.
Assigning Inbox is allowed — sending a bookmark back to be sorted again is legitimate.

### Telemetry families (integration-telemetry doctrine)

Every Discord API operation family gets its own request + outcome tables and its own
skip-reason enum; no shared framework, no shared enums:

- `message_send_requests` / `...reply_targets` / `...retries` / `...deliveries` /
  `...failures` (with a `kind` of `rejected` or `unreachable`) / `...skips` — MCP sends.
- `backfill_runs` / `backfill_run_progress` / `...completions` / `...failures` — REST
  history backfills. Each channel's newest run gives a state, and the reading rolls those
  states up worst-first into counts, the names of the channels whose newest run failed,
  and how many channels no run has ever visited.
- `gateway_connections` / `gateway_heartbeats` / `gateway_disconnections` — activity
  derivation reads `receiving | quiet | never` from the newest sign of life against a
  named silence-threshold constant, so a daemon that died without disconnecting goes
  quiet instead of reading live forever.
- `message_fetch_requests` / `message_fetch_retrievals` / `message_fetch_failures` (with a
  `kind` of `gone`, `rejected` or `unreachable`) / `message_fetch_skips` (with a `reason`
  of `message_deleted`) — `messages_fetch` reading one message live. The family carries no
  silence window and no status reader: the operation is a single synchronous REST call
  that returns its outcome inline, so no reading exists that a pending row could mislead.
  `gone` is keyed on Discord's own `Unknown Message` code rather than on the 404 status,
  because a bare 404 also covers a channel the bot can no longer see — a cause "it was
  deleted there" would be a conclusion, not an observation.

Owner-facing status is always mapped copy from exhaustive typed maps in `.common.ts`
(summary + nextAction per reason), never raw vendor text — pinned by serialization tests.

### Guarded send retries

A second attempt at a send is a new `message_send_requests` row plus one
`message_send_request_retries` row linking it to the request it retries, so the attempts at
one message form a chain the store can read in both directions. Nothing about a request is
ever mutated; the chain is derived from those link rows.

One predicate in `sending.server.ts` decides whether a request may be retried, and the
status reader and the send both call it — the reader returns it as `canRetry`, the send
re-evaluates it and throws an `InputError` naming where the attempt stands. They cannot
disagree, and a unit test asserts that property across every status. When a later attempt
is what blocks a retry, the status reading's next action becomes that refusal, so the
reading never points at a path the send would reject.

The predicate answers two questions, both of which must pass. First, did the attempt
provably never reach the channel? Only a skip and a Discord-refused failure prove that;
delivered, pending, stalled and a Discord we could not reach all leave the outcome unknown,
and retrying an unknown outcome is how a message gets posted twice. Second, could another
attempt do anything different? A skip qualifies only when the condition that caused it can
change — empty text can be written, a channel the bot lost can never come back, because
`channel_removals` is one-way. The same live-risk test walks the chain: a linked retry that
might itself be live blocks any further attempt, while one that provably never posted
leaves the chain open.

The predicate runs inside the transaction that writes the new request and its link row, so
two racing retries of one request cannot both pass. That transaction writes before it reads
so it holds SQLite's write lock from its first statement — a read-first transaction takes a
snapshot and its later writes fail outright when the ingest daemon commits in between.

### Backing the store up as text

`pnpm run db:export` and `pnpm run db:import` — thin entrypoints in `app/db/scripts/` over
`app/framework/db-backup.server.ts` — turn the binary store into a text dump a deployment
can commit to a git host, and back again. The framework module is app-agnostic: it
discovers everything by introspection and hardcodes no table name.

- **One snapshot, never a write.** The export opens the store read-only (`fileMustExist`)
  and runs inside a single `BEGIN`/`COMMIT` read transaction, so a dump taken while the
  ingest daemon writes is transactionally consistent, and the export is incapable of
  writing to a live store.
- **Introspected shape.** `schema.sql` carries every `sqlite_master` statement — tables
  before indexes, then by name, so an index never precedes the table it needs — including
  Kysely's `kysely_migration` bookkeeping, so a restored store knows which migrations it
  already has. Every non-internal table is dumped with its rows ordered by its real primary
  key, read from `PRAGMA table_info`. For an application table that key is the UUIDv7 id,
  so primary-key order *is* append order.
- **An owned serialization format.** One line per row, `INSERT INTO <table> VALUES(...);`,
  in SQLite's own literal forms: text single-quoted with quotes doubled and newlines left
  literal, `NULL`, integers as plain decimals (read as BigInts, so an id beyond 2^53 would
  survive), reals in their shortest round-trip form, blobs as `X'hex'`.
- **16 MiB append-stable chunks.** Rows stream into `<dump>/<table>/000000.sql`,
  `000001.sql`, …, and a chunk closes as soon as it reaches `appendStableChunkByteCap`
  (16 MiB), always after at least one row. Every boundary is a pure function of the
  row-stream prefix, so on an append-only store every chunk but each table's last is
  byte-identical between exports: git stores only the events that were appended, and no
  file approaches a host's 100 MB ceiling. The cap and the format are frozen — changing
  either rewrites every deployment's dump history — and unit tests pin both.
- **A manifest that states the truth.** `manifest.json` carries `{"rows": {…}}` — every table
  the export saw mapped to the exact number of rows it wrote, keys sorted, counted from the
  same streamed rows inside the same read transaction as the chunks, so an empty table is a
  `0` rather than an absence. It is what makes a restore verifiable instead of merely
  plausible: without it, a dump missing a leaf table's last chunk passes both pragmas.
- **Owned-artifact replacement.** The dump is written to a sibling temporary directory and
  swapped in one artifact at a time. An export removes only what an export wrote:
  `schema.sql`, `manifest.json`, and any direct subdirectory whose entries are all
  `NNNNNN.sql` chunk files. Every other entry in the destination — a `.git` directory, a
  notes file, an empty folder — survives untouched, so the dump directory can be a git
  repository of its own. The swap is ordered as a fail-safe: the old `schema.sql` goes
  first, the new chunk directories move in next, and `manifest.json` and `schema.sql` land
  last, so a crash mid-swap leaves a dump the import refuses rather than a plausible wrong
  one. An empty table gets no directory at all. A non-empty destination carrying no
  `schema.sql` is still refused outright — with nothing of its own to recognise there, an
  export pointed at `./data` must not take the store with it.
- **A verifying restore.** The import only ever writes a fresh file — it refuses an existing
  `DATABASE_PATH` — and refuses a dump carrying no `schema.sql` or no `manifest.json`. It
  applies the schema and every chunk the manifest's tables name in one transaction with
  `foreign_keys=OFF`, since table-by-table order is not dependency order. Any failure before
  the commit — an unrunnable `schema.sql`, a truncated chunk — is reported as mapped copy and
  takes the file that run had just created with it, so the wreckage of one attempt cannot
  block the next. After the commit it verifies before it claims success: `PRAGMA
  integrity_check` must answer `ok`, `PRAGMA foreign_key_check` must come back empty, and
  every restored row count must equal the manifest's, table set included. A failure there
  exits non-zero naming the first table that diverges with what it should carry and what it
  carries, and leaves the file for inspection.

## Authorization

The three-layer architecture survives with a collapsed top: the owner is configured, not
authenticated. `ownerContext()` builds context from env (owner user id, guild id) plus the
store — never the bot token, which only the transports read when they call Discord — and
`ownerContextSchema` still carries `z.literal(true)` capability flags
(`canReadMessages`, `canManageBookmarks`, `canSendMessages`) so every business function
validates context exactly as in bettr-manager and the gates stay testable. The MCP layer
contains zero authorization — tools call business functions with the real context.

## MCP tools (v1)

`channels_list`, `activity_since` (since), `messages_catch_up` (since + optional
channel), `mentions_list`, `bookmarks_list` (optional limit, snoozed, reason filter),
`bookmarks_add` (by message link + reason), `bookmarks_resolve`, `bookmarks_snooze`,
`bookmarks_set_reason`, `bookmark_reasons_list`, `bookmark_reasons_add`,
`bookmark_reasons_edit`, `bookmark_reasons_retire`, `messages_fetch` (by stored message
id), `messages_send` (channel, content, optional reply, optional retry of an earlier
request), `messages_send_status` (by request id), `ingestion_status`.

Names are `<domain>_<verb_phrase>`, descriptions outcome-oriented, input schemas reuse the
business functions' own exported schemas, dates cross the boundary as ISO strings. The
parity test keeps the tool surface equal to the business surface.

## Ingestion design

Gateway intents: Guilds, GuildMessages, MessageContent, GuildMessageReactions (with
partials for reactions on uncached messages). Handlers translate events to business calls:

- messageCreate → record message (+ first revision, member revision as needed)
- messageUpdate → record revision (full snapshot)
- messageDelete → record deletion
- messageReactionAdd/Remove with 🔖 **by the configured owner only** → bookmark event
- channel/thread create/update/delete → channel revisions/removals, plus the archiving or
  unarchiving event when a thread's archived state changed

Startup runs a backfill per readable channel from the newest stored message forward, as a
`backfill_runs` telemetry family with progress rows. A fresh identify (`shardReady`) and a
resume (`shardResume`) both re-run the gap sweep; the sweep asks the scheduler to keep only
one waiting copy of itself, so a reconnect storm queues one sweep rather than ten.

### Archived threads and the one-final-sweep rule

Discord archives a thread after inactivity and revives it the moment anyone posts. Removal
is terminal and stays terminal, so an archived thread is still a channel the store knows —
and without a second signal every reconnect would pay a REST backfill for every thread the
bot ever saw. `channel_archivings` / `channel_unarchivings` carry that signal:

- `recordChannelArchiving` and `recordChannelUnarchiving` append only on a transition,
  driven by the `threadUpdate` / `threadCreate` snapshots the gateway observes live.
- `reconcileThreadArchivings` covers the daemon's downtime. Every reconnect fetches the
  guild's currently-active threads (`guild.channels.fetchActiveThreads()`, read fresh —
  the channel cache does not reflect archived state) and reconciles: known non-removed
  threads missing from that list are archived, archived threads back on it are unarchived.
  It runs before the sweep is enqueued. A failed fetch degrades to the old behavior — the
  connection is still recorded, the sweep still runs, and nothing is marked archived.
- `listBackfillableChannels` skips a channel only when its latest archived-pair event is an
  archiving **and** a `backfill_runs` row for that channel is newer than that archiving.

That last rule is what keeps the change lossless. A thread that archives — whether observed
live or discovered by reconciliation after downtime — is swept exactly once more, which is
what collects the messages posted just before it went quiet, and drops out of every later
sweep. A revived thread re-enters the sweep and its gap is filled. A thread that was never
archived is always swept. At a millisecond tie the thread is swept again, which costs one
REST call and loses nothing.

### Mentions mean what Discord means

Discord stamps every message payload — gateway and REST alike — with the `mentions` array
of users that message pinged. That array is richer than any text match: it carries the
author of a replied-to message when the sender left the reply ping on, and leaves them out
when the sender switched it off, a distinction `<@id>` text matching cannot see at all.

- Ingestion passes the array through as plain data (`mentionedDiscordUserIds`), so the
  business layer stays discord.js-free. The gateway reads `message.mentions.users` on
  `messageCreate` and `messageUpdate`; the REST backfill reads the same collection off the
  fetched messages and threads it through `fetchChannelHistory`'s page shape.
- The recorder writes the mention rows in the same transaction as the revision they belong
  to, so a message and its mention set are never briefly out of step.
- `listMentions` returns the union of two conditions: a mention row on the message's latest
  revision naming the owner, or the latest revision's text carrying `<@id>`/`<@!id>`. The
  second half is what keeps messages ingested before mention rows existed findable; a
  single OR over one query means a message matching both ways still comes back once.
- Role mentions and `@everyone`/`@here` are deliberately excluded. No role tracking exists,
  and a broadcast ping is not personal triage. `mentions_list`'s description says so.

### What a message says outside its text

An alerting bot posts an embed and no text at all, so a reader that shows only `content`
reports an empty line where the incident is. Embeds and attachments are captured the same
way mentions are: read off the Discord payload at the seam, passed to the business layer as
plain data, and written in the same transaction as the revision they belong to.

- The seam translates discord.js into observations (`observeEmbeds`, `observeAttachments`
  in `app/ingest/gateway.server.ts`), shared by the live gateway handlers and the REST
  backfill, so history and live traffic record the same facts.
- Embeds cross into the business layer **structured** and are rendered once, on the way in,
  by `renderEmbed` in `app/business/messages.common.ts` — author, title with its link,
  description, each field as `name: value`, image, thumbnail, footer, timestamp, empty
  parts skipped. One rendering at capture means every reader and every future live fetch
  agrees on the words, and `messages.common.ts` is where a message-fetching domain finds
  it without importing ingestion.
- The readers (`digestMessagesSince`, `listBookmarks`) aggregate both sets in SQL —
  `json_group_array` over a correlated subquery keyed on the ranked revision's id — so a
  digest stays one query and shows only the current version's embeds, never a pre-edit one.
- Nothing is fetched: an attachment is a filename, a size and Discord's own signed URL,
  which expires in about a day. The store names files; it does not archive them.
- Capture is forward-only. The backfill cursor never revisits a message it already has, so
  messages ingested before this existed keep only their text. The README says so plainly
  rather than implying a rescan that does not exist.

### The live escape hatch

Three things the store cannot answer make `messages_fetch` necessary: an attachment URL
Discord signed a day ago no longer opens, history ingested before embed capture carries
none, and reaction facts only accumulate from the moment the daemon started watching.
`fetchMessage` in `messages.server.ts` answers them by reading that one message from
Discord's REST API — and its tool description and the README both steer routine reading
back to `messages_catch_up`, `mentions_list` and `bookmarks_list`, which answer from the
store without touching the network.

- It is a transport-injected factory, exactly like `sendMessage`: the MCP tool file owns
  the REST client and translates `DiscordAPIError` into the domain's own error types, so
  the business layer stays vendor-free. The transport is duplicated rather than shared
  with sending — two small lazy clients beat one premature abstraction.
- It writes no message *content*. The ingest daemon stays the only writer of messages,
  revisions, embeds and attachments, so a live read can never rewrite recorded history or
  resurrect content Discord deleted.
- The one message event a fetch does append is a **deletion**. When Discord answers
  `Unknown Message` for a message the store holds, the fetch has observed the same fact the
  gateway's `MESSAGE_DELETE` carries, so the transaction that records the `gone` failure
  also appends a `message_deletions` row unless one already stands. It is an observation,
  not an inference, and it is what makes the `gone` next action true: readers exclude
  deleted messages, so the message really does stop coming back. A duplicate raced in by the
  daemon would be harmless anyway — existence is state — but the not-exists guard keeps the
  history honest about how many deletions were observed.
- A message the store already records as deleted is a **skip**, not a call: the store
  knows the answer, so asking Discord would burn a request to learn it, and skipping keeps
  deleted content out of sight the way the rest of the product does. A gone fetch therefore
  answers `gone` once and `skipped` every time after.
- Embeds come back structured and go through the same `renderEmbed`, so the live wording
  and the stored wording are the same projection. Empty renders drop out on both paths.
  Embeds the poster suppressed are dropped, the way Discord itself stops showing them.
- `ownerReacted` is derived, never read off the payload. Discord's `me` flag on a reaction
  means *the bot*, which is not the owner, so the transport walks
  `GET .../reactions/{emoji}` page by page (100 at a time, `after` until short) and the
  business layer asks whether the owner's Discord user id is among the reactors. A
  reaction's `count` includes super reactions while that walk lists normal ones, so a
  reaction with any burst count is walked a second time with `type=1` — otherwise an owner
  who only super-reacted would read as not having reacted at all.
- Custom emoji are keyed the way Discord's own route wants them — `name:id`, `a:name:id`
  when animated — and unicode emoji stay the glyph. A custom emoji deleted from the server
  comes back nameless; the route resolves it by id alone, so the walk sends a stand-in name
  while the owner-facing emoji stays `:id`, never the string `null:id`.
- The reactor walk is isolated from the read. A reaction listing Discord refuses cannot
  void a message it already handed over: the fetch still records a retrieval and answers
  `retrieved`, with `reactions` absent. Absent means *Discord would not say*; an empty array
  means *no reaction stands* — two different answers that must not collapse into one.

## Scheduling

`app/framework/scheduler.server.ts` is an in-process work queue, not a job server: one
pending array drained one task at a time, retries with exponential backoff up to a per-job
attempt cap, and `setInterval` timers for cron jobs. Nothing is persisted — a daemon
restart starts from an empty queue, which is why every job is safe to re-run from scratch.
`app/business/jobs.server.ts` lists the registered jobs and the daemon is the only process
that starts the runner.

## Testing

- **Unit**: Vitest against a real throwaway SQLite database (created + migrated in global
  setup, `_unit` suffix guard). Real queries, no mocks. Colocated `*.test.ts`, one
  `describe` per public function, fixtures with `crypto.randomUUID()` entropy,
  `fromSuccess` for happy paths, specific error assertions.
- **End-to-end**: specs named as behavior sentences (`a-bookmarked-message-survives-the-
  authors-edit.spec.ts`), one test per file. `tests/run-e2e.ts` deletes the E2E database
  file, migrates it, seeds it **once per run** through the real ingestion business
  functions (a scripted fake gateway feed — no network), then runs every spec against that
  one store and finishes with the coverage gate. Each spec spawns the real MCP server over
  stdio and drives it with the real MCP SDK client. Discord REST calls are not mocked: the
  harness starts a local HTTP double on `127.0.0.1` and spawns the server with
  `DISCORD_API_BASE_URL` pointing at it, so the real `discord.js` REST client makes a real
  request the spec can assert on — or the double refuses it with a 403 to exercise the
  failure copy.
- **Coverage gate**: the E2E runner fails if any registered MCP tool was never called by
  the suite, with the same pending/exemption discipline as bettr's route gate.
- **TDD for bugs**: red, green, refactor. Mutation-prove any test whose absence assertion
  could false-pass.

## Definition of Done (headless adaptation)

A task is not done unless: lint + tsc + test:unit pass; any added or changed capability
extends the MCP server in the same PR (parity-gated); any user-visible behavior change has
an E2E spec and every MCP tool reaches the coverage gate; the README/setup docs stay
truthful to the shipped behavior; no leftover comments; a code-review audit loop has run
until the orchestrator is satisfied; the work is exercised end to end through a real MCP
client session; and a self-improvement pass closes the task.
