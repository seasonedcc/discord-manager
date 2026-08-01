---
name: background-jobs
description: Write background work against the in-process scheduler — makeJob and makeCronJob, registration in the jobs array, retries and dedupe, idempotency in an append-only store, fan-out, and the tests that prove each. Use when adding or changing a job, enqueuing work from business or ingest code, editing app/business/jobs.server.ts or app/framework/scheduler.server.ts, picking a retry or interval setting, or testing what a job runs and what it enqueues.
---

# Background jobs

Everything here documents the repository as it is on `main`. If `main` disagrees with this file, `main` wins: follow it and flag the drift.

There is no queue server, no worker process, and no jobs table. `app/framework/scheduler.server.ts` is the entire scheduler: one in-memory FIFO queue, one job running at a time, inside the ingest daemon. Jobs are declared next to the domain logic they drive in `app/business/`, listed in `app/business/jobs.server.ts`, and run by the one runner `app/ingest/run.ts` builds.

## The runtime, stated

Design against these facts, not against habits from a durable queue.

- **One queue, one job at a time.** `createSchedulerQueue` holds a `pending` array and a drain loop that `await`s each `invoke()` before shifting the next task. Two jobs never overlap, and a slow job holds everything behind it.
- **The queue is process-global**, held by `getOrSetGlobal('schedulerQueue', createSchedulerQueue)`. Every `makeJob` in the process shares it, registered or not.
- **Only the ingest daemon drains it.** `app/ingest/run.ts` is the sole caller of `makeSchedulerRunner(jobs)` and `scheduler.start()`. An `enqueue` on a path the MCP server reaches pushes onto a queue that process never starts, and the work simply waits forever.
- **Enqueueing before `start()` is fine** — tasks accumulate and run once the runner starts.
- **Nothing survives the process.** The queue is memory only. A task still waiting at shutdown is gone, and there is no dead-letter row to find it in later.
- **`makeCronJob` takes an interval in milliseconds**, not a cron expression: `start()` opens one `setInterval(job.tick, job.intervalMs)` per registered job that has both, and each tick enqueues the job with an `undefined` payload.
- **Retries are thrown-error only.** Defaults are `maxAttempts: 5` and `retryDelayMs: 250`; attempt *n* waits `retryDelayMs * 2 ** (n - 1)`. The wait happens **inside** the drain loop, so a backing-off job blocks every other job, and the retry re-enters at the **tail** of the queue.
- **The cap is a drop.** Past `maxAttempts` the loop writes `Job "<name>" gave up after N attempts` to `console.error` and moves on. Nothing else records that the work never happened.
- **`dedupe` collapses only what is still waiting.** With `{ dedupe: true }`, an enqueue is skipped when another task with the same job name is already in `pending`. The task currently running has been shifted off `pending`, so dedupe never suppresses an enqueue that arrives while an identical job is mid-flight. Default is `false`.
- **`stop()` is graceful.** It clears the interval timers, stops the loop from picking up new tasks, and awaits the job already running.

`makeSchedulerRunner(jobs).start()` throws `Two jobs are registered under the same name: …` before starting anything, so a job name is a real key.

## Naming

A job name starts with a verb, and the variable name and the name string are the same word:

```typescript
const backfillChannel = makeJob('backfillChannel', async ({ channelId }) => { … })
```

`channelBackfill` as a variable, or `'channel_backfill'` as the string, breaks the grep that connects a `console.error` from the drain loop to the code that produced it.

## Registration

Every `makeJob` and `makeCronJob` goes into the `jobs` array in `app/business/jobs.server.ts`:

```typescript
const jobs: RegisteredJob[] = [backfillChannel, backfillIngestedChannels]
```

Forgetting fails in two different ways, and one of them is silent.

An **unregistered `makeJob` still runs**. The drain loop never consults the array — it drains whatever was enqueued onto the process-global queue — so the only thing lost is the duplicate-name guard. Two jobs quietly sharing a name dedupe against each other and give up under one indistinguishable `console.error`.

An **unregistered `makeCronJob` never ticks**. Its timer is created from the array, so a job that is not in it has no timer: no error, no log line, nothing on the queue, and a green test suite. The registration test in `app/business/jobs.server.test.ts` asserts the exact list of registered job names for exactly this reason — extend it in the same change.

## Record the failure, then re-throw

The drain loop retries thrown errors and nothing else. A job that catches, records, and returns has told the scheduler the work succeeded: no retry, and a request that will read as pending until its silence window turns that into a lie (load `integration-telemetry` for the reading side).

`runChannelBackfill` in `app/business/ingestion.server.ts` is the shape:

```typescript
try {
  // fetch pages, store them, record progress
} catch (error) {
  await db()
    .insertInto('backfillRunFailures')
    .values({
      backfillRunId: run.id,
      errorMessage: error instanceof Error ? error.message : String(error),
      id: newId(),
    })
    .execute()

  throw error
}
```

The failure insert sits **outside** the transaction that stores the page. Inside it, the rollback that accompanies the error takes the failure row with it, and the attempt leaves no trace at all.

One trap belongs to this codebase specifically: a business function built with `applySchema` does not throw — it returns a failed `Result`. A job that calls it and ignores the result swallows every failure. Wrap the call in `fromSuccess`, which throws the collected errors, so the scheduler sees them:

