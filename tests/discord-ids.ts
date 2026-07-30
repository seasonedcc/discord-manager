import { randomInt } from 'node:crypto'

const runPrefix = String(randomInt(100_000, 999_999))

let issuedIds = 0

function nextDiscordId() {
  issuedIds += 1

  return `${runPrefix}${String(issuedIds).padStart(12, '0')}`
}

export { nextDiscordId }
