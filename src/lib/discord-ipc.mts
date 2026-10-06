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

import net from 'node:net'
import { randomUUID } from 'node:crypto'
import { probeSocketPaths } from './socket-path.mjs'

export const OP = {
  HANDSHAKE: 0,
  FRAME: 1,
  CLOSE: 2,
  PING: 3,
  PONG: 4
} as const

export type Opcode = (typeof OP)[keyof typeof OP]

const HEADER_BYTES = 8
/** Defensive cap: a well-behaved Discord never sends frames near this size. */
const MAX_PAYLOAD_BYTES = 1024 * 1024
const CONNECT_TIMEOUT_MS = 5_000
const READY_TIMEOUT_MS = 10_000

/** The subset of Discord's response envelope this client acts on. */
type IpcResponse = {
  cmd?: string
  evt?: string | null
  nonce?: string | null
  data?: { message?: string } & Record<string, unknown>
  message?: string
}

export type DecodedFrame = { op: number; data: IpcResponse }

/**
 * Rich Presence activity payload. Only the fields this plugin sets are
 * declared; Discord ignores unknown keys but there is no reason to invent them.
 */
export type DiscordActivity = {
  /** Activity type; 0 renders as "Playing <application name>". */
  type?: 0
  /**
   * Which line Discord shows beside the name in the member list and DM list:
   * 0 = application name, 1 = `state`, 2 = `details`.
   */
  status_display_type?: 0 | 1 | 2
  details?: string
  state?: string
  timestamps?: { start?: number; end?: number }
  assets?: {
    large_image?: string
    large_text?: string
    small_image?: string
    small_text?: string
  }
  /**
   * Renders as `(2 of 5)` beside the status line. `size` is
   * `[current, max]`; `id` groups a party for join invites, which this plugin
   * never sends — without a join secret Discord shows no button, so the id is
   * only ever a per-worker opaque string.
   */
  party?: { id?: string; size?: [number, number] }
  /** Up to two link buttons; Discord shows them to everyone but the user. */
  buttons?: Array<{ label: string; url: string }>
  instance?: boolean
}

/**
 * Arguments for Discord's SET_ACTIVITY command.
 *
 * `null` must survive JSON serialization: it is the protocol's explicit
 * "clear this process' activity" value. Omitting the property leaves Discord
 * free to retain the previous card.
 */
export function activityCommandArgs(
  activity: DiscordActivity | null,
  pid: number = process.pid
): { pid: number; activity: DiscordActivity | null } {
  return { pid, activity }
}

export function encodeFrame(op: number, payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  const frame = Buffer.allocUnsafe(HEADER_BYTES + body.length)
  frame.writeInt32LE(op, 0)
  frame.writeInt32LE(body.length, 4)
  body.copy(frame, HEADER_BYTES)
  return frame
}

/**
 * Streaming frame decoder. Returns a `push(chunk)` that yields whole frames and
 * keeps the remainder buffered — a socket read can split or coalesce frames
 * arbitrarily, so neither "one chunk is one frame" nor "one frame per read"
 * holds.
 */
export function createFrameDecoder(): (chunk: Buffer) => DecodedFrame[] {
  let buffered = Buffer.alloc(0)
  return function push(chunk: Buffer): DecodedFrame[] {
    buffered = Buffer.concat([buffered, chunk])
    const frames: DecodedFrame[] = []
    while (buffered.length >= HEADER_BYTES) {
      const op = buffered.readInt32LE(0)
      const length = buffered.readInt32LE(4)
      if (length < 0 || length > MAX_PAYLOAD_BYTES) {
        throw new Error(`discord ipc: refusing frame with length ${length}`)
      }
      if (buffered.length < HEADER_BYTES + length) {
        break
      }
      const body = buffered.subarray(HEADER_BYTES, HEADER_BYTES + length)
      buffered = buffered.subarray(HEADER_BYTES + length)
      let data: IpcResponse
      try {
        data = JSON.parse(body.toString('utf8')) as IpcResponse
      } catch {
        throw new Error('discord ipc: frame payload was not JSON')
      }
      frames.push({ op, data })
    }
    return frames
  }
}

function connectToPath(path: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`discord ipc: connect timed out on ${path}`))
    }, CONNECT_TIMEOUT_MS)
    const fail = (error: Error): void => {
      clearTimeout(timer)
      socket.destroy()
      reject(error)
    }
    socket.once('error', fail)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.removeListener('error', fail)
      resolve(socket)
    })
  })
}

type PendingCall = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export type DiscordPresenceClientOptions = {
  clientId: string
  log?: (message: string) => void
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
}

/**
 * Connects, handshakes, and keeps one activity published.
 *
 * The client owns no retry policy of its own — the caller drives reconnection,
 * because in Orca the worker itself may be reaped at any time and a retry loop
 * that outlives its owner is worse than no retry loop.
 */
export class DiscordPresenceClient {
  readonly clientId: string
  connected = false
  socketPath: string | null = null
  onDisconnect: ((error: Error) => void) | null = null

  readonly #log: (message: string) => void
  readonly #platform: NodeJS.Platform
  readonly #env: NodeJS.ProcessEnv
  readonly #pending = new Map<string, PendingCall>()
  #socket: net.Socket | null = null

