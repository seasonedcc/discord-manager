---
name: mcp-server
description: Build and extend the MCP stdio server in app/mcp/ — the product's entire user surface — keeping the tool surface equal to the business surface. Use when adding or changing a tool, wiring a new domain into the server, editing app/mcp/*, working on the parity test or its exemptions, naming a tool, or shaping a tool's input schema at the JSON boundary.
---

# MCP Server

Everything here documents the repository as it is on `main`. If `main` disagrees with this file, `main` wins: follow it and flag the drift.

Discord Manager has no web UI. The MCP server is how the owner uses the product: an MCP client spawns `pnpm run mcp` over stdio and calls **tools** that are thin projections of the business layer. The rule that keeps this honest: **the MCP server never serves more, and never less, than the business layer serves the owner** — enforced by the parity test.

## Architecture map

```
app/mcp/
  tool.ts                   McpTool shape (name, description, inputSchema, wraps, execute)
  server.server.ts          stdio server: listTools / callTool dispatch, JSON-schema projection
  registry.server.ts        accumulate-only array of every domain's tools
  tools/<domain>.server.ts  one array per domain (channelsTools, bookmarksTools, …)
  run.ts                    entrypoint — `pnpm run mcp`
  parity.test.ts            every business capability is wrapped xor exempt
  parity-exemptions.ts      business functions that are not owner capabilities, with a reason each
```

The server is stdio-only and single-owner. There is no network listener, no bearer token, no consent screen, and no scope model — the process is spawned by the owner's own client on the owner's own machine, and the configured owner is the only identity.

## THE ONE RULE

A tool's `execute` is a **single business-function call, passing the real owner context**. No authorization lives in `app/mcp/` — every gate is the business layer's own gate, reused:

- **Capability** is the business function's `applySchema(input, contextSchema)`. The extended context schema carries `z.literal(true)` flags; a deployment that lacks a capability fails validation there, with the same error a job or a test would get.
- **Data scoping and the final say** belong to the same schema. If the business layer would deny it, it denies it here too, with the identical message.

Every registered tool is listed, always. There is no visibility filter in the MCP layer: hiding a tool would be an authorization decision, and authorization decisions live in the business layer. Denial surfaces from the call, not from the listing.

If a tool ever needs to *decide* something the business function does not already decide, the tool is wrong — push the decision into the business layer.

## Tool authoring

Add a tool by appending to its domain array in `tools/<domain>.server.ts`; for a new domain, create the file and register it in `registry.server.ts`.

- **Name**: `snake_case`, `<domain>_<verb_phrase>` — `channels_list`, `bookmarks_resolve`, `messages_catch_up`, `messages_send`. One tool, one capability.
- **Description**: outcome-oriented, stating what the caller gets. "Post a message to a channel as the owner's bot, optionally as a reply." Not "calls sendMessage".
- **inputSchema**: reuse the business function's own exported schema. Never redefine a schema the function already owns — a redefinition drifts, and the drift is invisible until a caller hits it. When the business layer narrows a function for the owner — a wrapper that pins a field the owner never chooses — the tool wraps the **narrowed** door. Exposing the wider raw schema hands the MCP caller a choice the product denies, which breaks the never-more half of THE ONE RULE even though every gate still passes.
- **wraps**: `['<module>.<functionName>']` — the business function the parity test pairs this tool to.
- **execute**: `(input, context) => businessFn(input, context)`. The context is the real owner context, already built.

Every tool wraps a named business function. There is no sanctioned `wraps: []` tool: if there is nothing to wrap, there is no capability to expose. A capability that seems to need one is a missing business function, not an exception.

## Dates at the JSON boundary

A tool's input schema crosses a JSON boundary, so instants are **strings**: `z.iso.datetime()` projects to `{ type: 'string', format: 'date-time' }`, and `z.iso.date()` to `{ ..., format: 'date' }`. This costs nothing, because the store keeps ISO-8601 UTC text end to end — an ISO string needs no conversion on the way in and no formatting on the way out.

Never `z.date()` on any path a tool can reach. One trap: `z.date(...)` *with* an argument is invisible to a `z.date()` grep — audit with `z\.date\(` (open paren, no close). A business schema still using a `Date` gets converted to `z.iso.datetime()` in the same change that wraps it, proven by that domain's existing tests staying green.

Timestamps in a tool's **output** are ISO strings too, never a formatted display string and never a `Date` instance that `JSON.stringify` would silently reshape.

## Cursors run on one clock

