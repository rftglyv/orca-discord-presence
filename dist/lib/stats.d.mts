/**
 * Fleet statistics: how many agent runs finished and how much agent time was
 * spent, today and all time. A "run" is one pane's stretch from going busy to
 * coming back to `done`, so a blocked→working hop mid-run does not count twice.
 *
 * Pure and JSON-shaped so it round-trips through plugin storage as-is.
 */
import type { PaneRecord } from './presence-model.mjs';
export type FleetStats = {
    /** Local calendar day the `today` counters belong to, as `YYYY-MM-DD`. */
    day: string;
    today: {
        runs: number;
        agentMs: number;
    };
    allTime: {
        runs: number;
        agentMs: number;
    };
    /** Pane key → when its current run began. */
    openRuns: Record<string, number>;
};
export declare function createStats(now: number): FleetStats;
/** `YYYY-MM-DD` in the machine's own time zone — "today" means the user's today. */
export declare function localDay(now: number): string;
/** Resets the daily counters once the calendar day has moved on. */
export declare function rollStats(stats: FleetStats, now: number): FleetStats;
/**
 * Folds one pane's status change into the stats. `next` undefined means the
 * pane went away (its worktree was removed), which closes the run without
 * counting it as finished.
 */
export declare function recordPaneChange(stats: FleetStats, paneKey: string, next: PaneRecord | undefined, now: number): FleetStats;
/** "3h 40m", "12m", "45s" — the coarsest units that still say something. */
export declare function formatDuration(ms: number): string;
/**
 * The stats lines the card can rotate through, most relevant first. Empty
 * counters produce no line, so a fresh install never boasts "0 tasks".
 */
export declare function describeStats(stats: FleetStats, now: number): string[];
/** Tolerates anything storage hands back; unknown shapes start fresh. */
export declare function deserializeStats(raw: unknown, now: number): FleetStats;
