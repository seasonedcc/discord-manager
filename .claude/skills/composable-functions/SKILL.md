---
name: composable-functions
description: Build business functions with the composable-functions library — applySchema, context validation with capability flags, combinators, and Result handling. Use when writing or changing a function in app/business/, validating input or context, composing with pipe/sequence/all/collect/branch, throwing InputError or ContextError, or unwrapping results with fromSuccess.
---

# Composable Functions

Every function in `app/business/` is a composable built with `composable-functions` (v5). This is what makes the layer callable identically from an MCP tool, a gateway handler, a scheduled job, a seed, and a test.

## Core types

### Composable

A function that returns `Promise<Result<T>>`:

```typescript
import { composable } from 'composable-functions'

const add = composable((a: number, b: number) => a + b)
//    ^? Composable<(a: number, b: number) => number>
```

### Result

A union of success and failure:

```typescript
type Result<T> = Success<T> | Failure

// Success
{ success: true, data: T, errors: [] }

// Failure
{ success: false, errors: Error[] }
```

Always check `success` before reading `data`:

```typescript
const result = await fn()
if (!result.success) {
  return
}
// result.data is type-safe here
```

## Error types

### InputError

Validation errors about caller input. Every `InputError` carries the path of the field it is about, so the caller can tell which argument to fix:

```typescript
import { InputError } from 'composable-functions'

throw new InputError('That message is not in an ingested channel', ['messageLink'])
```

A pathless `InputError` leaves the caller guessing — always name the field.

### ContextError

Authorization and configuration errors:

```typescript
import { ContextError } from 'composable-functions'

throw new ContextError('This deployment cannot send messages', ['canSendMessages'])
```

### ErrorList

Group several errors into one failure:

```typescript
import { ErrorList, InputError } from 'composable-functions'

throw new ErrorList([
  new InputError('Required', ['since']),
  new InputError('Unknown channel', ['channelId']),
])
```

## Schema validation with applySchema

`applySchema` validates both input and context at runtime and types both for the body:

```typescript
import { applySchema } from 'composable-functions'
import { z } from 'zod'

const fn = applySchema(
  z.object({ messageId: z.string() }),  // input schema
  ownerContextSchema                     // context schema
)(async ({ messageId }, context) => {
  // both are validated before the body runs
})
```

**Every business function validates context**, without exception — including read-only ones. A function that takes no meaningful input still passes a schema (an empty object schema) so its context gate stays declared and testable.

### Context and capability flags

`auth.server.ts` builds the owner context from env plus the store and exports `ownerContextSchema`. Deployments are single-owner: the owner is configured, not authenticated. The gate is still a schema, and the schema still carries **capability flags as `z.literal(true)`**:

```typescript
import { applySchema } from 'composable-functions'
import { ownerContextSchema } from '~/business/auth.server'
import { z } from 'zod'

const sendMessageContextSchema = ownerContextSchema.extend({
  canSendMessages: z.literal(true),
})

const sendMessage = applySchema(
  sendMessageSchema,
  sendMessageContextSchema
)(async (input, context) => {
  // reaching this body proves the capability was present
})
```

A `z.literal(true)` flag is the whole gate: a context missing the flag, or carrying `false`, fails validation with a `ContextError` before the body runs. Callers never re-check a capability the schema already requires, and no caller invents its own check — the schema is the single source of truth for who may do what.

Each domain declares the extended context schema it needs, next to the functions that use it. The flags themselves (`canReadMessages`, `canManageBookmarks`, `canSendMessages`) are computed once when the context is built.

### Schema naming and export

A business function's input schema is declared as `<name>Schema` and exported from the same file. It is the one definition of that function's input, reused by every caller — the MCP tool layer reuses it rather than restating it (load `mcp-server` for that rule). Never write a second schema describing the same input.

`applySchema` erases the input type: the composable it returns accepts `unknown`, so `tsc` sees nothing wrong with a caller that drops a required field or passes the old shape of one that changed. Every call site outside the MCP layer therefore ties its payload back to the schema — `z.input<typeof recordIncomingMessageSchema>` as the type of the object it builds, or `satisfies` on the literal it passes — and never hands a business function a bare object literal. `app/ingest/gateway.server.ts` types every observation it feeds this way, and `app/db/dev-seed/seed.ts` every payload it seeds. A payload tied to its schema turns a shape change into a compile error; an untied one turns it into a runtime failure at the caller, which for the seed means a self-hoster's first `pnpm run db:seed:dev`.

