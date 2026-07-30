import { describe, expect, it } from '~/test/prelude'
import { makeCronJob, makeJob, makeSchedulerRunner } from './scheduler.server'

function deferred() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })

  return { promise, resolve }
}

describe('makeJob', () => {
  it('describes itself with its name and its attempt cap', () => {
    const doNothing = makeJob('doNothing', async () => {})

    expect(doNothing.jobName).toBe('doNothing')
    expect(doNothing.maxAttempts).toBe(5)
  })

  it('runs an enqueued payload once the runner is started', async () => {
    const finished = deferred()
    const seen: string[] = []
    const collectPayload = makeJob(
      'collectPayload',
      async ({ value }: { value: string }) => {
        seen.push(value)
        finished.resolve()
      }
    )
    const runner = makeSchedulerRunner([collectPayload])

    collectPayload.enqueue({ value: 'enqueued before start' })
    runner.start()
    await finished.promise
    await runner.stop()

    expect(seen).toEqual(['enqueued before start'])
  })

  it('drains enqueued jobs one at a time', async () => {
    const finished = deferred()
    const events: string[] = []
    const recordEvent = makeJob(
      'recordEvent',
      async ({ value }: { value: string }) => {
        events.push(`start ${value}`)
        await new Promise((resolve) => setTimeout(resolve, 5))
        events.push(`end ${value}`)
        if (value === 'second') finished.resolve()
      }
    )
    const runner = makeSchedulerRunner([recordEvent])

    runner.start()
    recordEvent.enqueue({ value: 'first' })
    recordEvent.enqueue({ value: 'second' })
    await finished.promise
    await runner.stop()

    expect(events).toEqual([
      'start first',
      'end first',
      'start second',
      'end second',
    ])
  })

  it('retries a throwing job with a growing delay until it succeeds', async () => {
    const finished = deferred()
    const attemptsAt: number[] = []
    const failTwice = makeJob(
      'failTwice',
      async () => {
        attemptsAt.push(Date.now())
        if (attemptsAt.length < 3) throw new Error('Discord said no')
        finished.resolve()
      },
      { retryDelayMs: 10 }
    )
    const runner = makeSchedulerRunner([failTwice])

    runner.start()
    failTwice.enqueue(undefined)
    await finished.promise
    await runner.stop()

    expect(attemptsAt).toHaveLength(3)
    expect(attemptsAt[1] - attemptsAt[0]).toBeGreaterThanOrEqual(10)
    expect(attemptsAt[2] - attemptsAt[1]).toBeGreaterThanOrEqual(20)
  })

  it('skips a deduped enqueue while an identical one is still waiting', async () => {
    const finished = deferred()
    const seen: string[] = []
    const sweepOnce = makeJob(
      'sweepOnce',
      async ({ value }: { value: string }) => {
        seen.push(value)
        if (value === 'letting the queue drain') finished.resolve()
      },
      { dedupe: true }
    )
    const runner = makeSchedulerRunner([sweepOnce])

    sweepOnce.enqueue({ value: 'first' })
    sweepOnce.enqueue({ value: 'while the first still waits' })
    runner.start()
    sweepOnce.enqueue({ value: 'letting the queue drain' })
    await finished.promise
    await runner.stop()

    expect(seen).toEqual(['first', 'letting the queue drain'])
  })

  it('still enqueues a job that does not ask to be deduped', async () => {
    const finished = deferred()
    const seen: string[] = []
    const sweepAlways = makeJob(
      'sweepAlways',
      async ({ value }: { value: string }) => {
        seen.push(value)
        if (value === 'second') finished.resolve()
      }
    )
    const runner = makeSchedulerRunner([sweepAlways])

    sweepAlways.enqueue({ value: 'first' })
    sweepAlways.enqueue({ value: 'second' })
    runner.start()
    await finished.promise
    await runner.stop()

    expect(seen).toEqual(['first', 'second'])
  })

  it('stops retrying once the attempt cap is reached', async () => {
    let attempts = 0
    const failForever = makeJob(
      'failForever',
      async () => {
        attempts += 1
        throw new Error('Discord said no')
      },
      { maxAttempts: 2, retryDelayMs: 1 }
    )
    const runner = makeSchedulerRunner([failForever])

    runner.start()
    failForever.enqueue(undefined)
    await new Promise((resolve) => setTimeout(resolve, 60))
    await runner.stop()

    expect(attempts).toBe(2)
  })
})

describe('makeCronJob', () => {
  it('enqueues its work on every interval until the runner stops', async () => {
    const finished = deferred()
    let ticks = 0
    const sweepSomething = makeCronJob('sweepSomething', 5, async () => {
      ticks += 1
      if (ticks === 2) finished.resolve()
    })
    const runner = makeSchedulerRunner([sweepSomething])

    runner.start()
    await finished.promise
    await runner.stop()

    const ticksAtStop = ticks
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(ticksAtStop).toBeGreaterThanOrEqual(2)
    expect(ticks).toBe(ticksAtStop)
  })
})

describe('makeSchedulerRunner', () => {
  it('refuses to start when two jobs share a name', () => {
    const runner = makeSchedulerRunner([
      makeJob('doTheSameThing', async () => {}),
      makeJob('doTheSameThing', async () => {}),
    ])

    expect(() => runner.start()).toThrow(
      'Two jobs are registered under the same name: doTheSameThing'
    )
  })

  it('lets the running job finish before shutdown resolves', async () => {
    const started = deferred()
    let finishedWork = false
    const finishSlowly = makeJob('finishSlowly', async () => {
      started.resolve()
      await new Promise((resolve) => setTimeout(resolve, 20))
      finishedWork = true
    })
    const runner = makeSchedulerRunner([finishSlowly])

    runner.start()
    finishSlowly.enqueue(undefined)
    await started.promise
    await runner.stop()

    expect(finishedWork).toBe(true)
  })
})
