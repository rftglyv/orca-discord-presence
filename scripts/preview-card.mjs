// Publishes a sample card to the local Discord client, so the artwork and
// layout can be checked without running agents in Orca.
// Usage: npm run build && node scripts/preview-card.mjs [working|waiting|idle|stats] [seconds]
import { DEFAULT_CLIENT_ID } from '../dist/main.mjs'
import { DiscordPresenceClient } from '../dist/lib/discord-ipc.mjs'
import { applyAgentStatus, buildActivity, createPresenceState } from '../dist/lib/presence-model.mjs'
import { DEFAULT_TAGLINES } from '../dist/lib/taglines.mjs'

const SCENARIOS = {
  working: ['working', 'working', 'done'],
  waiting: ['working', 'blocked', 'done'],
  stats: ['working', 'done'],
  idle: ['done', 'done']
}

const scenario = process.argv[2] ?? 'working'
const seconds = Number(process.argv[3] ?? 60)
const panes = SCENARIOS[scenario]
if (!panes) {
  console.error(`unknown scenario "${scenario}"; pick one of ${Object.keys(SCENARIOS).join(', ')}`)
  process.exit(1)
}

const state = createPresenceState()
panes.forEach((paneState, index) => {
  applyAgentStatus(state, {
    paneKey: `p${index}`,
    worktreeId: 'w1',
    state: paneState,
    receivedAt: Date.now(),
    mainAgent: { state: paneState, stateStartedAt: Date.now() - (index + 3) * 60_000 }
  })
})
const activity = buildActivity({
  state,
  focus: null,
  privacy: 'minimal',
  startedAt: scenario === 'idle' ? 0 : Date.now() - 754_000,
  partyId: 'preview',
  tagline: DEFAULT_TAGLINES[Math.floor(Math.random() * DEFAULT_TAGLINES.length)],
  stateLine: scenario === 'stats' ? 'Today: 14 tasks done · 3h 40m agent time' : undefined
})

const client = new DiscordPresenceClient({ clientId: DEFAULT_CLIENT_ID })
await client.connect()
await client.setActivity(activity)
console.log(`showing "${scenario}" for ${seconds}s:`, activity.details, '|', activity.state, '/', activity.assets?.small_image)
await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
client.close()
