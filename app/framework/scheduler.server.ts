import { getOrSetGlobal } from './globals'

type JobRun<Payload> = (payload: Payload) => Promise<void>

type JobOptions = {
  dedupe?: boolean
  maxAttempts?: number
  retryDelayMs?: number
}

type Job<Payload> = {
  dedupe: boolean
  enqueue: (payload: Payload) => void
  jobName: string
  maxAttempts: number
  retryDelayMs: number
  run: JobRun<Payload>
}

type CronJob<Payload> = Job<Payload> & {
  intervalMs: number
  tick: () => void
}

type RegisteredJob = {
  intervalMs?: number
  jobName: string
  maxAttempts: number
  retryDelayMs: number
  tick?: () => void
}

type QueuedTask = {
  attempt: number
  dedupe: boolean
  invoke: () => Promise<void>
  jobName: string
  maxAttempts: number
  retryDelayMs: number
}

const defaultMaxAttempts = 5
const defaultRetryDelayMs = 250

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function createSchedulerQueue() {
  const pending: QueuedTask[] = []
  let started = false
  let draining = false
  let drainPromise = Promise.resolve()

  async function drain() {
    try {
      while (started && pending.length > 0) {
        const task = pending.shift()
        if (!task) break

        try {
          await task.invoke()
        } catch (error) {
          if (task.attempt >= task.maxAttempts) {
            console.error(
              `Job "${task.jobName}" gave up after ${task.attempt} attempts`,
              error
            )
            continue
          }

          await wait(task.retryDelayMs * 2 ** (task.attempt - 1))
          pending.push({ ...task, attempt: task.attempt + 1 })
        }
      }
    } finally {
      draining = false
    }
  }

  function kick() {
    if (!started || draining) return

    draining = true
    drainPromise = drain()
  }

  return {
    enqueue(task: Omit<QueuedTask, 'attempt'>) {
      const waiting = pending.some(({ jobName }) => jobName === task.jobName)

      if (task.dedupe && waiting) return

      pending.push({ ...task, attempt: 1 })
      kick()
    },
    start() {
      started = true
      kick()
    },
    async stop() {
      started = false
      await drainPromise
    },
  }
}

const schedulerQueue = () =>
  getOrSetGlobal('schedulerQueue', createSchedulerQueue)

function makeJob<Payload>(
  jobName: string,
  run: JobRun<Payload>,
  options: JobOptions = {}
): Job<Payload> {
  const dedupe = options.dedupe ?? false
  const maxAttempts = options.maxAttempts ?? defaultMaxAttempts
  const retryDelayMs = options.retryDelayMs ?? defaultRetryDelayMs

  return {
    dedupe,
    enqueue: (payload) =>
      schedulerQueue().enqueue({
        dedupe,
        invoke: () => run(payload),
        jobName,
        maxAttempts,
        retryDelayMs,
      }),
    jobName,
    maxAttempts,
    retryDelayMs,
    run,
  }
}

function makeCronJob(
  jobName: string,
  intervalMs: number,
  run: () => Promise<void>,
  options: JobOptions = {}
): CronJob<void> {
  const job = makeJob<void>(jobName, run, options)

  return { ...job, intervalMs, tick: () => job.enqueue(undefined) }
}

function makeSchedulerRunner(jobs: RegisteredJob[]) {
  const timers: NodeJS.Timeout[] = []

  return {
    start() {
      const duplicated = jobs
        .map((job) => job.jobName)
        .filter((jobName, index, names) => names.indexOf(jobName) !== index)

      if (duplicated.length > 0) {
        throw new Error(
          `Two jobs are registered under the same name: ${duplicated.join(', ')}`
        )
      }

      schedulerQueue().start()

      for (const job of jobs) {
        if (job.intervalMs === undefined || !job.tick) continue

        timers.push(setInterval(job.tick, job.intervalMs))
      }
    },
    async stop() {
      for (const timer of timers) clearInterval(timer)
      timers.length = 0

      await schedulerQueue().stop()
    },
  }
}

export { makeCronJob, makeJob, makeSchedulerRunner }
export type { CronJob, Job, JobOptions, RegisteredJob }
