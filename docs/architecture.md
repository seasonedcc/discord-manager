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
    env.server.ts       framework-only typed env (make-typed-env + camelKeys)
    scheduler.server.ts makeJob, makeCronJob, makeSchedulerRunner (in-process; no queue)
    globals.ts          getOrSetGlobal (HMR/test-safe singletons)
  business/         The product. Domain-named files, no cross-imports, one export block.
    auth.server.ts             owner context: env + db -> ownerContext; ownerContextSchema
    channels.server.ts         channel listing from its detail and attribute events
    ingestion.server.ts        message/reaction/member event recording; backfill; heartbeat
    ingestion-status.server.ts gateway activity + backfill health derivations
    digests.server.ts          catch-up + mention triage derivations
    bookmarks.server.ts        add/remove/resolve/snooze + list derivation
    sending.server.ts          draft-and-send with its telemetry family
    jobs.server.ts             registered jobs array
    *.common.ts                schemas, copy maps, named constants per domain
  db/
    migrations/         timestamped, prose-named, self-contained
    scripts/            migration.ts, migrate.ts, rollback.ts, generate.ts
    db.server.ts        the product's Kysely instance (makeDb<DB>())
    types.d.ts          generated — never hand-edited
    dev-seed/           empty-database-only seed for local development
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

Events (all with `(parentId, createdAt desc)` indexes):

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
- `message_deletions` — existence is state.
- `bookmark_additions` / `bookmark_removals` — reversible pair; newest of the two latest
  wins. Both carry `source` (`reaction` or `mcp`) so a public un-react and a private MCP
  resolve stay distinguishable facts.
- `bookmark_snoozes` — until timestamp; latest wins; a snoozed bookmark leaves the default
  list until `until` passes.

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

## Authorization

The three-layer architecture survives with a collapsed top: the owner is configured, not
authenticated. `ownerContext()` builds context from env (owner user id, guild id) plus the
store — never the bot token, which only the transports read when they call Discord — and
`ownerContextSchema` still carries `z.literal(true)` capability flags
(`canReadMessages`, `canManageBookmarks`, `canSendMessages`) so every business function
validates context exactly as in bettr-manager and the gates stay testable. The MCP layer
contains zero authorization — tools call business functions with the real context.

## MCP tools (v1)

`channels_list`, `messages_catch_up` (since + optional channel), `mentions_list`,
`bookmarks_list` (optional limit), `bookmarks_add` (by message link), `bookmarks_resolve`,
`bookmarks_snooze`, `messages_send` (channel, content, optional reply, optional retry of an
earlier request), `messages_send_status` (by request id), `ingestion_status`.

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
