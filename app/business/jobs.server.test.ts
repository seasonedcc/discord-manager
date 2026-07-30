import { describe, expect, it } from '~/test/prelude'
import { backfillStallThresholdMinutes } from './ingestion.common'
import { jobs } from './jobs.server'

const maximumAttemptsPerJob = 5

function retrySpanMs({
  maxAttempts,
  retryDelayMs,
}: {
  maxAttempts: number
  retryDelayMs: number
}) {
  return Array.from({ length: maxAttempts - 1 }).reduce<number>(
    (span, _step, index) => span + retryDelayMs * 2 ** index,
    0
  )
}

describe('jobs', () => {
  it('registers the jobs that reach Discord', () => {
    expect(jobs.map((job) => job.jobName)).toEqual([
      'backfillChannel',
      'backfillIngestedChannels',
    ])
  })

  it('caps every job that calls Discord at five attempts', () => {
    for (const job of jobs) {
      expect(job.maxAttempts).toBeLessThanOrEqual(maximumAttemptsPerJob)
    }
  })

  it('finishes every retry chain well inside the backfill stall window', () => {
    for (const job of jobs) {
      expect(retrySpanMs(job)).toBeLessThan(
        backfillStallThresholdMinutes * 60_000
      )
    }
  })
})
