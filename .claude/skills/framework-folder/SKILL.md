---
name: framework-folder
description: Enforce the separation between reusable framework code and product code in app/framework/. Use when adding a file or a helper to app/framework/, importing a framework module, wiring the database connection or the scheduler, or deciding where a new abstraction belongs.
---

# Framework Folder

`app/framework/` contains **zero product-specific logic**. It stays self-contained enough to be extracted as a separate npm package at any moment — nothing in it may know that this product manages Discord.

## What belongs in `app/framework/`

Only reusable abstractions any app built on this framework would need:

- **`db.server.ts`** — `makeDb`, the migration provider, `createDbMigration`, `migrateDbToLatest` / `migrateDbDown`. Connection construction, WAL and foreign-key pragmas, the `CamelCasePlugin` wiring.
- **`env.server.ts`** — the `makeTypedEnvironment` factory and the framework-only env schema. Load `env-vars` for the two-tier pattern.
- **`scheduler.server.ts`** — `makeJob`, `makeCronJob`, `makeSchedulerRunner`. An in-process scheduler, no queue.
- **`globals.ts`** — `getOrSetGlobal`, the HMR- and test-safe singleton holder.
- **`helpers.ts`** — pure helpers, added only when a second caller actually needs one.

## What does NOT belong in `app/framework/`

- Product env vars (`DISCORD_BOT_TOKEN`, `DISCORD_OWNER_USER_ID`, `DISCORD_GUILD_ID`)
- Domain models: guilds, channels, messages, bookmarks, digests
- `discord.js`, `@modelcontextprotocol/sdk`, or any knowledge of the MCP tool shape
- Product configuration or copy
- Anything that references `app/business/`, `app/mcp/`, `app/ingest/`, or `app/db/`

A helper that mentions a product noun in its name or its types belongs in `app/business/` instead.

## Import direction

The dependency flow is strictly one-directional:

```
app/business/  → imports from → app/framework/
app/mcp/       → imports from → app/framework/
app/ingest/    → imports from → app/framework/
app/db/        → imports from → app/framework/
app/test/      → imports from → app/framework/

app/framework/ → NEVER imports from → app/business/, app/mcp/, app/ingest/, app/db/, or app-level files
```

Framework files import from each other with relative paths (`./env.server`, `./globals`).

## The factory pattern

When framework code needs product-specific configuration, it exposes a factory the product calls with its own config:

```typescript
// app/framework/db.server.ts — the framework provides the factory
function makeDb(config: { databasePath: string }) {
  // generic connection, pragmas, plugins, migrator
}

// app/db/db.server.ts — the product supplies its config
const db = makeDb({ databasePath: env().databasePath })
```

The factory never reads `process.env` for a product var and never defaults to a product-specific value.

## Litmus test

Before adding anything to `app/framework/`:

1. Would another app built on this framework need this?
2. Does it reference a product module, a product env var, or a product noun?
3. Could it ship as part of a standalone npm package with no edits?

A "no" to #1, a "yes" to #2, or a "no" to #3 means it belongs in `app/business/` or in the transport that needs it.
