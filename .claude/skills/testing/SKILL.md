---
name: testing
description: Write and run Vitest unit tests against a real throwaway SQLite database and end-to-end specs that drive the real MCP server over stdio. Use when writing or fixing a test, running test:unit, test:e2e, or test:seed-coverage, practising TDD, mutation-proving an assertion, adding fixtures, editing the E2E seed or its fake gateway feed, writing a seed demonstration, or working on the tool coverage gate or the dev-seed coverage gate.
---

# Testing

Everything here documents the repository as it is on `main`. If `main` disagrees with this file, `main` wins: follow it and flag the drift.

Two suites and a standing gate. Unit tests exercise business functions against a real SQLite database with no mocks. End-to-end specs drive the real MCP server over stdio, seeded through the real ingestion functions by a scripted fake gateway feed. The dev-seed coverage gate proves every registered tool answers with demo state from a freshly dev-seeded store.

## Commands

```bash
pnpm run test:unit           # every unit test, TZ=UTC
pnpm run test:e2e            # the E2E specs, then the tool coverage gate
pnpm run test:seed-coverage  # every tool answers from a freshly dev-seeded store
pnpm run test                # unit, E2E, then the seed-coverage gate
pnpm run lint
pnpm run tsc
```

Always run `lint`, `tsc`, and `test:unit` before opening a PR. Run the E2E specs a change directly touches; a change to the seed, the client harness, or the runner touches every spec, so there the whole suite is the directly-touched set. Run `test:seed-coverage` whenever a change touches the dev seed, registers or renames a tool, or reshapes what a tool answers.

To run a subset, pass arguments straight to `pnpm run test:e2e` with no `--` separator: positional arguments filter specs by filename substring, and `--repeat=<n>` reruns the filtered set — `pnpm run test:e2e waiting-for-activity --repeat=2`. The runner is `tests/run-e2e.ts`; the tool coverage gate only judges a full, unfiltered run.

## Test-driven development

For a bug or a new behavior, follow Red-Green-Refactor:

1. **Red** — write a test that reproduces the issue or states the new behavior. It must fail.
2. **Green** — implement the minimum that makes it pass.
3. **Refactor** — clean up with everything still green.

### Mutation proofs

A green suite proves nothing about a specific test until that test has been seen red for the right reason. When the code under test already exists — a fix being re-verified, a regression test over already-correct code — red-first is not natural, so substitute a mutation proof:

1. Back up the file with `cp file file.bak`. Never undo a mutation with `git checkout -- <file>` on a file that also carries uncommitted work; that discards everything.
2. Revert or neuter exactly the behavior the test pins.
3. Run that specific test and confirm it fails with the expected message — not merely that something failed.
4. Restore the backup, verify it landed (diff or checksum against the original), and confirm green.

False-green smells worth checking whenever a test passes suspiciously easily: the expected value coincides with the old buggy behavior, so the test passes either way; the code path is stubbed above the change under test; an error assertion satisfied by a different error firing first.

A branch no harness input can reach is worse than unproven — it is untestable, and deleting its guard leaves the whole suite green. When new logic gates on a payload shape the fake feed or the Discord double cannot yet express — a forward-shaped reference, a payload with a field withheld — extending the double's levers is part of the change that adds the logic, in the same PR. And when the same observation logic lives at more than one seam — the gateway's discord.js payload and a transport's raw REST payload — each copy gets its own mutation proof: a proof against one seam says nothing about its sibling.

Never prove timing or ordering with a timer heuristic — it false-passes under load. Use a deterministic signal: a recorded event row, a callback the fake feed fires, a value the transport double captured.

### Gate reconciliation

Record the exact test and file counts before starting. After the change, compute the expected totals from every `it()` and `describe` block added or removed, then run `test:unit` twice: both runs must match the arithmetic and each other. A mismatch is a dropped file, a duplicated suite, or a flaky test — never noise to shrug off.

## Unit tests

Unit tests live beside the code as `*.test.ts` and run under Vitest.

`app/test/global-setup.ts` creates a throwaway SQLite database and migrates it before the suite, guarding that the target path carries the `_unit` suffix so a real store can never be pointed at. `app/test/prelude.ts` exports `describe`, `expect`, `it`, `vi`, and `db` — import from it rather than reaching for Vitest globals. `app/test/fixtures.ts` exports the factories (`createGuild`, `createChannel`, `createMessage`, `ownerContext`).

