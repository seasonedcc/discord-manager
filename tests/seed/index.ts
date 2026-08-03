import { ownerContext } from '~/business/auth.server'
import { aChannelLeavesTheBotsView } from './a-channel-leaves-the-bots-view'
import { aQuestionGetsAnsweredWithAReaction } from './a-question-gets-answered-with-a-reaction'
import { aThreadArchivesWhileTheBotIsAway } from './a-thread-archives-while-the-bot-is-away'
import { aWorkdayOfConversation } from './a-workday-of-conversation'
import { anAlertArrivesAsAnEmbed } from './an-alert-arrives-as-an-embed'
import { readClock } from './clock'
import { feed } from './feed'
import { historyArrivesThroughABackfill } from './history-arrives-through-a-backfill'
import { theBotPostsAndSomebodyAnswers } from './the-bot-posts-and-somebody-answers'
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
  const bot = feed.member({
    displayName: 'Robin Manager',
    username: 'robin-manager',
  })
  const members = {
    maya: feed.member({ displayName: 'Maya Fischer', username: 'maya' }),
    omar: feed.member({ displayName: 'Omar Duarte', username: 'omar' }),
    priya: feed.member({ displayName: 'Priya Raman', username: 'priya' }),
    uptime: feed.member({
      displayName: 'Uptime Watch',
      username: 'uptime-watch',
    }),
  }

  const { announcements, engineering, lobby, releaseThread } =
    await theTeamServerComesOnline({ bot })
  const { retiredStandup } = await aChannelLeavesTheBotsView()
  const channels = { announcements, engineering }
  const backfill = await historyArrivesThroughABackfill({
    channels,
    clock,
    members,
    owner,
  })
  const messages = await aWorkdayOfConversation({
    channels,
    clock,
    members,
    owner,
  })
  const alert = await anAlertArrivesAsAnEmbed({
    channels,
    clock,
    members,
    owner,
  })
  const botAnswers = await theBotPostsAndSomebodyAnswers({
    bot,
    channels,
    clock,
    members,
    owner,
  })
  const reactions = await aQuestionGetsAnsweredWithAReaction({
    channels,
    clock,
    members,
    owner,
  })
  const bookmarks = await theOwnerBookmarksAMessage({
    alert: alert.message,
    members,
    messages,
    owner,
  })
  const archiving = await aThreadArchivesWhileTheBotIsAway({
    channels: { ...channels, releaseThread },
    clock,
    members,
  })

  return {
    alert,
    archiving,
    backfill,
    bookmarks,
    bot,
    botAnswers,
    channels: {
      ...channels,
      hotfixThread: archiving.hotfixThread,
      lobby,
      releaseThread,
      retiredStandup,
    },
    clock,
    guild,
    members,
    messages,
    owner,
    reactions,
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
