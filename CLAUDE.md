# Discord Manager

Self-hosted Discord bookmarks, catch-up digests, and triage for your AI assistant, over MCP — no Nitro required. The product is headless: a discord.js bot ingests one guild's messages into a local append-only SQLite event store, and an MCP stdio server is the entire user surface. Every deployment is single-owner — one bot token, one owner user id, one guild, one database file. `docs/architecture.md` is the reference for the whole design.

## The append-only doctrine

The application schema is 100% append-only and event-sourced, with zero exceptions: `INSERT` is the only write, current state is derived from events at query time, and deletion/archival/correction are events too. ALWAYS load the `database-design` skill before designing tables, writing migrations, or writing any query that changes data. The `kysely` skill covers the query-side rules (`updateTable`/`deleteFrom`/`doUpdateSet` are banned on application tables).

SQLite forces exactly five sanctioned divergences, and no others:

- **Ids** are monotonic UUIDv7 values from `newId()` in application code — there is no `gen_random_uuid()`, and a random id would turn the latest-event-wins `id desc` tie-break into a coin flip whenever two events share a millisecond. Insert helpers own this; migrations declare `text` primary keys. The guarantee is **per process**: the daemon and the MCP server each issue ids in their own order, so two processes writing to one reversible pair in the same millisecond stay unordered. That is accepted — see single-writer WAL below — and no ordering machinery exists to fix it.
- **Timestamps** are ISO-8601 UTC `text` columns; `createdAt` defaults to `strftime('%Y-%m-%dT%H:%M:%fZ','now')`, so lexicographic order equals chronological order.
- **Latest-event-wins** uses `row_number() over (partition by parentId order by createdAt desc, id desc)` filtered to `1` instead of `distinct on`. The `id desc` tie-break stays mandatory.
- **Booleans** are `integer` 0/1 at the schema level; Zod coerces at the boundary.
- **Single-writer WAL** replaces Postgres advisory locks: the ingest daemon is the only gateway writer and MCP writes are transactional, so there is no cross-process ordering machinery.

## Essential development commands

**Setup:**
```bash
pnpm install                    # Install dependencies
```

**Development:**
```bash
pnpm run ingest                 # Run the gateway ingestion daemon
pnpm run mcp                    # Run the MCP stdio server
pnpm run lint                   # Check code style with Biome
pnpm run lint-fix               # Auto-fix linting and formatting issues
pnpm run tsc                    # Type-check
```

**Database:**
```bash
pnpm run db:migration "Name"    # Create a new migration file
pnpm run db:migrate             # Run migrations and regenerate types
pnpm run db:rollback            # Roll back the last migration and regenerate types
pnpm run db:generate            # Regenerate app/db/types.d.ts from the database
pnpm run db:seed:dev            # Seed a freshly created, empty development database
```

**Testing:**
```bash
pnpm run test                   # Unit tests, then the end-to-end suite
pnpm run test:unit              # Vitest against a throwaway SQLite database
pnpm run test:e2e               # Behavior specs driving the real MCP server over stdio
```

Never hand-edit `app/db/types.d.ts` — it is generated. Write migration column names in camelCase; the Kysely `CamelCasePlugin` converts them to snake_case at compile time, and snake_case appears only inside raw SQL. Unless a migration is genuinely irreversible, run `pnpm run db:migrate`, then `pnpm run db:rollback`, then `pnpm run db:migrate` again to prove both directions before finishing.

## Tooling