## Composition combinators

### pipe

Sequential composition, left to right:

```typescript
import { pipe } from 'composable-functions'

const addAndDouble = pipe(add, double)
const result = await addAndDouble(2, 3)
// result.data = 10
```

### sequence

Like `pipe`, but returns every intermediate result:

```typescript
const fn = sequence(a, b)
const result = await fn(1)
// result.data = ['1', true]
```

### all

Run functions in parallel with the same input:

```typescript
const fn = all(add, mul)
const result = await fn(2, 3)
// result.data = [5, 6]
```

### collect

Like `all`, with named results:

```typescript
const fn = collect({ sum, product })
const result = await fn(2, 3)
// result.data = { sum: 5, product: 6 }
```

### branch

Conditional execution — pick the next composable from the previous output:

```typescript
const findMessage = branch(
  parseMessageReference,
  (reference) => (reference.kind === 'link' ? findByLink : findById)
)
```

### map

Transform successful output:

```typescript
const describeCount = map(countUnread, (count) => `${count} unread`)
```

## Working with context

The `withContext` namespace passes context automatically through a composition:

```typescript
import { withContext } from 'composable-functions'

const fn = withContext.pipe(loadChannel, summarizeChannel)
const result = await fn(input, context)
```

`withContext.sequence` and `withContext.branch` behave like their plain counterparts while forwarding context to every step. Use them whenever a pipeline's steps each need the owner context — hand-threading context through a manual composition is how a step ends up running unvalidated.

## Error handling

### Check error types

```typescript
import { isInputError, isContextError } from 'composable-functions'

const result = await fn(input)
if (!result.success) {
  const inputErrors = result.errors.filter(isInputError)
  const contextErrors = result.errors.filter(isContextError)
}
```

### Transform errors

```typescript
import { mapErrors } from 'composable-functions'

const withMappedErrors = mapErrors(fn, (errors) => errors.map(toOwnerFacingError))
```

Mapping is where a raw Discord API error becomes something the owner can act on. Load `integration-telemetry` for what an owner-facing message may contain.

### Catch failures

```typescript
import { catchFailure } from 'composable-functions'

const optional = catchFailure(fn, () => null)
```

Use it only where the absence of a value is genuinely fine. Swallowing a failure that should have been recorded as an outcome is a telemetry defect.

## Utilities

### fromSuccess

Unwrap a successful result or throw its errors — the standard way one business function calls another, and the standard way a test drives a happy path:

```typescript
import { fromSuccess } from 'composable-functions'

const channel = await fromSuccess(findChannel)({ channelId })
```

### success / failure

Build results by hand when a function must return a result it did not compute through a composable:

```typescript
return success({ bookmarks })
return failure([new InputError('Unknown channel', ['channelId'])])
```

### serialize

Make a result JSON-safe before it crosses a boundary:

```typescript
import { serialize } from 'composable-functions'

JSON.stringify(serialize(result))
```

## Common patterns

### Validate, then transform

```typescript
const fn = pipe(
  applySchema(inputSchema, contextSchema)(loadAndValidate),
  map(toOwnerFacingShape),
)
```

### Parallel reads for one payload

```typescript
const fetchDigest = collect({
  channels: listChannels,
  mentions: listMentions,
  bookmarks: listBookmarks,
})
```

### A guard inside the body

When a rule depends on stored state rather than on the shape of the context, throw from the body with a precise error:

```typescript
const resolveBookmark = applySchema(resolveBookmarkSchema, bookmarksContextSchema)(
  async ({ bookmarkId }, context) => {
    const bookmark = await fromSuccess(findBookmark)({ bookmarkId })
    if (bookmark.state === 'resolved') {
      throw new InputError('That bookmark is already resolved', ['bookmarkId'])
    }
    return appendResolution(bookmark)
  }
)
```

## Best practices

1. **Always validate context** — every business function passes a context schema to `applySchema`.
2. **Check `success` before touching `data`** — TypeScript enforces it; do not cast around it.
3. **Use the specific error type** — `InputError` with a field path for caller mistakes, `ContextError` for capability and configuration problems.
4. **Prefer combinators over manual composition** — they keep context forwarding and error accumulation correct.
5. **One composable, one responsibility** — a function that would need two names is two functions.
6. **Unwrap with `fromSuccess` in tests** — load `testing` for the surrounding assertions.
