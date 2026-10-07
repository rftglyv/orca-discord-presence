/**
 * Orca plugin worker entry: mirrors the agent fleet into Discord Rich Presence.
 *
 * Lifetime note, because it shapes everything below: Orca reaps a plugin worker
 * after 5 minutes with no in-flight work (`PLUGIN_WORKER_IDLE_REAP_MS`) and
 * re-forks it on the next event. A worker cannot keep itself alive — only
 * host→worker traffic refreshes the idle clock. So the presence is deliberately
 * *ephemeral*: it appears while the fleet is active, disappears once things have
 * been quiet for a few minutes, and comes back on the next agent event. State
 * survives the gap in plugin storage rather than in memory.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DiscordPresenceClient } from './lib/discord-ipc.mjs';
import { createStats, deserializeStats, describeStats, recordPaneChange } from './lib/stats.mjs';
import { createSettingsToken, startSettingsServer } from './lib/settings-server.mjs';
import { DEFAULT_TAGLINES, pickTagline, sanitizeTaglines, shuffledOrder } from './lib/taglines.mjs';
import { DEFAULT_HEADER, DEFAULT_LARGE_IMAGE, DEFAULT_PRIVACY, applyAgentStatus, applyWorktreeCreated, applyWorktreeRemoved, buildActivity, busyStartedAt, createPresenceState, deserializeState, describeActivity, describeWorkspaces, fleetMood, isBusy, isIdleExpired, isStatusLine, isPrivacyLevel, nextHeader, nextPrivacy, renderHeader, pruneStale, sanitizeButtons, serializeState, summarize } from './lib/presence-model.mjs';
const STORAGE_KEY = 'presence-state';
const STORAGE_STARTED_AT_KEY = 'busy-since';
const STORAGE_STATS_KEY = 'fleet-stats';
/** Kept in plugin storage so a bookmarked settings link survives worker restarts. */
const STORAGE_SETTINGS_TOKEN_KEY = 'settings-token';
/**
 * Discord application backing the presence by default.
 *
 * Rich Presence application ids are public identifiers — they travel in every
 * client's IPC traffic and grant nothing on their own. The sensitive half is
 * the OAuth client secret, which Rich Presence never needs and this plugin
 * never asks for. Shipping an id means the plugin works on install; set
 * `clientId` in settings to publish under your own application instead (the
 * application's name is what Discord shows as the "Playing …" line).
 */
export const DEFAULT_CLIENT_ID = '1557157916279185418';
/** Coalesce bursts: a single agent transition can fan out several events. */
const PUBLISH_DEBOUNCE_MS = 1_500;
/** Discord throttles SET_ACTIVITY at roughly 5 calls / 15s; stay well under. */
const MIN_PUBLISH_INTERVAL_MS = 4_000;
const FOCUS_POLL_MS = 30_000;
const RECONNECT_DELAYS_MS = [15_000, 30_000, 60_000];
/**
 * How long an idle fleet keeps its card before the status is cleared. The
 * workspace poll keeps the worker alive indefinitely, so without this a
 * "Fleet idle" card would sit on the profile all night.
 */
export const DEFAULT_IDLE_CLEAR_MINUTES = 15;
/**
 * How often the card rotates its tagline and stats. Discord throttles
 * SET_ACTIVITY at roughly 5 calls per 20s; one change every 20s at the
 * fastest leaves room for real status changes in between.
 */
export const DEFAULT_ROTATE_SECONDS = 45;
export const MIN_ROTATE_SECONDS = 20;
/**
 * Module-scoped because the host ignores whatever `activate` returns and calls
 * the `deactivate` export for teardown — there is nowhere else to hand the
 * runtime across.
 */
