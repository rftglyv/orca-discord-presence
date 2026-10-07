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
import type { DiscordActivity } from './discord-ipc.mjs';
import type { AgentStatusState, WorkspaceContext } from './orca-api.mjs';
/** Orca's agent states, from `AGENT_STATUS_STATES` in the host. */
export declare const AGENT_STATES: readonly AgentStatusState[];
export declare const PRIVACY_LEVELS: readonly ['full', 'minimal', 'off'];
export type PrivacyLevel = (typeof PRIVACY_LEVELS)[number];
/**
 * Default is `minimal`, not `full`. Branch names routinely carry ticket ids and
 * client names, and a status that silently published them the moment the plugin
 * was enabled would be a bad default even though it is the more interesting one.
 */
export declare const DEFAULT_PRIVACY: PrivacyLevel;
/**
 * Leading segment of the details line — the closest thing to a card "header"
 * this plugin controls. Discord renders the application's own name above it and
 * that name cannot be set over IPC, so the header lives in `details` instead.
 * Set the setting to `""` to drop the segment entirely.
 */
export declare const DEFAULT_HEADER = "Orca";
/**
 * What the **Set Header** command cycles through when the host hands it no
 * argument. Ends on `''` — hiding the header entirely is a real choice, and a
 * cycle that cannot reach it would force a trip to the settings file.
 */
export declare const HEADER_PRESETS: readonly string[];
/**
 * Art asset keys from the Discord application's *Rich Presence → Art Assets*
 * tab. `orca` is the logo uploaded to the shipped application; pointing
 * `clientId` at your own application means uploading artwork under these keys
 * (or naming your own via `largeImage` / `largeText`).
 */
export declare const DEFAULT_LARGE_IMAGE = "orca";
export declare const DEFAULT_LARGE_TEXT = "Orca";
/**
 * Pane statuses older than this are dropped. The worker is reaped after 5
 * minutes idle and rehydrates from storage on the next event, so without a TTL
 * a fleet that was busy yesterday would still read as busy today.
 */
export declare const STALE_STATUS_MS: number;
export type WorktreeRecord = {
    path: string;
    branch: string;
};
export type PaneRecord = {
    worktreeId: string | null;
    state: AgentStatusState;
    receivedAt: number;
    /**
     * When the pane's main agent entered its current busy state, as stamped by
     * the host it runs on. Absent from older hosts and whenever the main agent
     * itself is not busy (a subagent can keep the pane working after it is done).
     */
    startedAt?: number;
    /** How the main agent's last turn ended (`interruption`, …); only while done. */
    outcome?: string;
};
export type PresenceState = {
    worktrees: Map<string, WorktreeRecord>;
    panes: Map<string, PaneRecord>;
};
export type PresenceSummary = {
    working: number;
    blocked: number;
    waiting: number;
    done: number;
    panes: number;
    worktrees: number;
    activeWorktrees: number;
    /** Ids of the worktrees with a working agent, sorted so payloads stay stable. */
    activeWorktreeIds: string[];
};
export declare function createPresenceState(): PresenceState;
/**
 * The earliest moment a currently busy main agent started, or `undefined` when
 * no busy pane carries a usable stamp. Stamps from the future (beyond skew
 * tolerance) or older than the stale window are ignored rather than trusted —
 * a timer reading "-3:00" or "40:00:00" is worse than one that starts late.
 */
export declare function busyStartedAt(state: PresenceState, now: number): number | undefined;
/** When the longest-waiting agent started waiting on the user, if any carries a stamp. */
export declare function attentionStartedAt(state: PresenceState, now: number): number | undefined;
/** The outcome of the most recently reported finished run. */
export declare function lastOutcome(state: PresenceState): string | undefined;
export declare function applyWorktreeCreated(state: PresenceState, payload: unknown): PresenceState;
export declare function applyWorktreeRemoved(state: PresenceState, payload: unknown): PresenceState;
export declare function applyAgentStatus(state: PresenceState, payload: unknown): PresenceState;
export declare function pruneStale(state: PresenceState, now: number): PresenceState;
/** Storage holds JSON, so Maps round-trip through plain objects. */
export declare function serializeState(state: PresenceState): {
    worktrees: Record<string, WorktreeRecord>;
    panes: Record<string, PaneRecord>;
};
export declare function deserializeState(raw: unknown): PresenceState;
export declare function summarize(state: PresenceState): PresenceSummary;
/**
 * Names of the workspaces (worktrees) that currently have a working agent.
 *
 * Only worktrees seen through `worktree.created` can be named — one that
 * existed before the plugin was installed is known by id alone, so the list
 * comes back short and `describeActivity` falls back to counting.
 */
export declare function describeWorkspaces(state: PresenceState, summary?: PresenceSummary): string[];
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
    waitingMs?: number | undefined;
    /** How the most recently finished run ended, from `mainAgent.outcome`. */
    lastOutcome?: string | undefined;
};
export declare function describeActivity(summary: PresenceSummary, workspaces?: readonly string[], detail?: ActivityDetail): string;
/**
 * Project label from whatever the host gave us. `workspace.readContext` returns
 * a display name for the focused worktree; a worktree seen only through
 * `worktree.created` has just a path, whose basename is the best available name.
 */
