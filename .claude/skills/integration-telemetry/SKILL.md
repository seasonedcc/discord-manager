---
name: integration-telemetry
description: The standard every Discord API operation follows — request and outcome events in the domain's own append-only tables, status derived in SQL behind a named silence window, exhaustive mapped copy with a concrete next action, and no raw vendor text at the owner-facing boundary. Use when adding or changing any Discord call — a message send, a REST backfill, a gateway connection or reconnect, or a health reading — or when adding a skip or failure reason.
---

# Integration telemetry

Everything here documents the repository as it is on `main`. If `main` disagrees with this file, `main` wins: follow it and flag the drift.

Every call this product makes to Discord is recorded, and every reading the owner sees is derived from those records. This is the standard those operations follow. Read the canonical implementations too — `app/business/sending.server.ts` and `app/business/ingestion.server.ts` write these families, and `app/business/ingestion-status.server.ts` derives the readings — the code is the standard; this file is the rules it follows.

Three families exist today, each with its own tables:

- `message_send_requests` / `message_send_deliveries` / `message_send_failures` / `message_send_skips` — sends issued through MCP
- `backfill_runs` / `backfill_run_progress` / `backfill_run_completions` / `backfill_run_failures` — REST history backfills and gap sweeps
- `gateway_connections` / `gateway_disconnections` — the daemon's link to Discord

## Each operation owns its own tables

A new operation ships its own append-only tables — one request table plus one table per outcome — and its own reason vocabulary. Never build a generalized telemetry framework and never share a reason vocabulary across families: a shared vocabulary forces every operation to speak in the widest set of reasons any one of them needs, and a reason that cannot happen in this family would still typecheck in it.

Reasons are `text` columns with a check constraint listing the family's own values, paired with a TypeScript union in the domain's `.common.ts`. Load `database-design` and `kysely` before writing the migration.

Never widen an existing reason to cover a new case. A case the current reasons do not name gets its own reason, its own copy, and its own ruling on guidance.

## Every path records exactly one outcome

Delivered, failed, and skipped are three different things, and skipped is never success. A send that never went out because the bot cannot post in the target channel records a skip with the reason that stopped it, not silence and not a delivery.

Every exit from an operation body reaches exactly one recorded row. A vendor call sits in a `try` that records the failure and rethrows when a retry could still help; a failure no retry can help records and returns instead. An error that leaves a request with no outcome row is a defect, not a missing log line — the owner's reading would call it pending forever until the silence window turns that into a lie.

A skip pre-refuses a call only on facts the store can prove under Discord rules that are actually documented. Where Discord's behavior is undocumented — whether a message whose deleted thread can take a new one, say — send the call and let the mapped failure answer honestly: a wrong local refusal blocks an operation the vendor would have allowed, while a wrong optimistic call costs one request and still comes back as mapped guidance. And when more than one skip reason holds at once, record the one whose next action gives the owner the most — a message that is both deleted and already threaded skips as `thread_already_exists`, because "post into it" beats "pick another message".

## Status is derived in SQL, never stored

Union the outcome tables into one `requestId, createdAt, id, outcome` shape, rank with `row_number() over (partition by request_id order by created_at desc, id desc)` and keep rank 1 — the `id desc` tie-break stops a repeated read from flipping between two answers — then `coalesce` that outcome with a `case` over the request's own age:

```sql
coalesce(
  outcome.outcome,
  case
    when request.created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-' || :stallMinutes || ' minutes')
    then 'stalled'
    else 'pending'
  end
)
```

A request with no outcome must never read as running forever: without the stall arm, the reading promises work that stopped. The same shape covers a backfill whose newest progress row has gone quiet, and any future family with a request/outcome pair.

## The silence window is a named constant

The cutoff is a named constant in the domain's `.common.ts` — never an interval inlined into a query — and one number serves every reading that speaks about that operation. `gateway` activity reads `receiving`, `quiet`, or `never` against its own named silence threshold; sends and backfills each own theirs. Where the length is not evident from the name, a comment beside it says why that long means "nothing is still working on this".

The window has to outlast everything that could legitimately still be working on the request, including every retry the scheduler will perform. A window shorter than the operation's own retry span makes "nothing is retrying it" false while the work is still in flight. When an operation's retry behavior changes, its window is re-derived in the same change.