A tool whose answer feeds back as its own next input — a `since`, a watermark, any cursor — keeps every instant it emits and accepts on **a single clock: the store's own arrival clock** (`createdAt`), never a vendor timestamp. The store's clock is the only one whose "newest" is also "latest written": vendor stamps trail or lead the host through gateway lag, backfills, and skew, so a cursor computed on one clock and compared against another silently drops events below a forward-only cutoff. Cutting on arrival time also makes late-arriving history — a post-downtime backfill — count as new, which is exactly what a poller is asking.

Boundary semantics follow the tool's role, and the field's description says which applies: a **reading** tool's `since` is inclusive (`>=`) — re-reading the boundary message is harmless; a **cursor** tool's cutoff is strictly-after (`>`) — an inclusive boundary re-counts the newest event forever, so the poller can never read "all quiet".

The proof lives in the E2E spec: it executes the tool description's recipe *literally* — poll, feed the answer's timestamp back exactly as the copy instructs, read zeros. A spec that has to route around its own tool's instructions to observe an event is not a passing spec; it is the defect report.

## Scalars at the JSON boundary

An MCP client sends native JSON types. A schema that accepts only a string form of a scalar — a boolean written as `'true'`, a number written as `'5'` — rejects exactly what a real client sends. Business schemas on a wrapped path accept the native type: `z.boolean()`, `z.number()`, `z.string()`. When a wrapped schema carries a coerced field, add a test proving the native JSON value reaches the business logic — it should fail on a business rule, never on input validation. Audit wrapped input schemas with a `z\.coerce` grep the way dates are audited with `z\.date\(` — a coercion that accepts a string form of a scalar was written for some other caller's wire format, and a JSON client sends the native type.

## Jobs are not capabilities

A business function whose only effect is enqueuing a job is not itself the capability — the owner action that enqueues it is, and that action has its own tool. Never expose a job dispatcher as a standalone tool.

## Registry is accumulate-only

`registry.server.ts` is one import and one spread per domain; `parity-exemptions.ts` accumulates the same way. Resolving a merge conflict across them is **not** a uniform marker-strip:

- **`registry.server.ts` — regenerate from the union.** Rebuild the import block and the spread array from the union of unique import lines and unique spread entries across both sides, then assert the two sets match: every imported domain array is spread exactly once.
- **`parity-exemptions.ts` — keep both sides, then read the boundary by hand.** Marker-stripping can fuse two adjacent object literals into one duplicate-key object, silently dropping an exemption.

Run the parity test after either resolution; it is the net that catches the mistake.

## The parity test

`parity.test.ts` enumerates every exported function in `app/business/*.server.ts` and asserts each one is **wrapped xor exempt**. There is no third state and no backlog list: a capability that ships without its tool fails the build in the PR that adds it.

- **Wrapped** — some tool's `wraps` names it. This is the goal state for every owner capability.
- **Exempt** (`parity-exemptions.ts`, `{ functionName, reason }`) — a machine surface that is genuinely not an owner capability: the gateway-driven ingestion recorders the daemon calls on each event, the scheduler's job bodies, the context builder itself. Each entry states *why* it is not a capability. A bogus exemption ("no tool for it yet") is a lie a reviewer rejects — exemptions are forever, and only for genuine non-capabilities.

Further assertions the test holds: no dangling `wraps` naming a function that does not exist, no duplicate tool names, and no exemption naming a function that no longer exists.

**The Definition of Done**: every new or changed capability extends the MCP server *in the same PR*. Falsely exempting a capability does not satisfy it.

## Testing canon

Build the owner context directly from test fixtures and call `listTools` / `callTool` — no transport needed for unit coverage. Per wrapped domain, cover two shapes:

- **Denial** — a context missing the capability flag surfaces the business layer's exact error message through the tool result.
- **Happy path** — a real call writes the expected event row (`bookmarks_resolve` appends a `bookmarkRemovals` row) or returns real stored data.

Load `testing` for fixtures, the append-only test doctrine, and the end-to-end specs that drive this server over a real stdio transport.

**Proving a gate without weakening committed source.** When proving a guard would require neutering committed code, prove it through the injection seam instead: assert the real tool denies, then pass an in-memory spread-copy of that same tool with the guard neutered and assert the copy stops denying. Committed source never changes, and because both assertions run the same tool object, a wrong-name false green is ruled out too.

## Driving the server from a real client

The Definition of Done includes exercising the work through a real MCP client session. The server is wired through `.mcp.json`, so a client spawns it the same way the owner's assistant does. Two mechanics that bite:

- Give the model exact "use these arguments verbatim" instructions, or the tool calls are not reproducible.
- Headless client runs can print wrapper output before the JSON — parse the last result object, not the first line.
- Add `--output-format stream-json --verbose` to a headless run to capture the exact `tool_use` inputs the model sent. Without them you see only results — which is precisely how a boundary-coercion or schema-shape defect hides behind a plausible-looking answer.
