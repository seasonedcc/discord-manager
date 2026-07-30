import { makeDb } from '~/framework/db.server'
import type { DB } from './types'

const db = makeDb<DB>()

export { db }