### Core principles

- Test the exposed API — inputs and outputs — not implementation details.
- **No mocks for the database.** Every query runs for real. A test that mocks the store proves nothing about a schema this doctrine derives everything from.
- Do not test Zod schemas on their own; test the function that applies one. The one exception is a surface-wide drift guard: `app/mcp/field-messages.test.ts` walks every registered tool's input schema and fails any field that answers a wrong value in Zod's wording instead of the owner's. One guard over the whole surface earns its place; a test for a single schema never does.
- Do not export an internal helper purely so a test can reach it.

### Organization

One `describe` per subject — a public function — named after that subject. No catch-all labels like "additional tests". Descriptive `it` names, so folding and navigation stay useful.

```typescript
describe('resolveBookmark', () => {
  it('fails when the bookmark is already resolved', async () => {
    // ...
  })

  it('appends a removal event carrying the mcp source', async () => {
    // ...
  })
})
```

### Assertions

- Prefer expressive matchers — `toContain`, `toContainEqual` — over manual `.some` scans.
- On a failure case, assert the **specific** error, not just that it failed.
- When pinning not-found behavior, assert on `RecordNotFoundError`'s `.message` (`'Record not found'`) — the class never overrides `.name`, so it stays `'Error'` and a `.name` assertion fails against the very error it means to pin.
- Drive a happy path with `fromSuccess` so the assertion reads against real data instead of unwrapping by hand.
- Never discard a returned `Result`, in setup steps least of all. A handler that wraps composables reports failure by returning, not throwing, so a discarded `Result` turns a refused insert into a downstream mismatch pointing at the wrong line — or a false-passing absence assertion. Route setup calls through a helper that throws a named error unless every `Result` succeeded; the `react`, `removeReaction`, and `clearReactions` helpers in `app/ingest/gateway.server.test.ts` are the model.

```typescript
// good
expect(result.success).toEqual(false)
expect(isInputError(result.errors[0])).toBe(true)
expect(result.errors[0].message).toBe('That bookmark is already resolved')

// bad — pins nothing
expect(result.success).toBe(false)
```

An absence assertion is the easiest silent false-pass in the suite: it passes when the thing is missing *and* when the query that looks for it was wrong. Mutation-prove every absence assertion — make the row exist and watch the assertion fail.

### Append-only test doctrine

The schema is append-only and the tests follow the same doctrine.

- **Never delete or update rows in a test.** No cleanup step, no truncate, no `afterEach` that erases anything.
- Insert rows carrying random identifiers and query by those identifiers.
- The database is never cleaned between tests, which is what lets test files run in parallel.

### Parallel safety

Many test files run concurrently against one shared database. Three patterns flake under that:

- Never assert on an unscoped aggregate — a `count(*)` without a filter tying it to rows this test created — over a table other files also write. Scope every count to the entity under test.
- Needles for search and substring tests need real entropy: use `crypto.randomUUID()`, not a few hex characters that eventually collide with another fixture.
- Shared lazily-initialized infrastructure is bootstrapped once in global setup, never on first use per file — concurrent first uses race the initialization.

A hand-built context carries real ids from its own fixtures — the guild id of the guild the test created, never a placeholder string. Queries compare context ids against real columns, so a placeholder that passes today fails the moment the function under test gains another scoped join. Placeholder text is only safe in fields no query reads.

```typescript
it('appends a removal event carrying the mcp source', async () => {
  const channel = await createChannel()
  const message = await createMessage({ channelId: channel.id })
  const context = ownerContext({ guildId: channel.guildId })

  await fromSuccess(addBookmark)({ messageId: message.id, source: 'mcp' }, context)
  await fromSuccess(resolveBookmark)({ messageId: message.id }, context)

  const removals = await db()
    .selectFrom('bookmarkRemovals')
    .selectAll()
    .where('messageId', '=', message.id)
    .execute()

  expect(removals).toHaveLength(1)
  expect(removals[0].source).toBe('mcp')
})
```

### Virtual time