export declare function describeProject(focus: WorkspaceContext, state: PresenceState): string;
export type HeaderContext = {
    focus: WorkspaceContext;
    state: PresenceState;
    privacy: PrivacyLevel;
};
/**
 * Expands a header template. `{workspace}` and `{branch}` resolve only at
 * `full`; at `minimal` they blank out, and a template left with nothing but
 * blanks falls back to the default name rather than publishing an empty line.
 *
 * Segments are split on `·` so that a token dropping out takes its separator
 * with it — `{workspace} · {branch}` reads as `Orca`, never as `· `.
 */
export declare function renderHeader(template: string, { focus, state, privacy }: HeaderContext): string;
/**
 * Next template in the cycle. A header the user typed by hand is not in the
 * list, so cycling from it starts the presets over from the top.
 */
export declare function nextHeader(current: string): string;
export type PresenceAssets = {
    largeImage?: string | undefined;
    largeText?: string | undefined;
    /** Badge in the corner of the logo. Unset follows the fleet's mood (see
     *  `fleetMood`); `""` turns it off; any other key pins that artwork. */
    smallImage?: string | undefined;
    smallText?: string | undefined;
};
/**
 * What the corner badge says at a glance. Attention outranks work: an agent
 * stuck on a permission prompt is the one thing a viewer — or the user glancing
 * at their own profile — should notice, even while others keep working.
 *
 * Each mood doubles as an art asset key on the shipped application.
 */
export type FleetMood = 'working' | 'waiting' | 'idle';
export declare function fleetMood(summary: PresenceSummary): FleetMood;
export type PresenceButton = {
    label: string;
    url: string;
};
/** Shown to everyone viewing the profile — Discord hides buttons from the user themselves. */
export declare const DEFAULT_BUTTONS: readonly PresenceButton[];
/**
 * Keeps only buttons Discord will accept. One bad button makes Discord reject
 * the whole SET_ACTIVITY, so dropping it here beats losing the card.
 */
export declare function sanitizeButtons(raw: unknown): PresenceButton[] | undefined;
/** Which line the member list shows beside the user's name. */
export declare const STATUS_LINES: readonly ['name', 'state', 'details'];
export type StatusLine = (typeof STATUS_LINES)[number];
/**
 * `state`, because the fleet summary is the line that changes: "2 agents
 * working" says more in a member list than the application name does.
 */
export declare const DEFAULT_STATUS_LINE: StatusLine;
export declare function isStatusLine(value: unknown): value is StatusLine;
export type BuildActivityInput = {
    state: PresenceState;
    focus: WorkspaceContext;
    privacy: PrivacyLevel;
    startedAt?: number;
    /** Leading segment of the details line; `undefined` takes `DEFAULT_HEADER`. */
    header?: string | undefined;
    assets?: PresenceAssets | undefined;
    /** Opaque party id; omitted, Discord may not render the party size at all. */
    partyId?: string | undefined;
    /** `undefined` takes `DEFAULT_BUTTONS`; `[]` publishes none. */
    buttons?: readonly PresenceButton[] | undefined;
    /** `undefined` takes `DEFAULT_STATUS_LINE`. */
    statusLine?: StatusLine | undefined;
    /** Wall clock for durations on the card; defaults to `Date.now()`. */
    now?: number | undefined;
    /**
     * A tagline for the details line. When set, the header (and at `full`, the
     * workspace and branch) moves to the logo's hover text instead of being lost.
     */
    tagline?: string | undefined;
    /** Replaces the fleet line for this frame — how the stats rotation shows. */
    stateLine?: string | undefined;
};
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
export declare function buildActivity({ state, focus, privacy, startedAt, header, assets, partyId, buttons, statusLine, now, tagline, stateLine }: BuildActivityInput): DiscordActivity | null;
export declare function isPrivacyLevel(value: unknown): value is PrivacyLevel;
export declare function nextPrivacy(current: PrivacyLevel): PrivacyLevel;
/**
 * True when the fleet has any agent that is not finished.
 *
 * `waiting` counts: Orca maps both `blocked` and `waiting` onto its
 * `permission` status — "agent needs user attention" — so a fleet sitting on a
 * permission prompt is not idle, and the elapsed timer should keep running.
 */
export declare function isBusy(summary: PresenceSummary): boolean;
/** Agents the fleet still owes work on — the `current` half of the party size. */
export declare function busyCount(summary: PresenceSummary): number;
/**
 * True once an idle fleet has kept its card for `idleClearMinutes`. A busy
 * fleet never expires, and `0` minutes means "keep the idle card forever".
 */
export declare function isIdleExpired({ summary, idleSince, now, idleClearMinutes }: {
    summary: PresenceSummary;
    idleSince: number;
    now: number;
    idleClearMinutes: number;
}): boolean;
