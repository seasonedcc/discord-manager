---
name: type-safety
description: Write minimal, correct TypeScript — inference first, annotations only where removing them would lose safety, and no `any`. Use when adding types, declaring variables, writing a function signature, creating a type alias, deriving a type from a Zod schema, or reviewing code for redundant annotations and stray assertions.
---

# Type Safety

Everything here documents the repository as it is on `main`. If `main` disagrees with this file, `main` wins: follow it and flag the drift.

TypeScript runs in strict mode and `any` is not allowed anywhere. Lean on inference: add an annotation only when removing it would lose type safety or cause a compile error. Before adding one, ask whether TypeScript would infer the correct type without it.

## Return types

Do not add return types. TypeScript infers them from the body.

```typescript
// correct
async function fetchBookmarks() {
  const rows = await db().selectFrom('bookmarkAdditions').selectAll().execute()
  return rows
}

// wrong — redundant return type
async function fetchBookmarks(): Promise<BookmarkRow[]> {
  const rows = await db().selectFrom('bookmarkAdditions').selectAll().execute()
  return rows
}
```

### Exceptions where a return type is required

- **Interface implementations** — when a method must satisfy a library interface, such as Kysely's `MigrationProvider`
- **Non-async functions returning promises** — without `async`, TypeScript can infer a more complex type than intended

## Variable annotations

Do not annotate a variable whose type is obvious from the right-hand side.

```typescript
// correct
const threshold = 15

// wrong — redundant
const threshold: number = 15
```

### Empty collections need annotations

TypeScript cannot infer the element type of an empty literal. Annotate empty arrays and objects that get populated later.

```typescript
const skippedChannelIds: string[] = []

const grouped = channelIds.reduce<Record<string, string[]>>(
  (groups, id) => ({ ...groups, [id]: [] }),
  {},
)
```

## Map constants

A constant object indexed with a dynamic string key needs an explicit index type; otherwise TypeScript infers a literal object type that rejects arbitrary string indexing.

Copy maps keyed by a closed reason union are the opposite case: type them with `satisfies Record<Reason, Guidance>` so the map stays exhaustive and a new reason fails to compile until it has copy. Load `integration-telemetry` for what those maps hold.

## Function parameter defaults

A default of `{}` or `[]` tells TypeScript nothing about the intended type. Annotate the parameter.

```typescript
function buildQuery(channelIds: string[], options: Record<string, string> = {}) { ... }
```

## Zod type aliases

Derive types from schemas with `z.infer`; never hand-write a type mirroring a schema.

```typescript
const bookmarkSchema = z.object({
  messageId: z.string(),
  source: z.enum(['reaction', 'mcp']),
})
type Bookmark = z.infer<typeof bookmarkSchema>
```

Keep a `z.infer` alias only when it is used in more than one place. An alias that appears solely as a function's return type annotation is two things to delete: the alias and the annotation.

## Reuse existing types

Before writing an inline type, check whether the shape already exists, and import it instead of duplicating.

Shared types worth knowing:

- Context types from `~/business/auth.server` — the inferred type of `ownerContextSchema` and each domain's extended context schema
- Database table types from `app/db/types.d.ts` — generated from `app/db/migrations` by `pnpm run db:generate`, never hand-edited
- `McpTool` from `~/mcp/tool` — the shape every tool satisfies
- A domain's own `<name>Schema` and its inferred type, exported from its business file

```typescript
// correct — reuses the schema's inferred type
import type { OwnerContext } from '~/business/auth.server'
function summarize(context: OwnerContext) { ... }

// wrong — duplicates the shape and drifts the moment the schema changes
function summarize(context: { ownerUserId: string; guildId: string }) { ... }
```

## Generic type arguments

Do not pass explicit generic arguments TypeScript can infer from the call site.

```typescript
// correct
const rows = await paginate(query, { limit, cursor })

// wrong
const rows = await paginate<DB, 'messages', Row>(query, { limit, cursor })
```

## Type assertions

Use `as` only where TypeScript genuinely cannot know the type:

- A JSON payload from an untyped HTTP response — cast to the expected shape after parsing
- `$castTo<T>()` in Kysely for a computed column the builder cannot infer, such as a `case` expression producing a status union
- `as const` for literal tuples and objects that must not widen
- `{} as LibraryType` in a test, for a library object the test does not exercise

Never use `as` to silence a type error — fix the underlying type. `as any`, `as unknown as T`, and `@ts-expect-error` are not ways out of a wrong type.
