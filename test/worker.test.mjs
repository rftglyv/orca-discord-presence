/**
 * Drives `main.mjs` through a fake `orca` host — the same shape the real worker
 * runtime builds in `plugin-host-runtime.ts`. Discord is not running here, so
 * these also cover the path that matters most in practice: the plugin must stay
 * quiet and alive when there is nothing to connect to.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import activate, { deactivate, DEFAULT_CLIENT_ID } from '../dist/main.mjs'

function createFakeOrca({
  settings = {},
  capabilities,
  workspace = {
    branch: 'feat/presence',
    displayName: 'orca-discord-presence',
    terminals: []
  }
} = {}) {
  const storage = new Map()
  const calls = []
  const commands = new Map()
  const events = new Map()
  const logs = []
  const stored = { ...settings }
  let focusedWorkspace = workspace

  const orca = {
    grantedCapabilities: capabilities ?? [
      'workspace:read',
      'events:subscribe',
      'storage',
      'settings:own',
      'notifications:show'
    ],
    commands: { register: (id, handler) => commands.set(id, handler) },
    events: {
      on: (name, handler) => {
        const list = events.get(name) ?? []
        list.push(handler)
        events.set(name, list)
      }
    },
    host: {
      async call(method, params) {
        calls.push({ method, params })
        switch (method) {
          case 'settings.get':
            return { settings: stored }
          case 'settings.set':
            stored[params.key] = params.value
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
            return focusedWorkspace
          case 'notifications.show':
            return { delivered: true }
          default:
            throw new Error(`unexpected host method: ${method}`)
        }
      }
    },
    log: (line) => logs.push(line)
  }

  return {
    orca,
    calls,
    logs,
    storage,
    stored,
    emit: async (name, payload) => {
      for (const handler of events.get(name) ?? []) {
        await handler(payload)
      }
    },
    invoke: (id, args) => commands.get(id)?.(args),
    commandIds: () => [...commands.keys()],
    setWorkspace: (next) => {
      focusedWorkspace = next
    }
  }
}

/** Lets the runtime's own awaited chain settle without leaning on timers. */
const settle = () => new Promise((resolve) => setImmediate(resolve))

test('activate registers the manifest commands and event handlers', async () => {
  const fake = createFakeOrca()
  await activate(fake.orca)
  await settle()
  assert.deepEqual(fake.commandIds().sort(), [
    'presence.header',
    'presence.privacy',
    'presence.reconnect',
    'presence.status',
    'presence.toggle'
  ])
  await deactivate()
})

test('survives with Discord absent', async () => {
  const fake = createFakeOrca()
  await activate(fake.orca)
  await settle()
  await fake.emit('worktree.created', {
    worktreeId: 'w1',
    path: '/repos/app',
    branch: 'feat/presence'
  })
  await fake.emit('agent.status.changed', {
    worktreeId: 'w1',
    paneKey: 'p1',
    state: 'working',
    receivedAt: Date.now()
  })
  await settle()

  const status = await fake.invoke('presence.status')
  assert.equal(status.connected, false)
  assert.equal(status.summary.working, 1)
  await deactivate()
})

test('the shipped application id is a plausible Discord snowflake', () => {
  // 17-20 digits: Discord ids are 64-bit snowflakes rendered in decimal.
  assert.match(DEFAULT_CLIENT_ID, /^\d{17,20}$/)
})

test('the shipped application id is used when settings name none', async () => {
  const fake = createFakeOrca()
  await activate(fake.orca)
  await settle()
  const status = await fake.invoke('presence.status')
  assert.equal(status.usingDefaultApplication, true)
  await deactivate()
})

test('a configured client id overrides the shipped one', async () => {
  const fake = createFakeOrca({ settings: { clientId: '987654321098765432' } })
  await activate(fake.orca)
  await settle()
  const status = await fake.invoke('presence.status')
  assert.equal(status.usingDefaultApplication, false)
  await deactivate()
})

test('a blank client id falls back rather than disabling the plugin', async () => {
  const fake = createFakeOrca({ settings: { clientId: '   ' } })
  await activate(fake.orca)
  await settle()
  const status = await fake.invoke('presence.status')
  assert.equal(status.usingDefaultApplication, true)
  await deactivate()
})

test('the Orca logo and header need no configuration', async () => {
  const fake = createFakeOrca()
  await activate(fake.orca)
  await settle()
  const status = await fake.invoke('presence.status')
  assert.equal(status.header, 'Orca')
  assert.equal(status.largeImage, 'orca')
  await deactivate()
})