A unit test that asserts on timer-driven elapsed time takes its clock from `vi.useFakeTimers()` and advances it with `vi.advanceTimersByTimeAsync(...)`. Node fires a timer callback a fraction of a millisecond before `Date.now()` agrees it should, and more often when the machine is busy, so a stopwatch measures 19ms for a correct 20ms backoff and fails a scheduler that is right. Virtual time pins the delay exactly — `toBe(20)`, not a lower bound a runaway delay would satisfy too — and an `afterEach` restoring `vi.useRealTimers()` keeps a failed assertion from leaking a frozen clock into the file that runs next. Never sleep to conclude that nothing happened.

A virtual clock also reaches assertions a real one cannot: `vi.getTimerCount()` proves a shutdown actually cleared its timers, which no observable behavior reveals once a stopped queue is already swallowing whatever a leaked timer enqueues.

This is scoped to timer behavior. A test that waits on real work — a database round trip, a spawned process — gains nothing from a frozen clock and can hang under one.

### Boundary derivations

Every derivation with a window boundary — a silence window, a catch-up cutoff, a digest window — gets a test asserting behavior on both exact sides of the boundary: one instant just inside, one just outside. A bucketed assertion (within ±N minutes) cannot catch an off-by-one on the boundary itself, which is where these derivations break.

## End-to-end specs

E2E specs live in `tests/` and drive the product exactly as the owner's assistant does.

Each spec:

1. seeds the store by feeding a **scripted fake gateway feed** through the real ingestion business functions — no network, no live Discord;
2. spawns the **real MCP server** over stdio through the harness in `tests/mcp-client.ts`;
3. drives it with the real MCP SDK client, calling tools and asserting on their results.

Discord REST calls made by `messages_send` go through an injected transport double that records every request, so a spec asserts what would have been sent without sending it.

`pnpm run test:e2e` runs `tests/run-e2e.ts`, which executes the specs and then the tool coverage gate.

### Spec conventions

- **One `test()` per file.** Several assertions inside it are fine; the limit is on `test()` calls.
- **The filename is the behavior sentence**, kebab-cased: `tests/a-bookmarked-message-survives-the-authors-edit.spec.ts`, `tests/catch-up-skips-channels-the-bot-cannot-read.spec.ts`. Never an area name like `bookmarks.spec.ts`.
- A spec never writes raw SQL and never reads the database directly. It seeds through the fake feed and observes through the MCP client — that is what makes the spec a statement about the product rather than about the schema.
- A spec never reads `process.env`. Everything it needs comes from the harness and the seed's exported fixtures.
- Assert the values the seed produced and exported, never a string the spec restates. That is how a seed and its specs drift apart.
- Absence is an explicit empty-length assertion on the scoped result, not a negated truthiness check.
- Never assert an exact total on a listing other specs also write into. Scope the assertion to the entity the spec is about.
- Prove persistence by round trip: perform the change, then re-read through a fresh tool call and assert the durable state.
- Renaming or removing owner-facing copy means grepping all of `tests/` for the old string — specs and the seed both carry product copy verbatim.

### The tool coverage gate

Coverage is measured from real traffic, never asserted. The runner records every tool name the suite actually calls, and `tests/coverage/gate.ts` fails when a registered tool was never called.

Two registries sit beside it, with the same discipline:

- **Pending** — tools no spec reaches yet. The list only ever shrinks: the gate fails the moment a spec reaches a parked tool, so the entry comes out in that same PR. A new tool lands here in the PR that adds it, unless a spec already reaches it.
- **Exclusions** — a tool is excluded only with a written rationale citing the unit test that owns the behavior end to end, or proof the tool is unreachable from the product. "No spec yet" is not a rationale; that is pending.

The gate fails on a stale entry too — a pending or excluded entry naming a tool that no longer exists, or a tool listed in both registries. It enforces only on a full run: a filtered run cannot know what the rest of the suite would have reached, so it drops to reporting.

### Sibling readers are enumerated, never assumed

`messages_catch_up` and `mentions_list` read through one shared query builder, and `bookmarks_list` repeats its shape, so a per-message field added for one reader arrives on all three at once and is pinned by none of them. The gate above cannot see that: it proves `mentions_list` was called, never that anything read the new field back. When a reader gains a field, enumerate every reader that now returns it and give each one a unit assertion and an E2E assertion in the same commit, including the spec's local response type. The test to write is the one that would fail if the field were dropped from that reader alone; without it the field is undefined behavior on that surface, however well its siblings are covered.

