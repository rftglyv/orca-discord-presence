/**
 * Rotating one-liners for the card's details line. They carry no workspace,
 * branch, or project names, so they are safe at every privacy level except
 * `off`. Each stays within Discord's 2–128 character field limit.
 */
export declare const DEFAULT_TAGLINES: readonly string[];
/**
 * Picks the line for a rotation tick. The order is a shuffle seeded per
 * worker, so consecutive ticks never repeat a line until the list wraps, and
 * two Orca users running the plugin do not show the same line in lockstep.
 */
export declare function pickTagline(taglines: readonly string[], tick: number, order: readonly number[]): string | undefined;
/** Fisher–Yates over the indices, with an injectable source for tests. */
export declare function shuffledOrder(length: number, random?: () => number): number[];
/**
 * Accepts a configured list only if it has at least one usable line; blank,
 * non-string, and out-of-range entries are dropped rather than sent, since
 * Discord rejects the whole update over one bad field.
 */
export declare function sanitizeTaglines(raw: unknown): string[] | undefined;