test('settings can rename the header and swap the artwork', async () => {
  const fake = createFakeOrca({ settings: { header: ' Fleet ', largeImage: 'my-art' } })
  await activate(fake.orca)
  await settle()
  const status = await fake.invoke('presence.status')
  assert.equal(status.header, 'Fleet')
  assert.equal(status.largeImage, 'my-art')
  await deactivate()
})

test('blank strings turn the header and the logo off', async () => {
  const fake = createFakeOrca({ settings: { header: '', largeImage: '' } })
  await activate(fake.orca)
  await settle()
  const status = await fake.invoke('presence.status')
  assert.equal(status.header, '')
  assert.equal(status.largeImage, '')
  await deactivate()
})

test('the header command takes a string argument and persists it', async () => {
  const fake = createFakeOrca()
  await activate(fake.orca)
  await settle()

  assert.deepEqual(await fake.invoke('presence.header', 'My Fleet'), {
    header: 'My Fleet',
    headerText: 'My Fleet'
  })
  assert.equal(fake.stored.header, 'My Fleet')

  // Object forms a host or keybinding might send.
  await fake.invoke('presence.header', { header: 'Squad' })
  assert.equal(fake.stored.header, 'Squad')
  await fake.invoke('presence.header', { value: 'Crew' })
  assert.equal(fake.stored.header, 'Crew')

  // An empty string is a value: it hides the header.
  const hidden = await fake.invoke('presence.header', '')
  assert.equal(hidden.header, '')
  assert.equal(fake.stored.header, '')
  await deactivate()
})

test('the header command cycles the presets when given no argument', async () => {
  const fake = createFakeOrca()
  await activate(fake.orca)
  await settle()

  assert.equal((await fake.invoke('presence.header')).header, '{workspace}')
  assert.equal((await fake.invoke('presence.header')).header, '{workspace} · {branch}')
  assert.equal((await fake.invoke('presence.header')).header, '')
  assert.equal((await fake.invoke('presence.header')).header, 'Orca')
  await deactivate()
})

test('a workspace header resolves at full privacy and masks at minimal', async () => {
  const fake = createFakeOrca({ settings: { privacy: 'full', header: '{workspace} · {branch}' } })
  await activate(fake.orca)
  await settle()

  const full = await fake.invoke('presence.status')
  assert.equal(full.header, '{workspace} · {branch}')
  assert.equal(full.headerText, 'orca-discord-presence · feat/presence')

  // full → minimal: the template stays, its resolved names do not.
  await fake.invoke('presence.privacy')
  const masked = await fake.invoke('presence.status')
  assert.equal(masked.privacy, 'minimal')
  assert.equal(masked.header, '{workspace} · {branch}')
  assert.equal(masked.headerText, 'Orca')
  await deactivate()
})

test('status refreshes a changed focused workspace immediately', async () => {
  const fake = createFakeOrca({
    settings: { privacy: 'full', header: '{workspace} · {branch}' },
    workspace: { displayName: 'api', branch: 'main', terminals: [] }
  })
  await activate(fake.orca)
  await settle()

  assert.equal((await fake.invoke('presence.status')).headerText, 'api · main')
  fake.setWorkspace({ displayName: 'web', branch: 'feat/navigation', terminals: [{ id: 't1' }] })
  assert.equal((await fake.invoke('presence.status')).headerText, 'web · feat/navigation')
  await deactivate()
})

test('agent state is persisted so a reaped worker can rehydrate', async () => {
  const first = createFakeOrca()
  await activate(first.orca)
  await settle()
  await first.emit('agent.status.changed', {
    worktreeId: 'w1',
    paneKey: 'p1',
    state: 'blocked',
    receivedAt: Date.now()
  })
  await settle()
  await deactivate()

  const persisted = first.storage.get('presence-state')
  assert.ok(persisted, 'expected state in storage')

  // Simulate the re-fork: a fresh host whose storage already holds the state.
  const second = createFakeOrca()
  second.storage.set('presence-state', persisted)
  await activate(second.orca)
  await settle()
  const status = await second.invoke('presence.status')
  assert.equal(status.summary.blocked, 1)
  await deactivate()
})