### The E2E seed

`tests/seed/` holds the seed and the fake gateway feed, a thin orchestrator over one module per journey. Every run builds a fresh store: the runner deletes the E2E database file, migrates, seeds, and only then starts the suite. There is no long-lived E2E database and no convergence machinery — a fresh file per run is what SQLite makes cheap, and it removes the whole class of stale-state drift a surviving store accumulates.

Seed rules:

- The seed writes through the real ingestion business functions — the feed is a scripted sequence of gateway events — so seeding exercises the same code paths production ingestion does. Raw inserts in the seed are banned.
- A prerequisite lookup throws naming the missing key rather than falling back to a default.
- Specs share the one seeded store within a run, so a spec never asserts an exact count on a surface other specs also write into — scope assertions to rows the spec created or the seed exported through fixtures.

### Env parity

Anything a run depends on goes in three places, in the same change: `.env.example` (the documented contract), the workflow-level `env:` block in `.github/workflows/ci.yml` (CI has no `.env`, so a variable added only locally passes here and fails on the PR), and `serverEnvironment` in `tests/mcp-client.ts` — the E2E harness hardcodes the environment it spawns the server with, so a variable the server now requires must land there too or every spec dies at server startup.

### Repeat safety

A retried spec reruns against the same per-run store, so a spec is correct only when it passes against the state its previous attempt — including one that died partway — left behind. Cleanup at the end of a spec is never the answer: the attempt that dies never reaches it. Give attempt-unique identity to anything a spec creates, and prove retry safety rather than assume it — and know what each proof proves. Running the spec twice in a row (`--repeat=2`) only proves the happy path repeats; it never exercises a half-finished attempt. The full ritual: run a throwaway copy of the spec that dies partway through its writes, then run the real spec against that residue and watch it pass. Pair it with a negative control — strip the attempt-unique identity and watch the same construction fail — because without a control, a passing run proves nothing about what the spec would actually survive.

### Clock doctrine

- One rolling anchor, computed once in SQL off `strftime('%Y-%m-%dT%H:%M:%fZ','now')`, exported through fixtures.
- No `Date.now()` in the seed, and no absolute date in a spec. A hardcoded `'2027-06-01'` silently becomes a past date once the wall clock passes it, flipping every window-derived reading.
- Timestamps cross the MCP boundary as ISO strings; a spec asserts the fixture's value, never a restated or reformatted one.
- Seeded history must not backdate rows relative to configuration created moments earlier — on a fresh store that inverts the causal order the product assumes.

### Flakes

Never mask a flake with a wait, a retry, or a weakened assertion. A spec that fails intermittently is a likely product bug until investigated. Wait on a deterministic signal — the tool call's own result, a recorded transport request, an event row the fake feed's handler appended — never on elapsed time.

## The dev-seed coverage gate

`pnpm run test:seed-coverage` runs `tests/seed-coverage/run.ts`: it builds a fresh store by spawning the real migrator and the real dev seed as child processes — exactly what a self-hoster runs — then calls each tool's underlying business function with the real `ownerContext()` against that store. The coverage map lives in `tests/seed-coverage/demonstrations.ts`.

Every registered tool is either **demonstrated** — its entry proves a demo-meaningful answer, never merely a non-crash — or listed in **`declaredUnseedable`** with an honest reason, which only a capability that cannot answer without live Discord earns. Exhaustiveness is two-sided: the `Record<Exclude<ToolName, UnseedableTool>, SeedDemonstration>` type fails `tsc` when a tool joins `ToolName` without a demonstration, and a runtime reconciliation against `registeredTools` fails the run when the registry and `ToolName` disagree in either direction.

So a new or changed capability ships its seed state in the same PR (Definition of Done criterion 9): extend `app/db/dev-seed/seed.ts` through the real business functions until the demonstration passes, or argue the unseedable entry. Write demonstrations that would fail against a store missing their state, and mutation-prove them by removing that seed state and watching the gate name the hole. All demonstrations share one seeded store and run in the map's insertion order, read-only entries before mutating ones — keep that order when adding entries.
