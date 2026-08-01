---
name: env-vars
description: Manage environment variables through the two-tier typed env pattern — a framework env and an app env, both built with make-typed-env and Zod. Use when adding or renaming an env var, editing app/framework/env.server.ts or app/env.server.ts, updating .env.example, or wiring configuration into framework, business, MCP, or ingest code.
---

# Environment Variables

Everything here documents the repository as it is on `main`. If `main` disagrees with this file, `main` wins: follow it and flag the drift.

Configuration follows a **two-tier pattern**: a framework env holding only the vars framework code reads, and an app env holding every var (framework vars plus product vars).

## Architecture

### Framework env — `app/framework/env.server.ts`

Holds only what framework code needs — today, the database path. Framework files (`db.server.ts`, `scheduler.server.ts`) import `env` from `./env.server` with a relative path. This is what keeps `app/framework/` extractable: it validates only its own surface and never learns a product var exists.

### App env — `app/env.server.ts`

Holds **all** vars: the framework vars again, plus the product vars (`DISCORD_BOT_TOKEN`, `DISCORD_OWNER_USER_ID`, `DISCORD_GUILD_ID`). It imports `makeTypedEnv` from `make-typed-env` and defines its own schema.

Product code — `app/business/`, `app/mcp/`, `app/ingest/`, `app/db/`, `app/test/` — imports `env` from `~/env.server`.

### Why two independent singletons

Each `env()` parses `process.env` through its own `makeTypedEnv` instance. Caching is built into `makeTypedEnv`, so the `() => getEnvironment(process.env)` wrapper is enough. The two share no state, which is exactly the point: the framework validates what it needs, and the app validates everything.

## Read configuration through `env()`

Application code never reads `process.env` directly. Every value arrives through `env()`, already validated and camelCased, so a missing or malformed variable fails loudly at startup instead of surfacing as `undefined` deep inside a query or a Discord call.

## Adding a new env var

### Product var (a new Discord setting, a new tuning knob)

1. Add the Zod field to `app/env.server.ts` only
2. Add the key, with an explanatory comment, to `.env.example`
3. Add the value to the job-level `env:` block in `.github/workflows/ci.yml`
4. Update the setup documentation if the owner has to obtain the value from somewhere
5. Import `env` from `~/env.server` in the consuming file

### Framework var (a new database or scheduler option)

1. Add the Zod field to **both** `app/framework/env.server.ts` and `app/env.server.ts`
2. Add the key to `.env.example`
3. Add the value to the job-level `env:` block in `.github/workflows/ci.yml`
4. Framework files import from `./env.server`; product files import from `~/env.server`

## CI environment variables

The CI workflow lives at `.github/workflows/ci.yml`. Values go in the workflow-level `env:` block, and the seed smoke step carries its own overrides on top of it. CI has no `.env`, so a required variable added to a schema but not to the workflow passes every local gate and red-builds the PR that adds it. Use placeholder values for services CI never actually calls (`'placeholder'` for the bot token).

The E2E harness holds a third copy: `serverEnvironment` in `tests/mcp-client.ts` hardcodes the environment the spawned server receives, so a variable the server requires lands there in the same change.

## Import conventions

```typescript
// framework code, inside app/framework/
import { env } from './env.server'

// product code, anywhere else under app/
import { env } from '~/env.server'
```

Never import `env` from `~/framework/env.server` in product code — that singleton carries only framework vars and silently lacks the product fields.

## The `makeTypedEnv` factory

Provided by the `make-typed-env` package:

```typescript
import { makeTypedEnv } from 'make-typed-env'
import { camelKeys } from 'string-ts'
import { z } from 'zod'

const getEnvironment = makeTypedEnv(
  z.object({ /* ... */ }),
  { transform: camelKeys },
)
const env = () => getEnvironment(process.env)
```

- Schema-agnostic — it accepts any Standard Schema; this project uses Zod
- `transform: camelKeys` from `string-ts` converts `SNAKE_CASE` keys to camelCase, so `DISCORD_GUILD_ID` reads as `env().discordGuildId`
- Caches by default, so the thin wrapper is all that is needed
- Every call to the factory creates an independent instance, so the two tiers never interfere

## Schema duplication is intentional

Framework vars appear in both schemas. That duplication is what decouples the folder from the app. When a framework var's validation changes — a new default, a tighter format — update both files in the same change.

## Secrets

`DISCORD_BOT_TOKEN` is a credential. It is read through `env()` at the point of use and never copied into a stored row, an error message, a telemetry payload, or an MCP tool result. `.env` stays out of version control; `.env.example` carries the key and the instructions for obtaining a value, never a value.