  constructor({
    clientId,
    log = () => {},
    platform = process.platform,
    env = process.env
  }: DiscordPresenceClientOptions) {
    this.clientId = clientId
    this.#log = log
    this.#platform = platform
    this.#env = env
  }

  /** Tries every candidate path until one completes a handshake. */
  async connect(): Promise<string> {
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
    const candidates = probeSocketPaths({ platform: this.#platform, env: this.#env, uid })
    if (candidates.length === 0) {
      throw new Error('discord ipc: no candidate socket found — is Discord running?')
    }
    let lastError: Error | null = null
    for (const path of candidates) {
      try {
        const socket = await connectToPath(path)
        await this.#handshake(socket)
        this.#socket = socket
        this.socketPath = path
        this.connected = true
        this.#log(`connected to ${path}`)
        return path
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
      }
    }
    throw lastError ?? new Error('discord ipc: every candidate socket refused')
  }

  #handshake(socket: net.Socket): Promise<void> {
    return new Promise((resolve, reject) => {
      const decode = createFrameDecoder()
      const timer = setTimeout(() => {
        cleanup()
        socket.destroy()
        reject(new Error('discord ipc: handshake timed out'))
      }, READY_TIMEOUT_MS)

      const onData = (chunk: Buffer): void => {
        let frames: DecodedFrame[]
        try {
          frames = decode(chunk)
        } catch (error) {
          cleanup()
          socket.destroy()
          reject(error instanceof Error ? error : new Error(String(error)))
          return
        }
        for (const frame of frames) {
          if (frame.op === OP.CLOSE) {
            cleanup()
            socket.destroy()
            reject(new Error(`discord ipc: closed during handshake (${frame.data.message ?? ''})`))
            return
          }
          if (frame.op === OP.FRAME && frame.data.evt === 'READY') {
            cleanup()
            this.#attach(socket)
            resolve()
            return
          }
        }
      }
      const onError = (error: Error): void => {
        cleanup()
        reject(error)
      }
      function cleanup(): void {
        clearTimeout(timer)
        socket.removeListener('data', onData)
        socket.removeListener('error', onError)
      }

      socket.on('data', onData)
      socket.once('error', onError)
      socket.write(encodeFrame(OP.HANDSHAKE, { v: 1, client_id: this.clientId }))
    })
  }

  /** Wires the long-lived listeners once the handshake has succeeded. */
  #attach(socket: net.Socket): void {
    const decode = createFrameDecoder()
    socket.on('data', (chunk: Buffer) => {
      let frames: DecodedFrame[]
      try {
        frames = decode(chunk)
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error))
        this.#log(`protocol error: ${failure.message}`)
        this.#teardown(failure)
        return
      }
      for (const frame of frames) {
        this.#handleFrame(frame)
      }
    })
    socket.on('error', (error: Error) => this.#teardown(error))
    socket.on('close', () => this.#teardown(new Error('discord ipc: socket closed')))
  }

  #handleFrame(frame: DecodedFrame): void {
    if (frame.op === OP.PING) {
      this.#socket?.write(encodeFrame(OP.PONG, frame.data))
      return
    }
    if (frame.op === OP.CLOSE) {
      this.#teardown(new Error(`discord ipc: server closed (${frame.data.message ?? ''})`))
      return
    }
    if (frame.op !== OP.FRAME) {
      return
    }
    const nonce = frame.data.nonce
    const entry = nonce ? this.#pending.get(nonce) : undefined
    if (!entry || !nonce) {
      return
    }
    this.#pending.delete(nonce)
    clearTimeout(entry.timer)
    if (frame.data.evt === 'ERROR') {
      entry.reject(new Error(frame.data.data?.message ?? 'discord ipc: command rejected'))
    } else {
      entry.resolve(frame.data.data ?? null)
    }
  }

  #teardown(error: Error): void {
    if (!this.connected && !this.#socket) {
      return
    }
    this.connected = false
    const socket = this.#socket
    this.#socket = null
    for (const [nonce, entry] of this.#pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
      this.#pending.delete(nonce)
    }
    socket?.destroy()
    this.onDisconnect?.(error)
  }

  #command(cmd: string, args: unknown): Promise<unknown> {
    const socket = this.#socket
    if (!this.connected || !socket) {
      return Promise.reject(new Error('discord ipc: not connected'))
    }
    const nonce = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(nonce)
        reject(new Error(`discord ipc: ${cmd} timed out`))
      }, READY_TIMEOUT_MS)
      this.#pending.set(nonce, { resolve, reject, timer })
      socket.write(encodeFrame(OP.FRAME, { cmd, args, nonce }))
    })
  }

  /** `activity: null` clears the status without dropping the connection. */
  setActivity(activity: DiscordActivity | null): Promise<unknown> {
    return this.#command('SET_ACTIVITY', activityCommandArgs(activity))
  }

  close(): void {
    const socket = this.#socket
    this.connected = false
    this.#socket = null
    this.onDisconnect = null
    for (const [nonce, entry] of this.#pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error('discord ipc: client closed'))
      this.#pending.delete(nonce)
    }
    if (socket) {
      try {
        socket.write(encodeFrame(OP.CLOSE, {}))
      } catch {
        // Socket already gone; destroying is all that is left to do.
      }
      socket.destroy()
    }
  }
}