- **Package manager:** `pnpm` (version 10.x). Install from the repo root with `pnpm install`.
- **Node version:** `>=22.12`.
- **Linting & formatting:** [Biome](https://biomejs.dev) — 2-space indentation, single quotes, trailing commas where valid (es5), semicolons only when required. Check with `pnpm run lint`, auto-fix with `pnpm run lint-fix`.
- **Type checking:** `pnpm run tsc`.
- **Tests:** Vitest for unit tests; the MCP-driven runner in `tests/` for end-to-end specs.
- **Shell scripting:** never rely on shell-specific constructs like bash's `${PIPESTATUS[0]}` — the shell varies by environment and such constructs can silently no-op elsewhere. When a piped command's success matters, echo each step's exit code explicitly (`cmd | tail -5; echo "exit=$?"` reports tail's status, not cmd's) or avoid the pipe.

`.github/workflows/ci.yml` shows the exact CI steps.

### TypeScript guidelines

- **TYPE OVER INTERFACE**: Use `type` instead of `interface` when possible (prefer type aliases)
- **TYPE INFERENCE**: Use TypeScript's inference where possible
- **MINIMAL ANNOTATIONS**: Only add types when required by strict mode or for clarity
- **STRICT MODE**: All TypeScript features enabled for maximum safety
- **GENERIC INFERENCE**: Design generics to be inferred from parameters
- **NO ANY**: ALWAYS Avoid `any` - proper types instead, or use `unknown` as a last resort
- **AVOID RETURN TYPES**: DO NOT ADD RETURN TYPES to functions unless strictly necessary

For comprehensive type-safety guidelines, load the `type-safety` skill.

## Coding style

- NEVER add backwards compatibility to plans or implementations unless explicitly required. This only makes our codebase unnecessarily complex.
- Do not add comments to the code unless it's an incredibly complex operation.
- Source files are TypeScript ESM modules. Server-only files end in `.server.ts`; universal files do not.
- Use dynamic `import()` calls only when strictly necessary, such as for environment-specific modules.
- Avoid abbreviations when naming things. That goes for SQL statements as well.
- Avoid Hasty Abstractions: it is OK to repeat things here and there until the right abstraction emerges.
- Only extract abstractions to new files if you need to share them among more than one file. Otherwise, extract them in the same file.
- If it can be done in a single Kysely query, do it. Only manipulate database data on Node if you can't do it in SQL.
- Run `pnpm run lint-fix` before committing to ensure formatting and import ordering.

## Business logic organization

- `app/business/` contains domain functions with `.server.ts`, `.common.ts`, and `.test.ts` files. Load the `business-folder` skill for details.
- Functions are built with `composable-functions` and `applySchema(inputSchema, contextSchema)`; context validation is where authorization lives. Load the `composable-functions` skill.
- The owner is configured, not authenticated: `ownerContext()` builds context from env plus the store, and every business function validates it. The MCP layer contains zero authorization.
- **No cross-imports** between business files, to prevent circular dependencies. If `app/business/digests.server.ts` imports from `app/business/auth.server.ts`, then `auth.server.ts` cannot import anything from `digests.server.ts`.
- Reusable, app-agnostic abstractions live in `app/framework/`. Load the `framework-folder` and `business-folder` skills for deciding where a new abstraction belongs.
- Environment variables are typed at the boundary — load the `env-vars` skill before adding or reading one.
- Every call to Discord's API records its request and its outcome append-only, and owner-facing status is mapped copy with a concrete next action, never raw vendor text. Load the `integration-telemetry` skill before adding or changing any Discord API operation.

## Fixing bugs

When addressing a bug, follow a test-driven development approach:

1. **Red** – Write a test that reproduces the issue and fails.
2. **Green** – Implement the minimal fix so the new test passes.
3. **Refactor** – Clean up the solution while keeping all tests green.

Mutation-prove any test whose absence assertion could false-pass. Load the `testing` skill for the unit and end-to-end conventions.

## Quality bar

The MCP tool surface and the README are this product's entire UX: tool names, descriptions, error messages, and setup instructions are what a user actually experiences, so hold them to the same bar as a beautiful interface — outcome-oriented, unambiguous, and honest about what went wrong and what to do next. We care even more about code quality. Please ensure our code is a work of art, always as simple as it can be, with the right domain language and prose. NEVER compromise on this quality bar to save time or tokens.

The conventions in this file and the skills are the maintainer's preferences, not gospel: when the situation genuinely warrants a better shape, diverge — with judgment, and with the divergence and its reasoning recorded in the PR that makes it. A divergence made silently is a bug; a divergence made and argued is how these conventions improve.

## Orchestration

These instructions are for the top-level session — the orchestrator. If you are a subagent (you were spawned with a specific task and your final report goes back to a coordinator), they are not addressed to you: execute your task directly — read, build, and test yourself — and never spawn subagents, launch workflows, open PRs, or merge unless your task instructions explicitly say to.

Act as the orchestrator on every task. Delegate execution to subagents and dynamic workflows and keep your own context lean: subagents do the heavy reading, building, and testing, and report conclusions back — don't read what a subagent can read for you.

Load the `subagents` skill before spawning subagents or dynamic workflows — it covers which model tier and reasoning effort to use for each kind of work and how to split tasks. Load the `orchestration` skill alongside it — it covers charters, verifying subagent claims, recovery after interruptions, and shipping lane PRs. Size every subagent task so its context lands at roughly one-third of the 1M-token window by completion, since these models start degrading past ~25–33% fill.

Break the work down however you think is best, as long as you respect dependencies: work that depends on other work only starts when the dependency has fully landed. Independent work runs in parallel. Use well-designed dynamic workflows whenever the work allows for parallelism.

Our baseline is all checks passing: `pnpm run lint`, `pnpm run tsc`, `pnpm run test:unit`, `pnpm run test:e2e`. Whenever that baseline gets lost for any reason, stop everything and restore the baseline with the highest quality level. The baseline also includes the integrity of the checks themselves: a guard that cannot see what it claims to protect, a coverage hole a suite cannot notice, or seeded state scheduled to diverge from the product is a baseline loss even while CI is green. Fix such gaps immediately upon discovery — never bank them as findings or file them as issues.

Long tasks get compacted several times, so keep a scratchpad ledger file with all the durable lessons and state you'll need after compaction. NEVER trust your compacted context. Always reground yourself on the ledger and the real sources of truth: our codebase, PRs, prototypes, etc. When your context is filling up mid-task, update the ledger, tell the user you need a compaction, and ask for it at a natural pause point — the user compacts on request — instead of working on in a degraded window.

When you need the user's input, ask in regular conversation, and keep working on whatever doesn't depend on the answer. Ask exactly one question per message and wait for the answer — never bundle multiple questions, even related ones. The same rule governs guided manual work: when walking the user through steps they perform themselves, send exactly one step per message and wait for their confirmation before sending the next.

When presenting a finding, bug, or proposal to the user, explain the problem first — what actually goes wrong, for whom, and why it matters — and only then the solution. A recommendation whose problem hasn't been established reads as noise and cannot be evaluated.

## Definition of Done

1. A task is not done unless `pnpm run lint`, `pnpm run tsc`, and `pnpm run test:unit` are all passing.
2. A task is not done if it adds or changes a business capability without extending the MCP server in the same PR, guarded by the parity check. Load the `mcp-server` skill: wrap the new or changed business function as a tool. Parking it as pending or dressing it up as a parity exemption does NOT satisfy this — pending is only for capabilities another lane owns, and exemptions are for genuine machine surfaces, not unfinished work.
3. A task is not done if it changes user-visible behavior without an end-to-end spec covering that behavior — a new spec, or an existing one updated to assert it — and without every registered MCP tool reaching the E2E coverage gate as exercised. Load the `testing` skill for the conventions.
4. A task is not done if it adds, changes, or removes a user-facing capability or setup step without updating the README and any affected setup docs in the same PR. Words and steps must match the shipped behavior — a README that promises a tool the server no longer registers, or omits an environment variable the bot now requires, is a broken product for a self-hosting user.
5. A task is not done if it has leftover comments. ALWAYS remove leftover comments before finishing. Our work should NOT add comments unless it's an incredibly complex operation.
6. A task is not done if it has not passed a code-review audit (the built-in `/code-review`) based on your judgement. Do not take the subagent suggestions at face value. Loop until YOU are satisfied with the quality.
7. A task is not done if you haven't exercised it end to end through a real MCP client session against the real server — calling the tools a user would call and reading what comes back.
8. After every other criterion passes, load the `self-improvement` skill: derive the task's lessons and open self-improvement PRs for the ones worth codifying. Never merge these PRs — the user reviews and merges them personally. Finding nothing to codify is a valid outcome.
