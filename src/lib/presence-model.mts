/**
 * Pure state model: Orca events in, a Discord activity payload out.
 *
 * Kept free of IPC and of the `orca` host API so the interesting parts — what
 * counts as "working", what leaks at each privacy level, how a payload degrades
 * when a field is missing — are testable without a Discord client or a running
 * Orca.
 *
 * Event payloads arrive as `unknown` even though the host validates them with
 * zod before delivery. The host's guarantee is worth trusting for shape, not
 * for this plugin's own storage round-trip, and one validation path is simpler
 * to reason about than two.
 */

import { basename } from 'node:path'
// Type-only, so the model still pulls in no IPC code at runtime.
import type { DiscordActivity } from './discord-ipc.mjs'
import type { AgentStatusState, WorkspaceContext } from './orca-api.mjs'
import { formatDuration } from './stats.mjs'

/** Orca's agent states, from `AGENT_STATUS_STATES` in the host. */
export const AGENT_STATES: readonly AgentStatusState[] = ['working', 'blocked', 'waiting', 'done']

export const PRIVACY_LEVELS = ['full', 'minimal', 'off'] as const
export type PrivacyLevel = (typeof PRIVACY_LEVELS)[number]

/**
 * Default is `minimal`, not `full`. Branch names routinely carry ticket ids and
 * client names, and a status that silently published them the moment the plugin
 * was enabled would be a bad default even though it is the more interesting one.
 */
export const DEFAULT_PRIVACY: PrivacyLevel = 'minimal'

/**
 * Leading segment of the details line — the closest thing to a card "header"
 * this plugin controls. Discord renders the application's own name above it and
 * that name cannot be set over IPC, so the header lives in `details` instead.
 * Set the setting to `""` to drop the segment entirely.
 */
export const DEFAULT_HEADER = 'Orca'

/**
 * A header is a template, not a literal, so that a header naming the workspace
 * still obeys the privacy level. Baking `checkout-service` into the setting
 * would keep publishing it after a drop to `minimal`; `{workspace}` blanks out
 * instead.
 */
const HEADER_TOKENS = /\{(workspace|branch)\}/g

/** Segment separator inside a header template, and between details segments. */
const SEGMENT_SEPARATOR = ' · '

/**
 * What the **Set Header** command cycles through when the host hands it no
 * argument. Ends on `''` — hiding the header entirely is a real choice, and a
 * cycle that cannot reach it would force a trip to the settings file.
 */
export const HEADER_PRESETS: readonly string[] = [
  DEFAULT_HEADER,
  '{workspace}',
  '{workspace} · {branch}',
  ''
]

/**
 * Art asset keys from the Discord application's *Rich Presence → Art Assets*
 * tab. `orca` is the logo uploaded to the shipped application; pointing
 * `clientId` at your own application means uploading artwork under these keys
 * (or naming your own via `largeImage` / `largeText`).
 */
export const DEFAULT_LARGE_IMAGE = 'orca'
export const DEFAULT_LARGE_TEXT = 'Orca'

/** Shown at `minimal` when the header has been blanked out. */
const FALLBACK_DETAILS = 'Working in Orca'

/**
 * How many workspace names the status line lists before collapsing the rest
 * into `+N`. Three keeps the line readable on a Discord profile card.
 */
const MAX_WORKSPACE_NAMES = 3

/** Discord rejects a details/state string shorter than 2 or longer than 128. */
const FIELD_MIN = 2
const FIELD_MAX = 128

/**
 * Pane statuses older than this are dropped. The worker is reaped after 5
 * minutes idle and rehydrates from storage on the next event, so without a TTL
 * a fleet that was busy yesterday would still read as busy today.
 */
export const STALE_STATUS_MS = 6 * 60 * 60 * 1000

export type WorktreeRecord = { path: string; branch: string }
export type PaneRecord = {
  worktreeId: string | null
  state: AgentStatusState
  receivedAt: number
  /**
   * When the pane's main agent entered its current busy state, as stamped by
   * the host it runs on. Absent from older hosts and whenever the main agent
   * itself is not busy (a subagent can keep the pane working after it is done).
   */
  startedAt?: number
  /** How the main agent's last turn ended (`interruption`, …); only while done. */
  outcome?: string
}

