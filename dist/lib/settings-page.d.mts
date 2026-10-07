/**
 * The settings page served by `settings-server.mts`. Self-contained (no
 * external requests — the CSP forbids them), and every value from the API is
 * written with `textContent` / `.value`, never parsed as HTML.
 *
 * The embedded script avoids template literals so this file can hold it in
 * one TypeScript template string without escaping.
 */
export declare const SETTINGS_PAGE_HTML: string;