```typescript
const backfillChannel = makeJob('backfillChannel', async ({ channelId, fetchChannelHistory }) => {
  await fromSuccess(runChannelBackfill)({ channelId, fetchChannelHistory }, ownerContext())
})
```

## Transactions, and enqueueing after the commit

`enqueue` is synchronous and calls the drain immediately. When the queue is started and idle, the child's body begins executing **inside that `enqueue` call**, before the enqueuing code reaches its next `await` — on the same `better-sqlite3` connection the caller is holding.

So enqueueing from inside an open transaction can start a child that reads the store before the parent's rows are committed, or that writes into a transaction it knows nothing about and that may still roll back. Return what the child needs from the transaction, and enqueue after it resolves:

```typescript
const run = await db().transaction().execute(async (trx) => { … })

backfillChannel.enqueue({ channelId: run.channelId, fetchChannelHistory })
```

Enqueueing from inside another job happens to be safe — the drain is already running, so the child waits its FIFO turn — but write it the same way regardless. The rule must not depend on who the caller is.

## Idempotency

Every job runs under the assumption that it will run again. Retries do it, and so does a daemon restart that re-triggers whatever enqueued the job in the first place.

In an append-only store the check is an event-existence check: the events already written say what has been done. `recordMessage` is the canonical form — insert with `onConflict(doNothing)`, and when nothing came back, read the existing row and return `already_ingested` instead of recording a second revision. `runChannelBackfill` shows the cursor variant: the newest message already stored *is* the resume point, so a retry re-fetches from where the last attempt stopped rather than from the beginning.

Never guard with a boolean column, and never derive "already done" from anything but the events.

## Payloads

Ids and the values the job cannot look up itself, nothing more. Type the payload inline:

```typescript
async ({ channelId, fetchChannelHistory }: { channelId: string; fetchChannelHistory: FetchChannelHistory }) => { … }
```

A field carried only so a log line can print it is a field that will drift from the row it was copied off.

## Fan-out

A discovery job finds the units of work and enqueues one child per unit; the child is idempotent for its own unit. The discovery job holds the queue for as long as its query takes and no longer, and one unit failing retries alone.

`backfillIngestedChannels` and `backfillChannel` in `app/business/ingestion.server.ts` are the worked example. The parent lists the channels the bot can still see and enqueues one `backfillChannel` per channel; it is declared `{ dedupe: true }` so a reconnect storm cannot stack sweeps behind each other. Its trigger today is a gateway event, not a clock: `handleGatewayConnected` in `app/ingest/gateway.server.ts` enqueues it after recording the connection and the channel snapshots. `makeCronJob` is the right parent instead when the trigger is genuinely a clock rather than something the daemon observed.

## When not to use the scheduler

The queue is single-threaded, so anything that must happen *on time* cannot share it. The daemon's liveness heartbeat runs on its own `setInterval` in `startGatewayHeartbeat` (`app/ingest/gateway.server.ts`) precisely because a long backfill would occupy the drain and silence the beat — and a silent beat reads as a dead daemon that is in fact working. `app/business/jobs.server.test.ts` pins that separation by asserting no registered job carries an `intervalMs`, and `gateway.server.test.ts` proves the heartbeat still records while a job holds the queue.

The same arithmetic binds the other direction: a job's whole retry chain must finish well inside the silence window of whatever reading watches its work. `jobs.server.test.ts` computes the chain from each job's own `maxAttempts` and `retryDelayMs` and compares it against `backfillStallThresholdMinutes`. Changing either setting means re-deriving that window in the same change.

## Testing

Load `testing` for the surrounding conventions, and its Virtual time section before asserting on anything a timer drives — backoff spacing, an interval firing, a `stop()` leaving no timer behind. Never sleep to conclude that nothing happened.

**The handler**: call `run` directly with the payload. There is no helpers argument; `JobRun<Payload>` takes the payload alone.

```typescript
await backfillIngestedChannels.run({ fetchChannelHistory: history.fetchChannelHistory })
```

**That something enqueues**: spy on the job's `enqueue`. It returns `void`, so stub it with an implementation, not a resolved value, and restore it afterwards.

```typescript
const enqueue = vi.spyOn(backfillChannel, 'enqueue').mockImplementation(() => {})

await backfillIngestedChannels.run({ fetchChannelHistory: history.fetchChannelHistory })

expect(enqueue).toHaveBeenCalledWith({ channelId: channel.id, fetchChannelHistory: history.fetchChannelHistory })
```

**That a failure is recorded and re-thrown**: assert both halves, because either one alone passes a broken job. A composable returns a failed `Result` rather than throwing, so assert on `result.success` and its errors; a plain job function is asserted with `rejects.toThrow`. Then read the failure table and assert exactly one row, and no completion row beside it — `records exactly one failure and lets the error reach the scheduler` in `app/business/ingestion.server.test.ts` is the model.

**Fan-out counts**: the same `enqueue` spy, asserted on the number of calls and on each payload.

**A job's settings are behavior.** `dedupe`, `maxAttempts`, and `retryDelayMs` are readable on the job object, and a test that asserts them says why the value is what it is — `asks the scheduler to keep only one waiting sweep`, not `has dedupe true`.