let activeRuntime = null;
export default function activate(orca) {
    activeRuntime?.dispose();
    const runtime = new PresenceRuntime(orca);
    activeRuntime = runtime;
    runtime.start();
    orca.commands.register('presence.toggle', () => runtime.toggleEnabled());
    // Takes a level when the host passes one, and cycles otherwise — same shape
    // as the header command, for the same reason.
    orca.commands.register('presence.privacy', (args) => runtime.setPrivacy(args));
    orca.commands.register('presence.status', () => runtime.reportStatus());
    orca.commands.register('presence.settings', () => runtime.openSettings());
    orca.commands.register('presence.reconnect', () => runtime.reconnectNow());
    // Takes the new header as its argument when the host passes one, and cycles
    // the presets when it does not — Orca has no text-input affordance for
    // commands, so the cycle is what makes this usable from the palette alone.
    orca.commands.register('presence.header', (args) => runtime.setHeader(args));
    orca.events.on('worktree.created', (payload) => {
        runtime.onEvent((state) => applyWorktreeCreated(state, payload));
    });
    orca.events.on('worktree.removed', (payload) => {
        runtime.onEvent((state) => applyWorktreeRemoved(state, payload));
    });
    orca.events.on('agent.status.changed', (payload) => {
        runtime.onEvent((state) => applyAgentStatus(state, payload));
    });
}
export async function deactivate() {
    const runtime = activeRuntime;
    activeRuntime = null;
    // Clear the status on the way out: a stale "3 agents working" left sitting on
    // a profile after Orca quits is worse than no presence at all.
    await runtime?.shutdown();
}
class PresenceRuntime {
    #orca;
    #granted;
    #state = createPresenceState();
    #settings = {
        enabled: true,
        privacy: DEFAULT_PRIVACY,
        clientId: DEFAULT_CLIENT_ID,
        header: undefined,
        assets: {
            largeImage: undefined,
            largeText: undefined,
            smallImage: undefined,
            smallText: undefined
        },
        buttons: undefined,
        statusLine: undefined,
        idleClearMinutes: DEFAULT_IDLE_CLEAR_MINUTES,
        taglines: true,
        customTaglines: undefined,
        showStats: true,
        rotateSeconds: DEFAULT_ROTATE_SECONDS
    };
    #client = null;
    /** Settings exactly as stored, so a partial update can be re-parsed whole. */
    #rawSettings = {};
    /**
     * The in-flight connect, shared so a publish that arrives mid-handshake waits
     * for it instead of being dropped until some later event happens along.
     */
    #connecting = null;
    #reconnectAttempt = 0;
    #busySince = 0;
    /**
     * When the fleet last went busy→idle. Starts at worker birth: a re-forked
     * worker cannot know how long the fleet was idle before it, and erring
     * towards showing the card a little longer beats clearing it early.
     */
    #idleSince = Date.now();
    #idleTimer = null;
    /** Set once the idle card has been cleared, so later publishes stay quiet. */
    #idleCleared = false;
    #stats = createStats(Date.now());
    /** Advances once per rotation; picks the tagline and the state-line frame. */
    #rotationTick = 0;
    #taglineOrder = [];
    #rotationTimer = null;
    #settingsServer = null;
    #lastPublishAt = 0;
    #lastPayload = '';
    #focus = null;
    #publishTimer = null;
    #reconnectTimer = null;
    #focusTimer = null;
    #disposed = false;
    #lastError = null;
    /**
     * Per-worker party id. Random rather than fixed: a party id is the handle
     * Discord would group people by, and two Orca users are not in a party
     * together just because they both run this plugin. Nothing joinable is
     * published — Rich Presence needs a join secret for that, which this plugin
     * never sends.
     */
    #partyId = randomUUID();
    constructor(orca) {
        this.#orca = orca;
        // Consent is granted per manifest, but a host that narrows a grant should
        // cost us a skipped call, not a failing one every 30 seconds.
        this.#granted = new Set(orca.grantedCapabilities ?? []);
    }
    start() {
        void this.#bootstrap();
        this.#focusTimer = setInterval(() => void this.#refreshFocus(), FOCUS_POLL_MS);
        this.#focusTimer.unref?.();
    }
    async #bootstrap() {
        await this.#loadSettings();
        await this.#loadState();
        await this.#refreshFocus();
        this.#restartRotation();
        this.#schedulePublish();
    }
    #can(capability) {
        return this.#granted.has(capability);
    }
    async #loadSettings() {
        if (!this.#can('settings:own')) {
            return;
        }
        try {
            const result = await this.#orca.host.call('settings.get');
            this.#rawSettings = { ...(result.settings ?? {}) };
            this.#settings = parseSettings(this.#rawSettings);
        }
        catch (error) {
            this.#orca.log(`settings unavailable, using defaults: ${describeError(error)}`);
        }
    }
    async #saveSetting(key, value) {
        if (!this.#can('settings:own')) {
            return;
        }
        try {
            await this.#orca.host.call('settings.set', { key, value });
            this.#rawSettings[key] = value;
        }
        catch (error) {
            this.#orca.log(`could not persist ${key}: ${describeError(error)}`);
        }
    }
    async #loadState() {
        if (!this.#can('storage')) {
            return;
        }
        try {
            const stored = await this.#orca.host.call('storage.get', { key: STORAGE_KEY });
            this.#state = pruneStale(deserializeState(stored.value), Date.now());
            const since = await this.#orca.host.call('storage.get', { key: STORAGE_STARTED_AT_KEY });
            this.#busySince = typeof since.value === 'number' ? since.value : 0;
            const stats = await this.#orca.host.call('storage.get', { key: STORAGE_STATS_KEY });
            this.#stats = deserializeStats(stats.value, Date.now());
        }
        catch (error) {
            this.#orca.log(`could not restore state: ${describeError(error)}`);
        }
    }
    async #persistState() {
        if (!this.#can('storage')) {
            return;
        }
        try {
            await this.#orca.host.call('storage.set', {
                key: STORAGE_KEY,
                value: serializeState(this.#state)
            });
            await this.#orca.host.call('storage.set', {
                key: STORAGE_STATS_KEY,
                value: this.#stats
            });
        }
        catch (error) {
            this.#orca.log(`could not persist state: ${describeError(error)}`);
        }
    }
    async #refreshFocus() {
        if (this.#disposed || !this.#can('workspace:read')) {
            return;
        }
        const previous = this.#focus;
        let next;
        try {
            next = await this.#orca.host.call('workspace.readContext');
        }
        catch (error) {
            // Non-fatal: without focus context the presence falls back to counts only.
            this.#orca.log(`workspace context unavailable: ${describeError(error)}`);
            next = null;
        }
        this.#focus = next;
        // Orca still has no focus-change plugin event. Polling only helps if a
        // changed context triggers a publish; otherwise the new workspace sits in
        // memory until an unrelated agent event happens to arrive.
        if (this.#settings.privacy === 'full' && !sameFocus(previous, next)) {
            this.#schedulePublish();
        }
    }
    /** Applies a state mutation, then persists and republishes. */
    onEvent(mutate) {
        if (this.#disposed) {
            return;
        }
        try {
            mutate(this.#state);
        }
        catch (error) {
            this.#orca.log(`event ignored: ${describeError(error)}`);
            return;
        }
        const now = Date.now();
        pruneStale(this.#state, now);
        this.#recordStats(now);
        this.#trackBusyWindow();
        void this.#persistState();
        this.#schedulePublish();
    }
    /** Opens and closes runs for every pane, including ones that just went away. */
    #recordStats(now) {
        for (const [paneKey, pane] of this.#state.panes) {
            recordPaneChange(this.#stats, paneKey, pane, now);
        }
        for (const paneKey of Object.keys(this.#stats.openRuns)) {
            if (!this.#state.panes.has(paneKey)) {
                recordPaneChange(this.#stats, paneKey, undefined, now);
            }
        }
    }
    /** (Re)arms the rotation; a settings change can alter the interval or turn it off. */
    #restartRotation() {
        if (this.#rotationTimer) {
            clearInterval(this.#rotationTimer);
            this.#rotationTimer = null;
        }
        const lines = this.#taglineList();
        if (this.#taglineOrder.length !== lines.length) {
            this.#taglineOrder = shuffledOrder(lines.length);
        }
        if (this.#disposed || (!this.#settings.taglines && !this.#settings.showStats)) {
            return;
        }
        this.#rotationTimer = setInterval(() => {
            this.#rotationTick += 1;
            this.#schedulePublish();
        }, this.#settings.rotateSeconds * 1000);
        this.#rotationTimer.unref?.();
    }
    #taglineList() {
        return this.#settings.customTaglines ?? DEFAULT_TAGLINES;
    }
    /** The tagline and state-line override for the current rotation frame. */
    #rotationFrame(now) {
        const tagline = this.#settings.taglines
            ? pickTagline(this.#taglineList(), this.#rotationTick, this.#taglineOrder)
            : undefined;
        // Frame 0 is always the live fleet line; stats frames follow it.
        const statsLines = this.#settings.showStats ? describeStats(this.#stats, now) : [];
        const frame = this.#rotationTick % (statsLines.length + 1);
        return { tagline, stateLine: frame === 0 ? undefined : statsLines[frame - 1] };
    }
    /**
     * Discord's elapsed timer should measure the current stretch of work, so the
     * start stamp is set when the fleet goes idle→busy and cleared on the way back.
     */
    #trackBusyWindow() {
        const busy = isBusy(summarize(this.#state));
        if (busy) {
            this.#idleSince = 0;
            this.#idleCleared = false;
            this.#cancelIdleTimer();
        }
        else if (this.#idleSince === 0) {
            this.#idleSince = Date.now();
        }
        // Prefer the agent host's own start stamp: the worker is forked lazily and
        // events can arrive late, so "now" understates how long work has run. The
        // window only ever moves earlier while busy, so the timer never jumps ahead
        // when the longest-running agent finishes before the others.
        const reportedStart = busy ? busyStartedAt(this.#state, Date.now()) : undefined;
        if (busy &&
            this.#busySince !== 0 &&
            reportedStart !== undefined &&
            reportedStart < this.#busySince) {
            this.#busySince = reportedStart;
            this.#persistBusySince();
        }
        if (busy && this.#busySince === 0) {
            this.#busySince = reportedStart ?? Date.now();
            this.#persistBusySince();
        }
        else if (!busy && this.#busySince !== 0) {
            this.#busySince = 0;
            if (this.#can('storage')) {
                void this.#orca.host.call('storage.delete', { key: STORAGE_STARTED_AT_KEY }).catch(() => { });
            }
        }
    }
    #persistBusySince() {
        if (this.#can('storage')) {
            void this.#orca.host
                .call('storage.set', { key: STORAGE_STARTED_AT_KEY, value: this.#busySince })
                .catch(() => { });
        }
    }
    #schedulePublish() {
        if (this.#disposed || this.#publishTimer) {
            return;
        }
        const sinceLast = Date.now() - this.#lastPublishAt;
        const delay = Math.max(PUBLISH_DEBOUNCE_MS, MIN_PUBLISH_INTERVAL_MS - sinceLast);
        this.#publishTimer = setTimeout(() => {
            this.#publishTimer = null;
            void this.#publish();
        }, delay);
        this.#publishTimer.unref?.();
    }
    async #publish() {
        if (this.#disposed || !this.#settings.enabled || this.#settings.privacy === 'off') {
            return;
        }
        if (!this.#settings.clientId) {
            this.#lastError = 'no Discord application id configured';
            return;
        }
        if (this.#idleExpired()) {
            if (!this.#idleCleared) {
                await this.#clearPresence();
                this.#idleCleared = true;
            }
            return;
        }
        const client = await this.#ensureClient();
        if (!client || this.#disposed) {
            return;
        }
        // Built after the connect, not before: a publish that waited out a
        // handshake must send the state as it is now, not as it was then.
        this.#scheduleIdleClear();
        const now = Date.now();
        const activity = buildActivity({
            ...this.#rotationFrame(now),
            now,
            state: this.#state,
            focus: this.#focus,
            privacy: this.#settings.privacy,
            startedAt: this.#busySince,
            header: this.#settings.header,
            assets: this.#settings.assets,
            partyId: this.#partyId,
            buttons: this.#settings.buttons,
            statusLine: this.#settings.statusLine
        });
        // Why: identical payloads still cost a rate-limit slot, and a fleet can emit
        // many events that do not change what the status would say.
        const encoded = JSON.stringify(activity);
        if (encoded === this.#lastPayload) {
            return;
        }
        try {
            await client.setActivity(activity);
            this.#lastPayload = encoded;
            this.#lastPublishAt = Date.now();
            this.#lastError = null;
        }
        catch (error) {
            this.#lastError = describeError(error);
            this.#orca.log(`could not publish presence: ${this.#lastError}`);
        }
    }
    async #ensureClient() {
        if (this.#client?.connected) {
            return this.#client;
        }
        if (this.#disposed) {
            return null;
        }
        this.#connecting ??= this.#connect().finally(() => {
            this.#connecting = null;
        });
        return this.#connecting;
    }
    async #connect() {
        const client = new DiscordPresenceClient({
            clientId: this.#settings.clientId,
            log: (line) => this.#orca.log(line)
        });
        client.onDisconnect = (error) => {
            this.#client = null;
            this.#lastPayload = '';
            this.#lastError = describeError(error);
            this.#scheduleReconnect();
        };
        try {
            await client.connect();
            this.#client = client;
            this.#reconnectAttempt = 0;
            this.#lastError = null;
            return client;
        }
        catch (error) {
            this.#lastError = describeError(error);
            this.#orca.log(`discord unavailable: ${this.#lastError}`);
            this.#scheduleReconnect();
            return null;
        }
    }
    #scheduleReconnect() {
        if (this.#disposed || this.#reconnectTimer || !this.#settings.enabled) {
            return;
        }
        const index = Math.min(this.#reconnectAttempt, RECONNECT_DELAYS_MS.length - 1);
        const delay = RECONNECT_DELAYS_MS[index] ?? RECONNECT_DELAYS_MS[0];
        this.#reconnectAttempt += 1;
        this.#reconnectTimer = setTimeout(() => {
            this.#reconnectTimer = null;
            this.#schedulePublish();
        }, delay);
        this.#reconnectTimer.unref?.();
    }
    /** Idle for longer than the configured window, so the card should be gone. */
    #idleExpired() {
        return isIdleExpired({
            summary: summarize(this.#state),
            idleSince: this.#idleSince,
            now: Date.now(),
            idleClearMinutes: this.#settings.idleClearMinutes
        });
    }
    /** Arms a publish for the moment the idle window runs out, which clears the card. */
    #scheduleIdleClear() {
        const limitMs = this.#settings.idleClearMinutes * 60_000;
        if (this.#idleTimer || limitMs <= 0 || this.#idleSince === 0) {
            return;
        }
        const delay = Math.max(0, this.#idleSince + limitMs - Date.now());
        this.#idleTimer = setTimeout(() => {
            this.#idleTimer = null;
            void this.#publish();
        }, delay);
        this.#idleTimer.unref?.();
    }
    #cancelIdleTimer() {
        if (this.#idleTimer) {
            clearTimeout(this.#idleTimer);
            this.#idleTimer = null;
        }
    }
    /**
     * Applies a partial settings update from the settings page. Only known keys
     * are taken; `null` resets a key to its default. Everything is re-parsed
     * through `parseSettings`, so the page cannot store what the file could not.
     */
    async updateSettings(patch) {
        const record = typeof patch === 'object' && patch !== null ? patch : {};
        const previousClientId = this.#settings.clientId;
        for (const key of SETTINGS_KEYS) {
            if (key in record) {
                const value = (record[key] ?? null);
                this.#rawSettings[key] = value;
                await this.#saveSetting(key, value);
            }
        }
        this.#settings = parseSettings(this.#rawSettings);
        if (this.#settings.clientId !== previousClientId) {
            this.#client?.close();
            this.#client = null;
        }
        this.#taglineOrder = [];
        this.#restartRotation();
        this.#lastPayload = '';
        if (this.#settings.enabled && this.#settings.privacy !== 'off') {
            this.#schedulePublish();
        }
        else {
            await this.#clearPresence();
        }
        return this.settingsSnapshot();
    }
    /**
     * Starts the settings page (once per worker) and opens it in the browser.
     * The link is also shown as a notification and returned, for hosts or
     * platforms where launching a browser from the worker does not work.
     */
    async openSettings() {
        try {
            this.#settingsServer ??= this.#startSettingsServer().catch((error) => {
                this.#settingsServer = null;
                throw error;
            });
            const { url } = await this.#settingsServer;
            openInBrowser(url, (line) => this.#orca.log(line));
            await this.#notify('Discord Presence', `Settings opened in your browser: ${url}`);
            return { url };
        }
        catch (error) {
            const message = describeError(error);
            this.#orca.log(`settings page unavailable: ${message}`);
            await this.#notify('Discord Presence', `Could not open settings: ${message}`);
            return { url: null, error: message };
        }
    }
    async #startSettingsServer() {
        let token = null;
        if (this.#can('storage')) {
            const stored = await this.#orca.host.call('storage.get', { key: STORAGE_SETTINGS_TOKEN_KEY });
            token = typeof stored.value === 'string' && /^[0-9a-f]{48}$/.test(stored.value) ? stored.value : null;
        }
        if (!token) {
            token = createSettingsToken();
            if (this.#can('storage')) {
                await this.#orca.host.call('storage.set', { key: STORAGE_SETTINGS_TOKEN_KEY, value: token });
            }
        }
        return startSettingsServer({
            token,
            artDir: fileURLToPath(new URL('../assets/discord', import.meta.url)),
            handlers: {
                snapshot: () => this.settingsSnapshot(),
                update: (patch) => this.updateSettings(patch),
                reconnect: () => this.reconnectFromSettings()
            }
        });
    }
    /** What the settings page renders: stored values, the live card, and connection state. */
    settingsSnapshot() {
        const now = Date.now();
        // The preview mirrors Discord: nothing while publishing is off or after
        // the idle window has cleared the card.
        const showing = this.#settings.enabled && !this.#idleExpired();
        return {
            settings: { ...this.#rawSettings },
            preview: !showing ? null : buildActivity({
                ...this.#rotationFrame(now),
                now,
                state: this.#state,
                focus: this.#focus,
                privacy: this.#settings.privacy,
                startedAt: this.#busySince,
                header: this.#settings.header,
                assets: this.#settings.assets,
                partyId: this.#partyId,
                buttons: this.#settings.buttons,
                statusLine: this.#settings.statusLine
            }),
            enabled: this.#settings.enabled,
            defaultTaglines: DEFAULT_TAGLINES,
            stats: describeStats(this.#stats, now),
            connected: Boolean(this.#client?.connected),
            idleCleared: this.#idleCleared,
            lastError: this.#lastError
        };
    }
    async toggleEnabled() {
        this.#settings.enabled = !this.#settings.enabled;
        await this.#saveSetting('enabled', this.#settings.enabled);
        if (this.#settings.enabled) {
            this.#lastPayload = '';
            this.#schedulePublish();
        }
        else {
            await this.#clearPresence();
        }
        await this.#notify('Discord Presence', this.#settings.enabled ? 'Presence enabled.' : 'Presence disabled.');
        return { enabled: this.#settings.enabled };
    }
    /**
     * Sets the privacy level from the command's argument, or advances the cycle
     * when the host passes none.
     */
    async setPrivacy(args) {
        const requested = readPrivacyArg(args);
        this.#settings.privacy = requested ?? nextPrivacy(this.#settings.privacy);
        await this.#saveSetting('privacy', this.#settings.privacy);
        this.#lastPayload = '';
        if (this.#settings.privacy === 'off') {
            await this.#clearPresence();
        }
        else {
            this.#schedulePublish();
        }
        await this.#notify('Discord Presence', `Privacy level: ${this.#settings.privacy}`);
        return { privacy: this.#settings.privacy };
    }
    /**
     * Sets the header from the command's argument, or advances the preset cycle
     * when the host passes none.
     */
    async setHeader(args) {
        const requested = readHeaderArg(args);
        const next = requested ?? nextHeader(this.#settings.header ?? DEFAULT_HEADER);
        this.#settings.header = next;
        await this.#saveSetting('header', next);
        this.#lastPayload = '';
        this.#schedulePublish();
        const headerText = this.#renderHeader(next);
        // Templates and their result differ; showing both is what makes it obvious
        // that `{workspace}` is empty because privacy is masking it, not broken.
        await this.#notify('Discord Presence', next === ''
            ? 'Header hidden.'
            : next === headerText
                ? `Header: ${headerText}`
                : `Header: ${next} → ${headerText}`);
        return { header: next, headerText };
    }
    /**
     * Drops the connection and publishes again straight away.
     *
     * The reconnect backoff already recovers on its own, but only while the
     * worker is alive — Discord started after Orca, or restarted during a quiet
     * stretch, leaves a reaped worker with nothing to retry. Invoking the command
     * re-forks the worker, and this makes that fork reconnect now instead of
     * waiting out the backoff.
     */
    async reconnectNow() {
        await this.#reconnect();
        return this.reportStatus();
    }
    /** The settings page's Reconnect button: same as the command, minus the notification. */
    async reconnectFromSettings() {
        await this.#reconnect();
        return this.settingsSnapshot();
    }
    async #reconnect() {
        if (this.#reconnectTimer) {
            clearTimeout(this.#reconnectTimer);
            this.#reconnectTimer = null;
        }
        this.#reconnectAttempt = 0;
        this.#lastPayload = '';
        this.#client?.close();
        this.#client = null;
        if (!this.#settings.enabled || this.#settings.privacy === 'off') {
            return;
        }
        await this.#refreshFocus();
        if (this.#idleExpired()) {
            // Nothing to show, but the user asked to reconnect: prove Discord is
            // reachable so the next busy agent publishes straight away.
            await this.#ensureClient();
            return;
        }
        await this.#publish();
    }
    async reportStatus() {
        // The command is an explicit request for current truth; do not make the
        // user wait for the next 30-second focus poll.
        await this.#refreshFocus();
        const summary = summarize(this.#state);
        const header = this.#settings.header ?? DEFAULT_HEADER;
        const headerText = this.#renderHeader(header);
        const largeImage = this.#settings.assets.largeImage ?? DEFAULT_LARGE_IMAGE;
        // Unset follows the fleet, so report the badge that is showing right now.
        const smallImage = this.#settings.assets.smallImage ?? fleetMood(summary);
        const connection = this.#client?.connected
            ? `connected (${this.#client.socketPath})`
            : (this.#lastError ?? 'not connected');
        // Mirrors what would actually be published, workspace names included — the
        // point of the command is to show what Discord is being told.
        const body = [
            `${this.#settings.enabled ? 'Enabled' : 'Disabled'} · privacy: ${this.#settings.privacy}`,
            [headerText, describeActivity(summary, this.#visibleWorkspaces(summary))]
                .filter(Boolean)
                .join(' · '),
            `logo: ${largeImage || 'off'}${smallImage ? ` · badge: ${smallImage}` : ''}`,
            connection
        ].join('\n');
        await this.#notify('Discord Presence', body);
        return {
            enabled: this.#settings.enabled,
            privacy: this.#settings.privacy,
            connected: Boolean(this.#client?.connected),
            socketPath: this.#client?.socketPath ?? null,
            usingDefaultApplication: this.#settings.clientId === DEFAULT_CLIENT_ID,
            header,
            headerText,
            largeImage,
            smallImage,
            summary,
            idleClearMinutes: this.#settings.idleClearMinutes,
            idleCleared: this.#idleCleared,
            lastError: this.#lastError
        };
    }
    #renderHeader(template) {
        return renderHeader(template, {
            focus: this.#focus,
            state: this.#state,
            privacy: this.#settings.privacy
        });
    }
    /** Workspace names only leak into the status line at `full` privacy. */
    #visibleWorkspaces(summary) {
        return this.#settings.privacy === 'full' ? describeWorkspaces(this.#state, summary) : [];
    }
    async #clearPresence() {
        this.#lastPayload = '';
        if (!this.#client?.connected) {
            return;
        }
        try {
            await this.#client.setActivity(null);
        }
        catch (error) {
            this.#orca.log(`could not clear presence: ${describeError(error)}`);
        }
    }
    async #notify(title, body) {
        if (!this.#can('notifications:show')) {
            return;
        }
        try {
            await this.#orca.host.call('notifications.show', { title, body });
        }
        catch (error) {
            this.#orca.log(`${title}: ${body} (${describeError(error)})`);
        }
    }
    /** Graceful stop: drop the status first, then tear the connection down. */
    async shutdown() {
        if (this.#disposed) {
            return;
        }
        try {
            await this.#clearPresence();
        }
        catch {
            // Nothing actionable during teardown.
        }
        this.dispose();
    }
    dispose() {
        this.#disposed = true;
        if (this.#publishTimer) {
            clearTimeout(this.#publishTimer);
        }
        if (this.#reconnectTimer) {
            clearTimeout(this.#reconnectTimer);
        }
        if (this.#focusTimer) {
            clearInterval(this.#focusTimer);
        }
        this.#cancelIdleTimer();
        if (this.#rotationTimer) {
            clearInterval(this.#rotationTimer);
            this.#rotationTimer = null;
        }
        void this.#settingsServer?.then((server) => server.close()).catch(() => { });
        this.#settingsServer = null;
        this.#publishTimer = null;
        this.#reconnectTimer = null;
        this.#focusTimer = null;
        this.#client?.close();
        this.#client = null;
    }
}
/** Terminals are irrelevant to the card, so they do not make a focus change. */
function sameFocus(left, right) {
    return ((left?.displayName.trim() ?? '') === (right?.displayName.trim() ?? '') &&
        (left?.branch.trim() ?? '') === (right?.branch.trim() ?? ''));
}
function describeError(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * Opens a URL in the user's default browser. Fire-and-forget: a missing
 * opener (a headless Linux box) must cost a log line, not the worker.
 */
function openInBrowser(url, log) {
    if (process.env['ORCA_DISCORD_PRESENCE_NO_BROWSER'] === '1') {
        return;
    }
    const [command, args] = process.platform === 'darwin'
        ? ['open', [url]]
        : process.platform === 'win32'
            ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]]
            : ['xdg-open', [url]];
    try {
        const child = spawn(command, args, { detached: true, stdio: 'ignore' });
        child.on('error', (error) => log(`could not open a browser: ${error.message}`));
        child.unref();
    }
    catch (error) {
        log(`could not open a browser: ${describeError(error)}`);
    }
}
/** Every key the settings file and the settings page may carry. */
export const SETTINGS_KEYS = [
    'enabled',
    'privacy',
    'clientId',
    'header',
    'largeImage',
    'largeText',
    'smallImage',
    'smallText',
    'buttons',
    'statusLine',
    'idleClearMinutes',
    'taglines',
    'customTaglines',
    'showStats',
    'rotateSeconds'
];
/**
 * The one validator for settings, whether they came from the settings file or
 * the settings page. Anything malformed falls back to its default rather than
 * reaching Discord.
 */
export function parseSettings(stored) {
    return {
        enabled: stored['enabled'] !== false,
        privacy: isPrivacyLevel(stored['privacy']) ? stored['privacy'] : DEFAULT_PRIVACY,
        clientId: readClientId(stored['clientId']),
        header: readOptionalString(stored['header']),
        assets: {
            largeImage: readOptionalString(stored['largeImage']),
            largeText: readOptionalString(stored['largeText']),
            smallImage: readOptionalString(stored['smallImage']),
            smallText: readOptionalString(stored['smallText'])
        },
        // `false` is accepted as "no buttons" — friendlier to hand-edit than `[]`.
        buttons: stored['buttons'] === false ? [] : sanitizeButtons(stored['buttons']),
        statusLine: isStatusLine(stored['statusLine']) ? stored['statusLine'] : undefined,
        idleClearMinutes: readIdleClearMinutes(stored['idleClearMinutes']),
        taglines: stored['taglines'] !== false,
        customTaglines: sanitizeTaglines(stored['customTaglines']),
        showStats: stored['showStats'] !== false,
        rotateSeconds: readRotateSeconds(stored['rotateSeconds'])
    };
}
/** Seconds between rotations, never faster than Discord's rate limit allows. */
function readRotateSeconds(configured) {
    return typeof configured === 'number' && Number.isFinite(configured)
        ? Math.max(MIN_ROTATE_SECONDS, configured)
        : DEFAULT_ROTATE_SECONDS;
}
/** Whole minutes, 0 or more; anything else takes the default. */
function readIdleClearMinutes(configured) {
    return typeof configured === 'number' && Number.isFinite(configured) && configured >= 0
        ? configured
        : DEFAULT_IDLE_CLEAR_MINUTES;
}
/** A configured id wins; anything blank or non-string falls back to the default. */
function readClientId(configured) {
    if (typeof configured === 'string' && configured.trim().length > 0) {
        return configured.trim();
    }
    return DEFAULT_CLIENT_ID;
}
/**
 * Keeps `""` distinct from "absent": a blank string is how the settings file
 * turns the header or the logo off, whereas a missing key takes the default.
 */
function readOptionalString(configured) {
    return typeof configured === 'string' ? configured.trim() : undefined;
}
/**
 * Privacy level handed to the command. Same shapes as the header argument,
 * since both travel through Orca's `unknown` command argument; anything that
 * is not a known level means "no argument", which cycles instead.
 */
function readPrivacyArg(args) {
    if (isPrivacyLevel(args)) {
        return args;
    }
    if (typeof args === 'object' && args !== null) {
        const record = args;
        for (const key of ['privacy', 'level', 'value']) {
            const candidate = record[key];
            if (isPrivacyLevel(candidate)) {
                return candidate;
            }
        }
    }
    return undefined;
}
/**
 * Header handed to the command. Accepts a bare string or the object shapes a
 * host or keybinding is likely to send, since Orca's command arguments are
 * `unknown` by contract. `""` is a value, not an absence — it hides the header.
 */
function readHeaderArg(args) {
    if (typeof args === 'string') {
        return args.trim();
    }
    if (typeof args === 'object' && args !== null) {
        const record = args;
        for (const key of ['header', 'value', 'text']) {
            const candidate = record[key];
            if (typeof candidate === 'string') {
                return candidate.trim();
            }
        }
    }
    return undefined;
}
//# sourceMappingURL=main.mjs.map