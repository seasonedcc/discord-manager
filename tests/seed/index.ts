import { ownerContext } from '~/business/auth.server'
import { aChannelLeavesTheBotsView } from './a-channel-leaves-the-bots-view'
import { aWorkdayOfConversation } from './a-workday-of-conversation'
import { readClock } from './clock'
import { feed } from './feed'
import { historyArrivesThroughABackfill } from './history-arrives-through-a-backfill'
import { theOwnerBookmarksAMessage } from './the-owner-bookmarks-a-message'
import { theTeamServerComesOnline } from './the-team-server-comes-online'

async function feedEveryJourney() {
  const clock = await readClock()
  const owner = {
    discordUserId: ownerContext().owner.discordUserId,
    displayName: 'Robin Vega',
    username: 'robin',
  }
  const guild = { discordGuildId: ownerContext().owner.guildId }
  const members = {
    maya: feed.member({ displayName: 'Maya Fischer', username: 'maya' }),
    omar: feed.member({ displayName: 'Omar Duarte', username: 'omar' }),
    priya: feed.member({ displayName: 'Priya Raman', username: 'priya' }),
  }

  const { announcements, engineering, lobby, releaseThread } =
    await theTeamServerComesOnline()
  const { retiredStandup } = await aChannelLeavesTheBotsView()
  const channels = { announcements, engineering }
  const backfill = await historyArrivesThroughABackfill({
    channels,
    clock,
    members,
  })
  const messages = await aWorkdayOfConversation({
    channels,
    clock,
    members,
    owner,
  })
  const bookmarks = await theOwnerBookmarksAMessage({
    members,
    messages,
    owner,
  })

  return {
    backfill,
    bookmarks,
    channels: { ...channels, lobby, releaseThread, retiredStandup },
    clock,
    guild,
    members,
    messages,
    owner,
  }
}

type Fixtures = Awaited<ReturnType<typeof feedEveryJourney>>

let seeded: Fixtures | undefined

async function seedTheStore() {
  seeded = await feedEveryJourney()

  return seeded
}

function fixtures() {
  if (!seeded) {
    throw new Error(
      'Nothing seeded the E2E store yet — tests/run-e2e.ts seeds it before the specs run'
    )
  }

  return seeded
}

export { fixtures, seedTheStore }
