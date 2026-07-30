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
  message, reaction, and metadata events, plus the in-process scheduler for periodic work
  (startup backfill, gap sweeps).
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
    db.server.ts        makeDb, migrator, createDbMigration, migrateDbToLatest/Down
    env.server.ts       framework-only typed env (make-typed-env + camelKeys)
    scheduler.server.ts makeJob, makeCronJob, makeSchedulerRunner (in-process; no queue)
    globals.ts          getOrSetGlobal (HMR/test-safe singletons)
    helpers.ts          pure helpers only as needed
  business/         The product. Domain-named files, no cross-imports, one export block.
    auth.server.ts      owner context: env + db -> ownerContext; ownerContextSchema
    channels.server.ts  channel listing + metadata revisions
    ingestion.server.ts message/reaction/member event recording; backfill; telemetry
    digests.server.ts   catch-up + mention triage derivations
    bookmarks.server.ts add/remove/resolve/snooze + list derivation
    sending.server.ts   draft-and-send with its telemetry family
    jobs.server.ts      registered jobs array
    *.common.ts         schemas, copy maps, named constants per domain
  db/
    migrations/         timestamped, prose-named, self-contained
    scripts/            migration.ts, migrate.ts, rollback.ts
    types.d.ts          generated — never hand-edited
    dev-seed/           empty-database-only seed for local development
  mcp/
    tool.ts             McpTool shape
    server.server.ts    stdio server: listTools/callTool, JSON-schema projection
    registry.server.ts  accumulate-only tool array
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
  mcp-client.ts         stdio client harness
  coverage/gate.ts      every registered MCP tool must be exercised by the suite
  seed/                 per-run fresh-store E2E seed built from a fake gateway feed
```

## Database doctrine

The bettr-manager append-only doctrine applies unchanged: `INSERT` is the only write,
identity tables + event tables are the only two kinds, no nullable columns, no `updatedAt`,
no derived/status columns, deletion is an event, state is computed at query time.

SQLite adaptations (the only sanctioned divergences, mirrored in CLAUDE.md):

- **ids** are `crypto.randomUUID()` generated in application code — SQLite has no
  `gen_random_uuid()`. Insert helpers own this; migrations declare `text` primary keys.
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

- `channel_detail_revisions` — full snapshot per observed change: name, topic, category,
  isThread, position.
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

- `message_send_requests` / `...deliveries` / `...failures` / `...skips` — MCP sends.
- `backfill_runs` / `backfill_run_progress` / `...completions` / `...failures` — REST
  history backfills, with real denominators for progress.
- `gateway_connections` / `gateway_disconnections` — activity derivation reads
  `receiving | quiet | never` against a named silence-threshold constant.

Owner-facing status is always mapped copy from exhaustive typed maps in `.common.ts`
(summary + nextAction per reason), never raw vendor text — pinned by serialization tests.

## Authorization

The three-layer architecture survives with a collapsed top: the owner is configured, not
authenticated. `ownerContext()` builds context from env (bot token, owner user id, guild id)
plus the store, and `ownerContextSchema` still carries `z.literal(true)` capability flags
(`canReadMessages`, `canManageBookmarks`, `canSendMessages`) so every business function
validates context exactly as in bettr-manager and the gates stay testable. The MCP layer
contains zero authorization — tools call business functions with the real context.

## MCP tools (v1)

`channels_list`, `messages_catch_up` (since + optional channel), `mentions_list`,
`bookmarks_list`, `bookmarks_add` (by message link), `bookmarks_resolve`,
`bookmarks_snooze`, `messages_send` (channel, content, optional reply), `ingestion_status`.

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
- channel/thread create/update/delete → channel revisions/removals

Startup runs a backfill per readable channel from the newest stored message forward, as a
`backfill_runs` telemetry family with progress rows. Reconnects re-run the gap sweep.

## Testing

- **Unit**: Vitest against a real throwaway SQLite database (created + migrated in global
  setup, `_unit` suffix guard). Real queries, no mocks. Colocated `*.test.ts`, one
  `describe` per public function, fixtures with `crypto.randomUUID()` entropy,
  `fromSuccess` for happy paths, specific error assertions.
- **End-to-end**: specs named as behavior sentences (`a-bookmarked-message-survives-the-
  authors-edit.spec.ts`), one test per file. Each spec seeds the store through the real
  ingestion business functions (a scripted fake gateway feed — no network), spawns the real
  MCP server over stdio, and drives it with the real MCP SDK client. Discord REST calls in
  `messages_send` go through an injected transport double that records requests.
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
