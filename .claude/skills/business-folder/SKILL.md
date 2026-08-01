---
name: business-folder
description: Organize domain logic in app/business/ by domain cohesion and transport independence. Use when creating a file in app/business/, adding a function to one, naming a business module, deciding whether logic belongs in business or in a transport (app/mcp/, app/ingest/), or choosing what a business file may import.
---

# Business Folder

`app/business/` holds the most valuable code in the product — the domain logic that defines what Discord Manager does. Transports come and go: the MCP server and the gateway daemon are both thin shells over this folder.

The guiding question: **if the MCP server and the gateway client were both replaced tomorrow, could the business folder come along unchanged?**

Every file is named after the **business domain** it serves, every function belongs to that domain, and the code stays independent of transport concerns.

## Transport independence

Business functions never import `@modelcontextprotocol/sdk`, never import a discord.js gateway `Client`, and never touch `process.argv`, stdio, or process lifecycle. Those dependencies tie domain logic to the current transport and make it impossible to extract.

### What belongs in business files

- **Third-party domain libraries** — `composable-functions`, `zod`, `kysely`, and discord.js REST primitives used to call the Discord API
- **Database access** — `db()` from `~/db/db.server`, the product's instance of the framework's `makeDb` factory (Kysely is transport-agnostic)
- **Environment config** — `env` from `~/env.server` (Zod-validated, no transport dependency)
- **Other business files** — `./auth.server`, `./channels.server`, respecting the no-cross-imports rule

### What belongs in the transports

- `app/ingest/` — constructing the discord.js `Client`, declaring intents and partials, registering gateway event listeners, reconnect handling, the daemon entrypoint. Handlers translate an event into arguments and call one business function.
- `app/mcp/` — the `McpTool` shape, JSON-schema projection, `listTools`/`callTool` dispatch, the stdio transport, the process entrypoint. Load `mcp-server` for that layer's rules.
- `app/db/scripts/` — migration, rollback, and codegen entrypoints.

A gateway handler or a tool that contains a domain decision is a bug in the layering: push the decision into `app/business/`.

### Acceptable framework wrappers

`makeJob` and `makeCronJob` from `~/framework/scheduler.server` are acceptable inside business files. Scheduling is a business concern, and these wrap the in-process runner without dragging in a transport. `app/business/jobs.server.ts` holds the registered jobs array; the daemon only runs it. Load `background-jobs` before writing or changing a job.

### The context file

`auth.server.ts` is the entry point to every gate: it builds the owner context from env plus the store and exports `ownerContextSchema`. The rest of the business layer imports the **schemas** from it — never a wider surface — and validates against them through `applySchema`. Load `composable-functions` for how context validation works, and `mcp-server` for why no gate is ever re-implemented in a tool.

## Naming rule

Name files after the business domain, not the implementation detail.

```
✅ ingestion.server.ts   — domain: recording what happens on the server
✅ bookmarks.server.ts   — domain: bookmark management
✅ sending.server.ts     — domain: posting as the owner's bot

❌ discord-js.server.ts  — named after the library, not the domain it serves
❌ rest-client.server.ts — same problem: transport name, not business domain
```

### Infrastructure exception

A file providing **generic infrastructure primitives** may be named after its provider, because the provider *is* its domain — it wraps a service API without embedding product-specific logic. The test: if the file contains schemas, business rules, copy maps, or domain-specific processing, it belongs in a domain-named file, even when every function calls the same external API.

## File suffixes

- **`.server.ts`** — business logic (database queries, Discord API calls, jobs)
- **`.common.ts`** — schemas, copy maps, and named constants for a domain, importable from anywhere
- **`.test.ts`** / **`.server.test.ts`** / **`.common.test.ts`** — unit tests, colocated with the implementation

## One export block

Each business file ends with a single `export { ... }` block listing its public functions, plus a single `export type { ... }` block for its exported types. Declarations are plain `function`/`const` at the top level, never `export function` inline. One block makes the file's public surface readable in one glance and makes it obvious when a helper is being exported only for a test — which is not a reason to export it.

## Cohesion rule

Every function in a file belongs to that file's domain. A function serving a different domain moves to the file that owns it.

Signs of poor cohesion:
- A file named after a Discord API surface but holding bookmark rules
- Functions in a file consumed only by a single other domain
- A file whose functions relate to each other only by implementation detail

## No cross-imports

Business files must not create circular dependencies:

```
✅ digests.server.ts  → imports from → channels.server.ts
❌ channels.server.ts → imports from → digests.server.ts
```

When two files need the same utility, in order of preference:

1. **Merge the files** if they serve the same domain
2. **Keep a private copy** in each file if the utility is small and trivial
3. **Extract to a new file** only if the utility is substantial and shared by three or more files

## When to merge vs split

**Merge** when files serve the same business domain, even when they use different external APIs internally. The library used is an implementation detail, not a reason to separate files.

**Split** when a file grows to cover distinct business domains. The right boundary is the domain, not the file size.

## Litmus test

Before creating or modifying a business file, check:

1. Could this file survive replacing the MCP server or the gateway client?
2. Does the name describe the **business domain** (what it does) rather than the **implementation** (how it does it)?
3. Do all functions in this file belong to the same domain?
4. Would someone unfamiliar with the codebase find this function here based on the filename?
5. Does this file import `@modelcontextprotocol/sdk`, a gateway `Client`, or anything from `app/mcp/` or `app/ingest/`? If so, the logic is in the wrong layer.

A wrong answer to any of these means the file needs changes.
