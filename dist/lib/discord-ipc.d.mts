/**
 * Minimal Discord Rich Presence IPC client.
 *
 * Deliberately dependency-free: Orca installs plugins as plain directories with
 * no install step, so a `node_modules` tree would have to be vendored into the
 * repo. The protocol is small enough that talking to it directly is less code
 * than vendoring `discord-rpc` would be.
 *
 * Wire format is an 8-byte little-endian header (opcode, payload length)
 * followed by a UTF-8 JSON payload.
 */
export declare const OP: {
    readonly HANDSHAKE: 0;
    readonly FRAME: 1;
    readonly CLOSE: 2;
    readonly PING: 3;
    readonly PONG: 4;
};
export type Opcode = (typeof OP)[keyof typeof OP];
/** The subset of Discord's response envelope this client acts on. */
type IpcResponse = {
    cmd?: string;
    evt?: string | null;
    nonce?: string | null;
    data?: {
        message?: string;
    } & Record<string, unknown>;
    message?: string;
};
export type DecodedFrame = {
    op: number;
    data: IpcResponse;
};
/**
 * Rich Presence activity payload. Only the fields this plugin sets are
 * declared; Discord ignores unknown keys but there is no reason to invent them.
 */
export type DiscordActivity = {
    /** Activity type; 0 renders as "Playing <application name>". */
    type?: 0;
    /**
     * Which line Discord shows beside the name in the member list and DM list:
     * 0 = application name, 1 = `state`, 2 = `details`.
     */
    status_display_type?: 0 | 1 | 2;
    details?: string;
    state?: string;
    timestamps?: {
        start?: number;
        end?: number;
    };
    assets?: {
        large_image?: string;
        large_text?: string;
        small_image?: string;
        small_text?: string;
    };
    /**
     * Renders as `(2 of 5)` beside the status line. `size` is
     * `[current, max]`; `id` groups a party for join invites, which this plugin
     * never sends — without a join secret Discord shows no button, so the id is
     * only ever a per-worker opaque string.
     */
    party?: {
        id?: string;
        size?: [number, number];
    };
    /** Up to two link buttons; Discord shows them to everyone but the user. */
    buttons?: Array<{
        label: string;
        url: string;
    }>;
    instance?: boolean;
};
/**
 * Arguments for Discord's SET_ACTIVITY command.
 *
 * `null` must survive JSON serialization: it is the protocol's explicit
 * "clear this process' activity" value. Omitting the property leaves Discord
 * free to retain the previous card.
 */
export declare function activityCommandArgs(activity: DiscordActivity | null, pid?: number): {
    pid: number;
    activity: DiscordActivity | null;
};
export declare function encodeFrame(op: number, payload: unknown): Buffer;
/**
 * Streaming frame decoder. Returns a `push(chunk)` that yields whole frames and
 * keeps the remainder buffered — a socket read can split or coalesce frames
 * arbitrarily, so neither "one chunk is one frame" nor "one frame per read"
 * holds.
 */
export declare function createFrameDecoder(): (chunk: Buffer) => DecodedFrame[];
export type DiscordPresenceClientOptions = {
    clientId: string;
    log?: (message: string) => void;
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
};
/**
 * Connects, handshakes, and keeps one activity published.
 *
 * The client owns no retry policy of its own — the caller drives reconnection,
 * because in Orca the worker itself may be reaped at any time and a retry loop
 * that outlives its owner is worse than no retry loop.
 */
export declare class DiscordPresenceClient {
    #private;
    readonly clientId: string;
    connected: boolean;
    socketPath: string | null;
    onDisconnect: ((error: Error) => void) | null;
    constructor({ clientId, log, platform, env }: DiscordPresenceClientOptions);
    /** Tries every candidate path until one completes a handshake. */
    connect(): Promise<string>;
    /** `activity: null` clears the status without dropping the connection. */
    setActivity(activity: DiscordActivity | null): Promise<unknown>;
    close(): void;
}
export {};