test('toggle and privacy commands persist their settings', async () => {
  const fake = createFakeOrca()
  await activate(fake.orca)
  await settle()

  assert.deepEqual(await fake.invoke('presence.toggle'), { enabled: false })
  assert.equal(fake.stored.enabled, false)

  assert.deepEqual(await fake.invoke('presence.privacy'), { privacy: 'off' })
  assert.equal(fake.stored.privacy, 'off')

  assert.deepEqual(await fake.invoke('presence.privacy'), { privacy: 'full' })
  await deactivate()
})

test('the privacy command takes a level argument and persists it', async () => {
  const fake = createFakeOrca()
  await activate(fake.orca)
  await settle()

  assert.deepEqual(await fake.invoke('presence.privacy', 'full'), { privacy: 'full' })
  assert.equal(fake.stored.privacy, 'full')

  // Object forms a host or automation might send.
  await fake.invoke('presence.privacy', { privacy: 'off' })
  assert.equal(fake.stored.privacy, 'off')
  await fake.invoke('presence.privacy', { level: 'minimal' })
  assert.equal(fake.stored.privacy, 'minimal')

  // Anything that is not a level means "no argument", which cycles.
  assert.deepEqual(await fake.invoke('presence.privacy', 'sometimes'), { privacy: 'off' })
  await deactivate()
})

test('reconnect reports the connection state instead of throwing', async () => {
  const fake = createFakeOrca()
  await activate(fake.orca)
  await settle()
  await fake.emit('agent.status.changed', {
    worktreeId: 'w1',
    paneKey: 'p1',
    state: 'working',
    receivedAt: Date.now()
  })
  await settle()

  // Whether or not a Discord client is running on this machine, the command
  // has to come back with a report rather than reject — and a failed connect
  // must say why.
  const status = await fake.invoke('presence.reconnect')
  assert.equal(typeof status.connected, 'boolean')
  assert.equal(status.summary.working, 1)
  if (!status.connected) {
    assert.ok(status.lastError, 'expected the failed connect to be reported')
  }
  await deactivate()
})

test('a configured badge shows up in the status report', async () => {
  const fake = createFakeOrca({ settings: { smallImage: 'busy', smallText: 'Fleet busy' } })
  await activate(fake.orca)
  await settle()
  const status = await fake.invoke('presence.status')
  assert.equal(status.smallImage, 'busy')
  await deactivate()
})

test('an unconfigured badge reports the one the fleet is showing', async () => {
  const fake = createFakeOrca()
  await activate(fake.orca)
  await settle()
  assert.equal((await fake.invoke('presence.status')).smallImage, 'idle')
  await fake.emit('agent.status.changed', {
    worktreeId: 'w1',
    paneKey: 'p1',
    state: 'working',
    receivedAt: Date.now()
  })
  await settle()
  const status = await fake.invoke('presence.status')
  assert.equal(status.smallImage, 'working')
  await deactivate()
})

test('stored settings are honoured on activate', async () => {
  const fake = createFakeOrca({ settings: { privacy: 'full', enabled: false } })
  await activate(fake.orca)
  await settle()
  const status = await fake.invoke('presence.status')
  assert.equal(status.privacy, 'full')
  assert.equal(status.enabled, false)
  await deactivate()
})

test('a narrowed capability grant skips every host call it cannot make', async () => {
  const fake = createFakeOrca({ capabilities: ['events:subscribe'] })
  await activate(fake.orca)
  await settle()
  await fake.emit('agent.status.changed', {
    worktreeId: 'w1',
    paneKey: 'p1',
    state: 'working',
    receivedAt: Date.now()
  })
  await settle()

  const status = await fake.invoke('presence.status')
  assert.equal(status.summary.working, 1)
  assert.deepEqual(fake.calls, [])
  await deactivate()
})

test('an explicitly empty capability grant is not treated as full access', async () => {
  const fake = createFakeOrca({ capabilities: [] })
  await activate(fake.orca)
  await settle()
  await fake.invoke('presence.status')
  assert.deepEqual(fake.calls, [])
  await deactivate()
})

test('malformed events do not take the worker down', async () => {
  const fake = createFakeOrca()
  await activate(fake.orca)
  await settle()
  await fake.emit('agent.status.changed', null)
  await fake.emit('worktree.created', { worktreeId: '' })
  await fake.emit('worktree.removed', undefined)
  await settle()
  const status = await fake.invoke('presence.status')
  assert.equal(status.summary.panes, 0)
  await deactivate()
})
