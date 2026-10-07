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
import { type DiscordActivity } from './lib/discord-ipc.mjs';
import type { JsonValue, OrcaPluginApi } from './lib/orca-api.mjs';
import { type PresenceAssets, type PresenceButton, type PresenceSummary, type PrivacyLevel, type StatusLine } from './lib/presence-model.mjs';
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
export declare const DEFAULT_CLIENT_ID = "1557157916279185418";
/**
 * How long an idle fleet keeps its card before the status is cleared. The
 * workspace poll keeps the worker alive indefinitely, so without this a
 * "Fleet idle" card would sit on the profile all night.
 */
export declare const DEFAULT_IDLE_CLEAR_MINUTES = 15;
/**
 * How often the card rotates its tagline and stats. Discord throttles
 * SET_ACTIVITY at roughly 5 calls per 20s; one change every 20s at the
 * fastest leaves room for real status changes in between.
 */
export declare const DEFAULT_ROTATE_SECONDS = 45;
export declare const MIN_ROTATE_SECONDS = 20;
/**
 * `header` and the asset keys are `undefined` when unset so the model can tell
 * "not configured" (take the default) from `""` (deliberately turned off).
 */
type PluginSettings = {
    enabled: boolean;
    privacy: PrivacyLevel;
    clientId: string;
    header: string | undefined;
    assets: PresenceAssets;
    /** `undefined` takes the default button; `[]` publishes none. */
    buttons: PresenceButton[] | undefined;
    statusLine: StatusLine | undefined;
    /** Minutes an idle fleet stays on the card; 0 keeps it forever. */
    idleClearMinutes: number;
    /** Rotate a tagline through the details line. */
    taglines: boolean;
    /** The user's own lines; `undefined` uses the built-in set. */
    customTaglines: string[] | undefined;
    /** Rotate today's and all-time stats through the state line. */
    showStats: boolean;
    rotateSeconds: number;
};
export type SettingsSnapshot = {
    settings: Record<string, JsonValue>;
    /** The card as it would publish right now; `null` when nothing would show. */
    preview: DiscordActivity | null;
    defaultTaglines: readonly string[];
    stats: string[];
    connected: boolean;
    idleCleared: boolean;
    lastError: string | null;
};
export type PresenceStatusReport = {
    enabled: boolean;
    privacy: PrivacyLevel;
    connected: boolean;
    socketPath: string | null;
    /** False once `clientId` in settings points at the user's own application. */
    usingDefaultApplication: boolean;
    /** The header template as configured — may still hold `{workspace}`. */
    header: string;
    /** The header as published, tokens resolved against the current privacy. */
    headerText: string;
    /** Art asset key published as the large image; empty when turned off. */
    largeImage: string;
    /** Art asset key published as the badge; follows the fleet unless configured, empty when off. */
    smallImage: string;
    summary: PresenceSummary;
    /** Minutes an idle fleet keeps its card; 0 keeps it forever. */
    idleClearMinutes: number;
    /** True when the idle window has run out and the card has been cleared. */
    idleCleared: boolean;
    lastError: string | null;
};
export default function activate(orca: OrcaPluginApi): void;
export declare function deactivate(): Promise<void>;
/** Every key the settings file and the settings page may carry. */
export declare const SETTINGS_KEYS: readonly ['enabled', 'privacy', 'clientId', 'header', 'largeImage', 'largeText', 'smallImage', 'smallText', 'buttons', 'statusLine', 'idleClearMinutes', 'taglines', 'customTaglines', 'showStats', 'rotateSeconds'];
/**
 * The one validator for settings, whether they came from the settings file or
 * the settings page. Anything malformed falls back to its default rather than
 * reaching Discord.
 */
export declare function parseSettings(stored: Record<string, JsonValue>): PluginSettings;
export {};
