import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyAgentStatus,
  buildActivity,
  createPresenceState,
  describeActivity,
  summarize
} from '../dist/lib/presence-model.mjs'
import {
  createStats,
  describeStats,
  deserializeStats,
  formatDuration,
  localDay,
  recordPaneChange
} from '../dist/lib/stats.mjs'
import {
  DEFAULT_TAGLINES,
  pickTagline,
  sanitizeTaglines,
  shuffledOrder
} from '../dist/lib/taglines.mjs'

const HOUR = 60 * 60_000

test('there are 50 distinct taglines, each within Discord field limits', () => {
  assert.equal(DEFAULT_TAGLINES.length, 50)
  assert.equal(new Set(DEFAULT_TAGLINES).size, 50)
  for (const line of DEFAULT_TAGLINES) {
    assert.ok(line.length >= 2 && line.length <= 128, line)
  }
})

test('a shuffled rotation shows every tagline once before repeating', () => {
  const order = shuffledOrder(DEFAULT_TAGLINES.length)
  const seen = new Set()
  for (let tick = 0; tick < DEFAULT_TAGLINES.length; tick += 1) {
    seen.add(pickTagline(DEFAULT_TAGLINES, tick, order))
  }
  assert.equal(seen.size, DEFAULT_TAGLINES.length)
  assert.equal(pickTagline([], 3, []), undefined)
})

test('custom taglines drop unusable lines and fall back when none survive', () => {
  assert.deepEqual(sanitizeTaglines(['  ok line ', 'x', 42, '']), ['ok line'])
  assert.equal(sanitizeTaglines(['x']), undefined)
  assert.equal(sanitizeTaglines('nope'), undefined)
})

test('a run counts once, from going busy to done, including a blocked hop', () => {
  const start = new Date(2026, 9, 7, 10, 0).getTime()
  const stats = createStats(start)
  const pane = (state, extra = {}) => ({ worktreeId: 'w', state, receivedAt: start, ...extra })

  recordPaneChange(stats, 'p', pane('working', { startedAt: start }), start)
  recordPaneChange(stats, 'p', pane('blocked'), start + 10 * 60_000)
  recordPaneChange(stats, 'p', pane('working'), start + 20 * 60_000)
  recordPaneChange(stats, 'p', pane('done'), start + 30 * 60_000)

  assert.equal(stats.today.runs, 1)
  assert.equal(stats.today.agentMs, 30 * 60_000)
  assert.equal(stats.allTime.runs, 1)
  assert.deepEqual(stats.openRuns, {})

  // A pane that disappears mid-run is not counted as finished.
  recordPaneChange(stats, 'q', pane('working'), start)
  recordPaneChange(stats, 'q', undefined, start + HOUR)
  assert.equal(stats.today.runs, 1)
})

test('today resets at local midnight while all-time keeps counting', () => {
  const evening = new Date(2026, 9, 7, 23, 0).getTime()
  const stats = createStats(evening)
  recordPaneChange(stats, 'p', { worktreeId: 'w', state: 'working', receivedAt: evening }, evening)
  recordPaneChange(stats, 'p', { worktreeId: 'w', state: 'done', receivedAt: evening }, evening + HOUR / 2)
  const nextMorning = new Date(2026, 9, 8, 9, 0).getTime()
  assert.deepEqual(describeStats(stats, nextMorning), ['All time: 1 task · 30m agent time'])
  assert.equal(stats.day, localDay(nextMorning))
})

test('stats lines read naturally and stay quiet when empty', () => {
  const now = Date.now()
  const stats = createStats(now)
  assert.deepEqual(describeStats(stats, now), [])
  stats.today = { runs: 14, agentMs: 3 * HOUR + 40 * 60_000 }
  stats.allTime = { runs: 312, agentMs: 96 * HOUR }
  assert.deepEqual(describeStats(stats, now), [
    'Today: 14 tasks done · 3h 40m agent time',
    'All time: 312 tasks · 96h agent time'
  ])
  assert.deepEqual(deserializeStats(JSON.parse(JSON.stringify(stats)), now), stats)
  assert.equal(deserializeStats('garbage', now).allTime.runs, 0)
  assert.equal(formatDuration(45_000), '45s')
  assert.equal(formatDuration(12 * 60_000), '12m')
})

test('the card says how long an agent has been waiting on you', () => {
  const now = 10_000_000
  const state = createPresenceState()
  applyAgentStatus(state, {
    paneKey: 'a',
    worktreeId: 'w',
    state: 'blocked',
    receivedAt: now,
    mainAgent: { state: 'blocked', stateStartedAt: now - 4 * 60_000 }
  })
  applyAgentStatus(state, { paneKey: 'b', worktreeId: 'w', state: 'working', receivedAt: now })
  const activity = buildActivity({ state, focus: null, privacy: 'minimal', now })
  assert.equal(activity.state, '1 agent working · 1 blocked for 4m')

  // Under a minute is not worth the words.
  assert.equal(
    describeActivity(summarize(state), [], { waitingMs: 30_000 }),
    '1 agent working · 1 blocked'
  )
})

test('an idle card mentions an interrupted last run', () => {
  const state = createPresenceState()
  applyAgentStatus(state, {
    paneKey: 'a',
    worktreeId: 'w',
    state: 'done',
    receivedAt: 5,
    mainAgent: { state: 'done', outcome: 'interruption', stateStartedAt: 5 }
  })
  assert.equal(buildActivity({ state, focus: null, privacy: 'minimal' }).state, 'Fleet idle · last run interrupted')
})

test('a tagline takes the details line and the header moves to the logo hover', () => {
  const state = createPresenceState()
  const focus = { displayName: 'my-app', branch: 'feat/x', terminals: [] }
  const full = buildActivity({ state, focus, privacy: 'full', tagline: 'Claude codes the best' })
  assert.equal(full.details, 'Claude codes the best')
  assert.equal(full.assets.large_text, 'Orca · my-app · feat/x')

  // At minimal the hover carries only the header — never a name.
  const minimal = buildActivity({ state, focus, privacy: 'minimal', tagline: 'Codex is cooking' })
  assert.equal(minimal.assets.large_text, 'Orca')
  assert.ok(!JSON.stringify(minimal).includes('my-app'))

  // A configured hover text still wins.
  const pinned = buildActivity({ state, focus, privacy: 'full', tagline: 'Hi there', assets: { largeText: 'Mine' } })
  assert.equal(pinned.assets.large_text, 'Mine')
})

test('a stats frame replaces the fleet line', () => {
  const activity = buildActivity({
    state: createPresenceState(),
    focus: null,
    privacy: 'minimal',
    stateLine: 'Today: 3 tasks done · 1h agent time'
  })
  assert.equal(activity.state, 'Today: 3 tasks done · 1h agent time')
})

test('a button link typed without https:// still works', () => {
  const activity = buildActivity({
    state: createPresenceState(),
    focus: null,
    privacy: 'minimal',
    buttons: [{ label: 'Repo', url: 'github.com/rftglyv' }]
  })
  assert.deepEqual(activity.buttons, [{ label: 'Repo', url: 'https://github.com/rftglyv' }])
})