The cap is enforced, not assumed: every Discord-calling job declares an explicit `maxAttempts`, and the registry test in `app/business/jobs.server.test.ts` both caps it and sums each job's whole backoff span to prove the retry chain finishes inside the stall window. That arithmetic is the point — a runner's default retry policy can keep retrying long past any window in this codebase, and the window's meaning holds only while the cap does.

## What the owner reads

Copy is observation, never conclusion. Write every summary as a statement the recorded events can prove, and every next action as safe under **all** causes the reason covers. "The bot is connected" requires a liveness event no crash can suppress — a connection row only proves the bot *was* connected. "Send it again" is wrong wherever the outcome is unrecorded, because the unrecorded case includes success and the advice double-posts. A next action that names a thing ("that channel") the reading does not identify is unactionable — surface the identifier or reword to what the reader can actually do.

Owner-facing readings render mapped copy only. Never a Discord error message, an exception, a stack trace, or a request id. Pin it with a serialization assertion on the status reader:

```typescript
expect(JSON.stringify(status)).not.toContain('errorMessage')
```

Each reason gets a summary and a concrete next action, typed exhaustively in the domain's `.common.ts` so a new reason cannot compile without a ruling:

```typescript
const messageSendSkipCopy = {
  channel_not_writable: {
    summary: 'The bot cannot post in that channel.',
    nextAction: 'Grant the bot Send Messages there, then send again.',
  },
  // ...
} satisfies Record<MessageSendSkipReason, MessageSendGuidance>
```

Sibling `...FailureCopy` and `...StallCopy` maps cover the two outcomes that have no reason column. A next action names something the owner can actually do — a permission to grant, a setting to change, a command to re-run — never "try again later" alone.

Failure kinds come from the vendor's own documented error codes for the operation, not from a taxonomy copied off a sibling family. Before settling the kinds, read the codes Discord documents for this endpoint and give every cause whose remedy differs its own kind keyed on its code — the way `gone` keys on `Unknown Message` and a thread create's `thread_already_exists` keys on `Thread already created for this message` — because whatever stays inside the catch-all `rejected` shares one next action, and that action must be safe under every cause left in it.

Raw Discord text may be recorded on the failure row, because what the vendor said is a fact worth keeping. It never leaves the store: no tool result and no derived reading reads that column.

## Progress, activity, and honest denominators

A progress reading needs a true denominator. A backfill has one — each channel's run records a synced count against a real total in `backfill_run_progress` as it walks — so it reports progress. A fan-out with a countable set of requests states counts instead, one filtered aggregate per reading:

```typescript
.select((eb) => eb.fn.count<number>('id').filterWhere('outcome', '=', 'delivered').as('delivered'))
```

Roll those counts up worst-first — failed, then stalled, skipped, pending, delivered — into the single reading the owner sees. An operation with no denominator gets no progress reading and no invented one.

A stream the product only receives from gets an honest last-seen instead: the gateway reading is `receiving`, `quiet`, or `never`, derived from the newest `gateway_connections` / `gateway_disconnections` events against the named threshold.

## Retry only what is safe to re-run

Offer a retry only when another attempt could do something different — and only when the recorded outcome proves the last attempt put nothing in front of the vendor. A failure the vendor itself rejected is worth repeating; a skip is worth repeating only when the condition that caused it can have changed. An unknown outcome is never safely repeatable: a stalled request, or a failure where the vendor never answered, includes the case where the attempt succeeded, and the repeat performs it twice. The same reading extends over the request's own retries — while any retry of a request might itself have gone through, the request is not retryable.

The predicate is shared between the reader and the writer: one function decides it for both call sites, the status reader returns it as `canRetry`, and the re-send function re-checks it inside the transaction that records the new attempt and throws an `InputError` naming where the last attempt stands. Never let the reading and the action disagree.

## Seeding telemetry rows

One date scheme per seed section, chosen by what the section is read for. A section read for recency is entirely `now`-relative, with offsets picked so every derived reading stays constant on any seed day — permanently past a silence window, or permanently inside it. Rows that participate in an ordering, or whose derived status compares against a `now` window, get fixed past timestamps placed far enough back that neither the order nor the status can change. Never mix the two schemes within one section.

Before seeding a completion, check what it takes off the owner's health reading: a family seeded fully settled shows nothing about the state a real deployment spends most of its time in.

## Already covered elsewhere

The Definition of Done in the architecture document governs the rest and is not repeated here: the dev-seed section for a new surface, the MCP tool for any new capability, and the end-to-end spec plus tool coverage gate for any changed behavior.
