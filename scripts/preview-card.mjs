// Publishes a sample card to the local Discord client, so the artwork and
// layout can be checked without running agents in Orca.
// Usage: npm run build && node scripts/preview-card.mjs [working|waiting|idle] [seconds]
import { DEFAULT_CLIENT_ID } from '../dist/main.mjs'
import { DiscordPresenceClient } from '../dist/lib/discord-ipc.mjs'
import { applyAgentStatus, buildActivity, createPresenceState } from '../dist/lib/presence-model.mjs'

const SCENARIOS = {
  working: ['working', 'working', 'done'],
  waiting: ['working', 'blocked', 'done'],
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
  applyAgentStatus(state, { paneKey: `p${index}`, worktreeId: 'w1', state: paneState, receivedAt: Date.now() })
})
const activity = buildActivity({
  state,
  focus: null,
  privacy: 'minimal',
  startedAt: scenario === 'idle' ? 0 : Date.now() - 754_000,
  partyId: 'preview'
})

const client = new DiscordPresenceClient({ clientId: DEFAULT_CLIENT_ID })
await client.connect()
await client.setActivity(activity)
console.log(`showing "${scenario}" for ${seconds}s:`, activity.state, '/', activity.assets?.small_image)
await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
client.close()
