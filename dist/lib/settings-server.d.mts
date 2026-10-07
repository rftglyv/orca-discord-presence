/**
 * Local settings page: a tiny HTTP server on 127.0.0.1 that serves one page
 * and a two-route JSON API, so users can pick what the card shows without
 * hand-editing `settings.json` (Orca has no per-plugin settings UI).
 *
 * The page can change what is published to the user's Discord profile, so
 * every request must carry a random token, and the Host header must be the
 * loopback address we bound — which stops DNS-rebinding pages from reaching
 * it. Writes also require a custom header, which a cross-origin page cannot
 * send without a CORS preflight this server never approves.
 */
/** Tried first so a bookmarked link keeps working across worker restarts. */
export declare const PREFERRED_PORT = 47317;
/**
 * The friendly address. Browsers and macOS resolve every `*.localhost` name to
 * the loopback interface with no DNS or hosts-file change (RFC 6761), so this
 * works out of the box — Chrome-family browsers map it to 127.0.0.1, macOS's
 * resolver to ::1, which is why the server listens on both.
 */
export declare const FRIENDLY_HOST = "orcadcrpc.localhost";
export type SettingsServerHandlers = {
    snapshot: () => unknown;
    update: (patch: unknown) => Promise<unknown>;
    reconnect: () => Promise<unknown>;
};
export type SettingsServer = {
    url: string;
    close: () => Promise<void>;
};
export declare function createSettingsToken(): string;
export declare function startSettingsServer({ token, handlers, artDir, preferredPort }: {
    token: string;
    handlers: SettingsServerHandlers;
    /** Directory holding the card artwork, for the page's preview. */
    artDir: string;
    preferredPort?: number;
}): Promise<SettingsServer>;
