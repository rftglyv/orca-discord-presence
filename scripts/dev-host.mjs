// Runs the plugin outside Orca against the local Discord client, with a fake
// host (in-memory settings and storage) and three fake agents cycling through
// working / blocked / done. Opens the settings page on start.
// Usage: npm run build && node scripts/dev-host.mjs [minutes]
import activate, { deactivate } from '../dist/main.mjs'

const minutes = Number(process.argv[2] ?? 10)
const settings = {}
const storage = new Map()
const commands = new Map()
const handlers = new Map()

const orca = {
  grantedCapabilities: ['workspace:read', 'events:subscribe', 'storage', 'settings:own', 'notifications:show'],
  commands: { register: (id, handler) => commands.set(id, handler) },
  events: { on: (name, handler) => handlers.set(name, handler) },
  host: {
    async call(method, params) {
      switch (method) {
        case 'settings.get':
          return { settings }
        case 'settings.set':
          settings[params.key] = params.value
          return { ok: true }
        case 'storage.get':
          return { value: storage.get(params.key) ?? null }
        case 'storage.set':
          storage.set(params.key, params.value)
          return { ok: true }
        case 'storage.delete':
          storage.delete(params.key)
          return { ok: true }
        case 'workspace.readContext':
          return { displayName: 'orca-dc-rpc', branch: 'feat/settings-page', terminals: [] }
        case 'notifications.show':
          console.log(`[notify] ${params.title}: ${params.body ?? ''}`)
          return { delivered: true }
        default:
          throw new Error(`unexpected host method: ${method}`)
      }
    }
  },
  log: (line) => console.log(`[plugin] ${line}`)
}

activate(orca)
const emit = (paneKey, state) =>
  handlers.get('agent.status.changed')?.({
    worktreeId: 'w1',
    paneKey,
    state,
    receivedAt: Date.now(),
    mainAgent: { state, stateStartedAt: Date.now() }
  })

// A little life on the card: agents start, one blocks on a prompt, one finishes.
const script = [
  ['a', 'working'],
  ['b', 'working'],
  ['c', 'blocked'],
  ['a', 'done'],
  ['c', 'working'],
  ['b', 'done'],
  ['a', 'working']
]
let step = 0
emit('a', 'working')
const timer = setInterval(() => {
  const [pane, state] = script[step % script.length]
  emit(pane, state)
  step += 1
}, 40_000)

setTimeout(async () => {
  const opened = await commands.get('presence.settings')()
  console.log(`settings: ${opened.url}`)
}, 1500)

setTimeout(async () => {
  clearInterval(timer)
  await deactivate()
  process.exit(0)
}, minutes * 60_000)