export type PresenceState = {
  worktrees: Map<string, WorktreeRecord>
  panes: Map<string, PaneRecord>
}

export type PresenceSummary = {
  working: number
  blocked: number
  waiting: number
  done: number
  panes: number
  worktrees: number
  activeWorktrees: number
  /** Ids of the worktrees with a working agent, sorted so payloads stay stable. */
  activeWorktreeIds: string[]
}

export function createPresenceState(): PresenceState {
  return { worktrees: new Map(), panes: new Map() }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function isAgentState(value: unknown): value is AgentStatusState {
  return typeof value === 'string' && (AGENT_STATES as readonly string[]).includes(value)
}

const BUSY_STATES: ReadonlySet<AgentStatusState> = new Set(['working', 'blocked', 'waiting'])

/**
 * How far an agent host's clock may run ahead of ours before its start stamp is
 * distrusted. `stateStartedAt` comes from the machine the agent runs on — an
 * SSH host's clock, not this one.
 */
const CLOCK_SKEW_TOLERANCE_MS = 60_000

/**
 * The earliest moment a currently busy main agent started, or `undefined` when
 * no busy pane carries a usable stamp. Stamps from the future (beyond skew
 * tolerance) or older than the stale window are ignored rather than trusted —
 * a timer reading "-3:00" or "40:00:00" is worse than one that starts late.
 */
export function busyStartedAt(state: PresenceState, now: number): number | undefined {
  let earliest: number | undefined
  for (const pane of state.panes.values()) {
    const startedAt = pane.startedAt
    if (
      !BUSY_STATES.has(pane.state) ||
      startedAt === undefined ||
      startedAt > now + CLOCK_SKEW_TOLERANCE_MS ||
      now - startedAt > STALE_STATUS_MS
    ) {
      continue
    }
    earliest = earliest === undefined ? startedAt : Math.min(earliest, startedAt)
  }
  return earliest === undefined ? undefined : Math.min(earliest, now)
}

const ATTENTION_STATES: ReadonlySet<AgentStatusState> = new Set(['blocked', 'waiting'])

/** When the longest-waiting agent started waiting on the user, if any carries a stamp. */
export function attentionStartedAt(state: PresenceState, now: number): number | undefined {
  let earliest: number | undefined
  for (const pane of state.panes.values()) {
    const startedAt = pane.startedAt
    if (
      ATTENTION_STATES.has(pane.state) &&
      startedAt !== undefined &&
      startedAt <= now + CLOCK_SKEW_TOLERANCE_MS &&
      now - startedAt <= STALE_STATUS_MS
    ) {
      earliest = earliest === undefined ? startedAt : Math.min(earliest, startedAt)
    }
  }
  return earliest === undefined ? undefined : Math.min(earliest, now)
}

/** The outcome of the most recently reported finished run. */
export function lastOutcome(state: PresenceState): string | undefined {
  let latest: PaneRecord | undefined
  for (const pane of state.panes.values()) {
    if (pane.state === 'done' && (latest === undefined || pane.receivedAt > latest.receivedAt)) {
      latest = pane
    }
  }
  return latest?.outcome
}

export function applyWorktreeCreated(state: PresenceState, payload: unknown): PresenceState {
  const record = asRecord(payload)
  const worktreeId = asString(record?.['worktreeId'])
  if (!worktreeId) {
    return state
  }
  state.worktrees.set(worktreeId, {
    path: asString(record?.['path']),
    branch: asString(record?.['branch'])
  })
  return state
}

export function applyWorktreeRemoved(state: PresenceState, payload: unknown): PresenceState {
  const record = asRecord(payload)
  const worktreeId = asString(record?.['worktreeId'])
  if (!worktreeId) {
    return state
  }
  state.worktrees.delete(worktreeId)
  for (const [paneKey, pane] of state.panes) {
    if (pane.worktreeId === worktreeId) {
      state.panes.delete(paneKey)
    }
  }
  return state
}

export function applyAgentStatus(state: PresenceState, payload: unknown): PresenceState {
  const record = asRecord(payload)
  const paneKey = asString(record?.['paneKey'])
  const agentState = record?.['state']
  if (!paneKey || !isAgentState(agentState)) {
    return state
  }
  const worktreeId = record?.['worktreeId']
  const receivedAt = record?.['receivedAt']
  const pane: PaneRecord = {
    worktreeId: typeof worktreeId === 'string' ? worktreeId : null,
    state: agentState,
    receivedAt: typeof receivedAt === 'number' ? receivedAt : 0
  }
  const mainAgent = asRecord(record?.['mainAgent'])
  const stateStartedAt = mainAgent?.['stateStartedAt']
  if (
    BUSY_STATES.has(agentState) &&
    isAgentState(mainAgent?.['state']) &&
    BUSY_STATES.has(mainAgent['state']) &&
    typeof stateStartedAt === 'number' &&
    Number.isFinite(stateStartedAt) &&
    stateStartedAt > 0
  ) {
    pane.startedAt = stateStartedAt
  }
  const outcome = mainAgent?.['outcome']
  if (agentState === 'done' && typeof outcome === 'string' && outcome.length > 0) {
    pane.outcome = outcome
  }
  state.panes.set(paneKey, pane)
  return state
}

export function pruneStale(state: PresenceState, now: number): PresenceState {
  for (const [paneKey, pane] of state.panes) {
    if (now - pane.receivedAt > STALE_STATUS_MS) {
      state.panes.delete(paneKey)
    }
  }
  return state
}

/** Storage holds JSON, so Maps round-trip through plain objects. */
export function serializeState(state: PresenceState): {
  worktrees: Record<string, WorktreeRecord>
  panes: Record<string, PaneRecord>
} {
  return {
    worktrees: Object.fromEntries(state.worktrees),
    panes: Object.fromEntries(state.panes)
  }
}

export function deserializeState(raw: unknown): PresenceState {
  const state = createPresenceState()
  const root = asRecord(raw)
  if (!root) {
    return state
  }
  for (const [id, value] of Object.entries(asRecord(root['worktrees']) ?? {})) {
    const record = asRecord(value)
    if (record) {
      state.worktrees.set(id, { path: asString(record['path']), branch: asString(record['branch']) })
    }
  }
  for (const [paneKey, value] of Object.entries(asRecord(root['panes']) ?? {})) {
    const record = asRecord(value)
    if (record && isAgentState(record['state'])) {
      const worktreeId = record['worktreeId']
      const receivedAt = record['receivedAt']
      const startedAt = record['startedAt']
      const pane: PaneRecord = {
        worktreeId: typeof worktreeId === 'string' ? worktreeId : null,
        state: record['state'],
        receivedAt: typeof receivedAt === 'number' ? receivedAt : 0
      }
      if (typeof startedAt === 'number' && Number.isFinite(startedAt) && startedAt > 0) {
        pane.startedAt = startedAt
      }
      if (typeof record['outcome'] === 'string') {
        pane.outcome = record['outcome']
      }
      state.panes.set(paneKey, pane)
    }
  }
  return state
}

export function summarize(state: PresenceState): PresenceSummary {
  const counts: Record<AgentStatusState, number> = { working: 0, blocked: 0, waiting: 0, done: 0 }
  const activeWorktrees = new Set<string>()
  for (const pane of state.panes.values()) {
    counts[pane.state] += 1
    if (pane.state === 'working' && pane.worktreeId) {
      activeWorktrees.add(pane.worktreeId)
    }
  }
  return {
    ...counts,
    panes: state.panes.size,
    worktrees: state.worktrees.size,
    activeWorktrees: activeWorktrees.size,
    // Sorted, not insertion-ordered: pane events arrive in whatever order the
    // fleet happens to emit them, and an unstable order would republish an
    // otherwise identical payload against the rate limit.
    activeWorktreeIds: [...activeWorktrees].sort()
  }
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/**
 * Display name for a worktree. The path's basename is the directory an agent
 * actually works in, which is what a reader recognises; the branch is the
 * fallback for a worktree the host reported without a path.
 */
function worktreeName(record: WorktreeRecord | undefined): string {
  if (record?.path) {
    return basename(record.path)
  }
  return record?.branch.trim() ?? ''
}

/**
 * Names of the workspaces (worktrees) that currently have a working agent.
 *
 * Only worktrees seen through `worktree.created` can be named — one that
 * existed before the plugin was installed is known by id alone, so the list
 * comes back short and `describeActivity` falls back to counting.
 */
export function describeWorkspaces(
  state: PresenceState,
  summary: PresenceSummary = summarize(state)
): string[] {
  const names: string[] = []
  for (const worktreeId of summary.activeWorktreeIds) {
    const name = worktreeName(state.worktrees.get(worktreeId))
    if (name) {
      names.push(name)
    }
  }
  return names
}

function listNames(names: readonly string[]): string {
  if (names.length <= MAX_WORKSPACE_NAMES) {
    return names.join(', ')
  }
  const shown = names.slice(0, MAX_WORKSPACE_NAMES).join(', ')
  return `${shown} +${names.length - MAX_WORKSPACE_NAMES}`
}

/**
 * The status line. Ordered by what a reader would want to know first: agents
 * that need a human come before agents that do not.
 *
 * `blocked` and `waiting` are separate segments even though Orca renders both
 * as its `permission` status — the distinction is free here and tells a reader
 * whether the fleet is stuck or merely asking.
 *
 * `workspaces` names the worktrees the working agents sit in. It is passed only
 * at `full` privacy — at `minimal` the trailing segment stays a bare count, so
 * the shape of the fleet still shows without leaking what it is working on.
 */
export type ActivityDetail = {
  /** How long the longest-waiting agent has been waiting on the user. */
  waitingMs?: number | undefined
  /** How the most recently finished run ended, from `mainAgent.outcome`. */
  lastOutcome?: string | undefined
}

/** Outcomes worth a word on an idle card; anything else reads as a normal finish. */
const OUTCOME_TEXT: Record<string, string> = {
  interruption: 'last run interrupted'
}

export function describeActivity(
  summary: PresenceSummary,
  workspaces: readonly string[] = [],
  detail: ActivityDetail = {}
): string {
  const parts: string[] = []
  if (summary.working > 0) {
    parts.push(`${plural(summary.working, 'agent')} working`)
  }
  // The wait is on the first attention segment only: one "for 4m" says how
  // long the user has kept the fleet waiting without repeating itself.
  const waited =
    detail.waitingMs !== undefined && detail.waitingMs >= 60_000
      ? ` for ${formatDuration(detail.waitingMs)}`
      : ''
  if (summary.blocked > 0) {
    parts.push(`${summary.blocked} blocked${waited}`)
  }
  if (summary.waiting > 0) {
    parts.push(`${summary.waiting} waiting${summary.blocked > 0 ? '' : waited}`)
  }
  if (parts.length === 0) {
    if (summary.panes === 0) {
      return 'No agents running'
    }
    const outcome = detail.lastOutcome ? OUTCOME_TEXT[detail.lastOutcome] : undefined
    return outcome ? `Fleet idle · ${outcome}` : 'Fleet idle'
  }
  if (summary.working > 0) {
    if (workspaces.length > 0) {
      parts.push(`in ${listNames(workspaces)}`)
    } else if (summary.activeWorktrees > 1) {
      parts.push(`across ${plural(summary.activeWorktrees, 'worktree')}`)
    }
  }
  return parts.join(' · ')
}

/**
 * Project label from whatever the host gave us. `workspace.readContext` returns
 * a display name for the focused worktree; a worktree seen only through
 * `worktree.created` has just a path, whose basename is the best available name.
 */
export function describeProject(focus: WorkspaceContext, state: PresenceState): string {
  const displayName = focus?.displayName.trim()
  if (displayName) {
    return displayName
  }
  const branch = focus?.branch.trim()
  for (const worktree of state.worktrees.values()) {
    if (branch && worktree.branch === branch && worktree.path) {
      return basename(worktree.path)
    }
  }
  const [first] = state.worktrees.values()
  return first?.path ? basename(first.path) : ''
}

export type HeaderContext = {
  focus: WorkspaceContext
  state: PresenceState
  privacy: PrivacyLevel
}

/**
 * Expands a header template. `{workspace}` and `{branch}` resolve only at
 * `full`; at `minimal` they blank out, and a template left with nothing but
 * blanks falls back to the default name rather than publishing an empty line.
 *
 * Segments are split on `·` so that a token dropping out takes its separator
 * with it — `{workspace} · {branch}` reads as `Orca`, never as `· `.
 */
export function renderHeader(template: string, { focus, state, privacy }: HeaderContext): string {
  const trimmed = template.trim()
  if (!trimmed) {
    return ''
  }
  const named = privacy === 'full'
  const values: Record<string, string> = {
    workspace: named ? describeProject(focus, state) : '',
    branch: named ? (focus?.branch.trim() ?? '') : ''
  }
  const rendered = trimmed
    .split('·')
    .map((segment) => segment.replace(HEADER_TOKENS, (_, token: string) => values[token] ?? '').trim())
    .filter(Boolean)
    .join(SEGMENT_SEPARATOR)
  return rendered || DEFAULT_HEADER
}

/**
 * Next template in the cycle. A header the user typed by hand is not in the
 * list, so cycling from it starts the presets over from the top.
 */
export function nextHeader(current: string): string {
  const index = HEADER_PRESETS.indexOf(current.trim())
  const next = index < 0 ? HEADER_PRESETS[0] : HEADER_PRESETS[(index + 1) % HEADER_PRESETS.length]
  return next ?? DEFAULT_HEADER
}

function clampField(value: string): string | undefined {
  const trimmed = value.trim()
  if (trimmed.length < FIELD_MIN) {
    return undefined
  }
  return trimmed.length > FIELD_MAX ? `${trimmed.slice(0, FIELD_MAX - 1)}…` : trimmed
}

/** Drops repeats so a header of "Orca" plus a project named "orca" reads once. */
function dedupeSegments(segments: readonly string[]): string[] {
  const seen = new Set<string>()
  const kept: string[] = []
  for (const segment of segments) {
    const key = segment.toLowerCase()
    if (segment && !seen.has(key)) {
      seen.add(key)
      kept.push(segment)
    }
  }
  return kept
}

export type PresenceAssets = {
  largeImage?: string | undefined
  largeText?: string | undefined
  /** Badge in the corner of the logo. Unset follows the fleet's mood (see
   *  `fleetMood`); `""` turns it off; any other key pins that artwork. */
  smallImage?: string | undefined
  smallText?: string | undefined
}

/**
 * What the corner badge says at a glance. Attention outranks work: an agent
 * stuck on a permission prompt is the one thing a viewer — or the user glancing
 * at their own profile — should notice, even while others keep working.
 *
 * Each mood doubles as an art asset key on the shipped application.
 */
export type FleetMood = 'working' | 'waiting' | 'idle'

export function fleetMood(summary: PresenceSummary): FleetMood {
  if (summary.blocked > 0 || summary.waiting > 0) {
    return 'waiting'
  }
  return summary.working > 0 ? 'working' : 'idle'
}

const MOOD_TEXT: Record<FleetMood, string> = {
  working: 'Agents working',
  waiting: 'Waiting on input',
  idle: 'Idle'
}

export type PresenceButton = { label: string; url: string }

/** Shown to everyone viewing the profile — Discord hides buttons from the user themselves. */
export const DEFAULT_BUTTONS: readonly PresenceButton[] = [
  { label: 'Get Orca', url: 'https://onorca.dev' }
]

/** Discord's limits: two buttons, 1–32 character labels, 1–512 character URLs. */
const MAX_BUTTONS = 2
const BUTTON_LABEL_MAX = 32
const BUTTON_URL_MAX = 512

/**
 * Keeps only buttons Discord will accept. One bad button makes Discord reject
 * the whole SET_ACTIVITY, so dropping it here beats losing the card.
 */
export function sanitizeButtons(raw: unknown): PresenceButton[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined
  }
  const buttons: PresenceButton[] = []
  for (const entry of raw) {
    const record = asRecord(entry)
    const label = asString(record?.['label']).trim()
    const url = asString(record?.['url']).trim()
    if (
      label.length > 0 &&
      label.length <= BUTTON_LABEL_MAX &&
      url.length <= BUTTON_URL_MAX &&
      /^https?:\/\/\S+$/.test(url)
    ) {
      buttons.push({ label, url })
    }
    if (buttons.length === MAX_BUTTONS) {
      break
    }
  }
  return buttons
}

/** Which line the member list shows beside the user's name. */
export const STATUS_LINES = ['name', 'state', 'details'] as const
export type StatusLine = (typeof STATUS_LINES)[number]

/**
 * `state`, because the fleet summary is the line that changes: "2 agents
 * working" says more in a member list than the application name does.
 */
export const DEFAULT_STATUS_LINE: StatusLine = 'state'

export function isStatusLine(value: unknown): value is StatusLine {
  return typeof value === 'string' && (STATUS_LINES as readonly string[]).includes(value)
}

export type BuildActivityInput = {
  state: PresenceState
  focus: WorkspaceContext
  privacy: PrivacyLevel
  startedAt?: number
  /** Leading segment of the details line; `undefined` takes `DEFAULT_HEADER`. */
  header?: string | undefined
  assets?: PresenceAssets | undefined
  /** Opaque party id; omitted, Discord may not render the party size at all. */
  partyId?: string | undefined
  /** `undefined` takes `DEFAULT_BUTTONS`; `[]` publishes none. */
  buttons?: readonly PresenceButton[] | undefined
  /** `undefined` takes `DEFAULT_STATUS_LINE`. */
  statusLine?: StatusLine | undefined
  /** Wall clock for durations on the card; defaults to `Date.now()`. */
  now?: number | undefined
  /**
   * A tagline for the details line. When set, the header (and at `full`, the
   * workspace and branch) moves to the logo's hover text instead of being lost.
   */
  tagline?: string | undefined
  /** Replaces the fleet line for this frame — how the stats rotation shows. */
  stateLine?: string | undefined
}

/**
 * Builds the payload handed to SET_ACTIVITY. Returns `null` when nothing should
 * be published — the caller clears the status rather than sending an empty one.
 *
 * The card reads top to bottom as:
 *
 *   Orca · my-app · feat/ipc      ← details: header, workspace, branch
 *   2 agents working · in my-app  ← state: fleet summary, workspaces at `full`
 *
 * `startedAt` drives Discord's elapsed timer; it is the moment the fleet last
 * went from idle to busy, not process start, so the timer reads as "how long
 * this batch of work has been running".
 */
export function buildActivity({
  state,
  focus,
  privacy,
  startedAt,
  header,
  assets,
  partyId,
  buttons,
  statusLine,
  now = Date.now(),
  tagline,
  stateLine
}: BuildActivityInput): DiscordActivity | null {
  if (privacy === 'off') {
    return null
  }
  const summary = summarize(state)
  const activity: DiscordActivity = {
    type: 0,
    status_display_type: STATUS_LINES.indexOf(statusLine ?? DEFAULT_STATUS_LINE) as 0 | 1 | 2
  }
  const heading = renderHeader(header ?? DEFAULT_HEADER, { focus, state, privacy })

  let context: string | undefined
  if (privacy === 'full') {
    const project = describeProject(focus, state)
    const branch = focus?.branch.trim() ?? ''
    // Deduped, so a header that already names the workspace does not repeat it.
    const details = dedupeSegments([heading, project, branch]).join(SEGMENT_SEPARATOR)
    context = clampField(details) ?? clampField(FALLBACK_DETAILS)
  } else {
    // `minimal`: the fleet's shape is not sensitive, its names are — so the
    // header is all that survives, and a blanked header leaves details unset.
    context = heading ? clampField(heading) : undefined
  }
  const taglineText = tagline ? clampField(tagline) : undefined
  activity.details = taglineText ?? context

  const attentionSince = attentionStartedAt(state, now)
  activity.state = clampField(
    stateLine ??
      describeActivity(summary, privacy === 'full' ? describeWorkspaces(state, summary) : [], {
        waitingMs: attentionSince === undefined ? undefined : now - attentionSince,
        lastOutcome: lastOutcome(state)
      })
  )
  if (typeof startedAt === 'number' && startedAt > 0) {
    activity.timestamps = { start: Math.floor(startedAt) }
  }
  const largeImage = assets?.largeImage ?? DEFAULT_LARGE_IMAGE
  // With a tagline on the details line, the header context moves into the
  // logo's hover text rather than disappearing from the card.
  const largeText = assets?.largeText ?? (taglineText && context ? context : DEFAULT_LARGE_TEXT)
  if (largeImage) {
    activity.assets = { large_image: largeImage }
    if (largeText) {
      activity.assets.large_text = clampField(largeText)
    }
  }
  // A small image needs a large one to sit on: Discord renders it as a badge in
  // the logo's corner, and on its own it is simply dropped.
  const mood = fleetMood(summary)
  const smallImage = assets?.smallImage ?? mood
  if (largeImage && smallImage) {
    activity.assets = { ...activity.assets, small_image: smallImage }
    const smallText = assets?.smallText ?? (assets?.smallImage === undefined ? MOOD_TEXT[mood] : '')
    if (smallText) {
      activity.assets.small_text = clampField(smallText)
    }
  }
  const party = describeParty(summary, partyId)
  if (party) {
    activity.party = party
  }
  const published = sanitizeButtons(buttons ?? DEFAULT_BUTTONS) ?? []
  if (published.length > 0) {
    activity.buttons = published
  }
  activity.instance = false
  return activity
}

/**
 * Fleet gauge: Discord renders `size` as `(2 of 5)` next to the status line.
 *
 * Counts only, so it says the same thing at `full` and at `minimal` — the
 * numbers are already in the status line, and neither level would leak a name
 * through an integer. Omitted when no agent is busy, because `(0 of 3)` reads
 * as a broken party rather than as an idle fleet.
 */
function describeParty(
  summary: PresenceSummary,
  partyId: string | undefined
): { id?: string; size: [number, number] } | null {
  const busy = busyCount(summary)
  if (busy <= 0) {
    return null
  }
  // `max` can never be below `current`: a pane can report a status before its
  // worktree event arrives, and Discord rejects an inverted party size.
  const size: [number, number] = [busy, Math.max(busy, summary.panes)]
  return partyId ? { id: partyId, size } : { size }
}

export function isPrivacyLevel(value: unknown): value is PrivacyLevel {
  return typeof value === 'string' && (PRIVACY_LEVELS as readonly string[]).includes(value)
}

export function nextPrivacy(current: PrivacyLevel): PrivacyLevel {
  const index = PRIVACY_LEVELS.indexOf(current)
  return PRIVACY_LEVELS[(index + 1) % PRIVACY_LEVELS.length] as PrivacyLevel
}

/**
 * True when the fleet has any agent that is not finished.
 *
 * `waiting` counts: Orca maps both `blocked` and `waiting` onto its
 * `permission` status — "agent needs user attention" — so a fleet sitting on a
 * permission prompt is not idle, and the elapsed timer should keep running.
 */
export function isBusy(summary: PresenceSummary): boolean {
  return summary.working > 0 || summary.blocked > 0 || summary.waiting > 0
}

/** Agents the fleet still owes work on — the `current` half of the party size. */
export function busyCount(summary: PresenceSummary): number {
  return summary.working + summary.blocked + summary.waiting
}

/**
 * True once an idle fleet has kept its card for `idleClearMinutes`. A busy
 * fleet never expires, and `0` minutes means "keep the idle card forever".
 */
export function isIdleExpired({
  summary,
  idleSince,
  now,
  idleClearMinutes
}: {
  summary: PresenceSummary
  idleSince: number
  now: number
  idleClearMinutes: number
}): boolean {
  const limitMs = idleClearMinutes * 60_000
  return limitMs > 0 && idleSince > 0 && !isBusy(summary) && now - idleSince >= limitMs
}
