/**
 * Fleet statistics: how many agent runs finished and how much agent time was
 * spent, today and all time. A "run" is one pane's stretch from going busy to
 * coming back to `done`, so a blocked→working hop mid-run does not count twice.
 *
 * Pure and JSON-shaped so it round-trips through plugin storage as-is.
 */
/** A single run longer than this is treated as a stuck pane, not real work. */
const MAX_RUN_MS = 12 * 60 * 60 * 1000;
export function createStats(now) {
    return {
        day: localDay(now),
        today: { runs: 0, agentMs: 0 },
        allTime: { runs: 0, agentMs: 0 },
        openRuns: {}
    };
}
/** `YYYY-MM-DD` in the machine's own time zone — "today" means the user's today. */
export function localDay(now) {
    const date = new Date(now);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
}
function isBusyPane(pane) {
    return pane !== undefined && pane.state !== 'done';
}
/** Resets the daily counters once the calendar day has moved on. */
export function rollStats(stats, now) {
    const today = localDay(now);
    if (stats.day !== today) {
        stats.day = today;
        stats.today = { runs: 0, agentMs: 0 };
    }
    return stats;
}
/**
 * Folds one pane's status change into the stats. `next` undefined means the
 * pane went away (its worktree was removed), which closes the run without
 * counting it as finished.
 */
export function recordPaneChange(stats, paneKey, next, now) {
    rollStats(stats, now);
    const openedAt = stats.openRuns[paneKey];
    if (isBusyPane(next)) {
        if (openedAt === undefined) {
            const reported = next?.startedAt;
            // The host's stamp is better than ours when it is plausible: the event
            // may reach a freshly forked worker well after the run began.
            stats.openRuns[paneKey] =
                reported !== undefined && reported <= now && now - reported < MAX_RUN_MS ? reported : now;
        }
        return stats;
    }
    if (openedAt === undefined) {
        return stats;
    }
    delete stats.openRuns[paneKey];
    if (next === undefined) {
        return stats;
    }
    const spent = Math.min(Math.max(0, now - openedAt), MAX_RUN_MS);
    stats.today.runs += 1;
    stats.today.agentMs += spent;
    stats.allTime.runs += 1;
    stats.allTime.agentMs += spent;
    return stats;
}
/** "3h 40m", "12m", "45s" — the coarsest units that still say something. */
export function formatDuration(ms) {
    const totalMinutes = Math.floor(ms / 60_000);
    if (totalMinutes < 1) {
        return `${Math.max(0, Math.floor(ms / 1000))}s`;
    }
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours === 0) {
        return `${minutes}m`;
    }
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}
function runs(count) {
    return `${count} ${count === 1 ? 'task' : 'tasks'}`;
}
/**
 * The stats lines the card can rotate through, most relevant first. Empty
 * counters produce no line, so a fresh install never boasts "0 tasks".
 */
export function describeStats(stats, now) {
    rollStats(stats, now);
    const lines = [];
    if (stats.today.runs > 0) {
        lines.push(`Today: ${runs(stats.today.runs)} done · ${formatDuration(stats.today.agentMs)} agent time`);
    }
    if (stats.allTime.runs > stats.today.runs) {
        lines.push(`All time: ${runs(stats.allTime.runs)} · ${formatDuration(stats.allTime.agentMs)} agent time`);
    }
    return lines;
}
function asCounter(value) {
    const record = typeof value === 'object' && value !== null ? value : {};
    const read = (key) => {
        const raw = record[key];
        return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : 0;
    };
    return { runs: read('runs'), agentMs: read('agentMs') };
}
/** Tolerates anything storage hands back; unknown shapes start fresh. */
export function deserializeStats(raw, now) {
    const stats = createStats(now);
    if (typeof raw !== 'object' || raw === null) {
        return stats;
    }
    const record = raw;
    if (typeof record['day'] === 'string') {
        stats.day = record['day'];
    }
    stats.today = asCounter(record['today']);
    stats.allTime = asCounter(record['allTime']);
    const open = record['openRuns'];
    if (typeof open === 'object' && open !== null) {
        for (const [paneKey, startedAt] of Object.entries(open)) {
            if (typeof startedAt === 'number' && Number.isFinite(startedAt) && now - startedAt < MAX_RUN_MS) {
                stats.openRuns[paneKey] = startedAt;
            }
        }
    }
    return rollStats(stats, now);
}
//# sourceMappingURL=stats.mjs.map