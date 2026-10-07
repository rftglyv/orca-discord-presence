/**
 * Discord Rich Presence socket discovery.
 *
 * Discord listens on a local IPC endpoint named `discord-ipc-<n>`, where `n`
 * counts up from 0 for each concurrently running client. Where that endpoint
 * lives depends on the platform and on how Discord was packaged.
 *
 * The hard case is Linux under Orca. The plugin worker's environment is an
 * allowlist (see Orca's `plugin-worker-env.ts`) that deliberately omits
 * `XDG_RUNTIME_DIR` — the variable that normally points at `/run/user/<uid>`,
 * where the socket actually is. So we reconstruct that path from the uid
 * instead of trusting the environment to carry it.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Discord numbers sockets 0..9; beyond that it stops accepting clients. */
export const IPC_INDEX_LIMIT = 10

/**
 * Sandboxed builds keep their socket under a private subdirectory of the
 * runtime dir rather than at its root, so a plain `/run/user/<uid>` scan
 * misses every Flatpak and Snap install.
 */
const SANDBOX_SUBDIRS = [
  '',
  'app/com.discordapp.Discord',
  'app/com.discordapp.DiscordCanary',
  'app/com.discordapp.DiscordPTB',
  'snap.discord',
  'snap.discord-canary',
  // Vesktop (Vencord's desktop client) as a Flatpak, which also speaks the IPC protocol.
  'app/dev.vencord.Vesktop'
] as const

export type SocketProbeOptions = {
  platform: NodeJS.Platform | string
  env?: NodeJS.ProcessEnv
  uid?: number | undefined
}

function pushBase(bases: string[], value: string | undefined): void {
  if (typeof value === 'string' && value.length > 0 && !bases.includes(value)) {
    bases.push(value)
  }
}

/**
 * Runtime directories to scan on macOS and Linux, most specific first.
 * `uid` is optional so callers on platforms without uids (and tests) can omit it.
 */
export function posixRuntimeBases({
  env = {},
  uid
}: {
  env?: NodeJS.ProcessEnv
  uid?: number | undefined
}): string[] {
  const bases: string[] = []
  // Present when Orca's env allowlist grows, or when the plugin runs outside
  // the worker (tests, manual probing). Cheap to honour, so honour it first.
  pushBase(bases, env['XDG_RUNTIME_DIR'])
  // Why: the allowlist drops XDG_RUNTIME_DIR today, and this reconstruction is
  // what makes Linux work at all — `/run/user/<uid>` is where systemd-logind
  // puts the runtime dir on every mainstream distro.
  if (typeof uid === 'number' && Number.isInteger(uid) && uid >= 0) {
    pushBase(bases, `/run/user/${uid}`)
  }
  // macOS puts it in the per-user temp dir, which the allowlist does carry.
  pushBase(bases, env['TMPDIR'])
  pushBase(bases, env['TMP'])
  pushBase(bases, env['TEMP'])
  pushBase(bases, '/tmp')
  return bases
}

/**
 * Every path worth trying, in probe order. Windows named pipes need no
 * directory search — the pipe namespace is flat and global.
 */
export function candidateSocketPaths({
  platform,
  env = {},
  uid
}: SocketProbeOptions): string[] {
  if (platform === 'win32') {
    const pipes: string[] = []
    for (let index = 0; index < IPC_INDEX_LIMIT; index += 1) {
      pipes.push(`\\\\?\\pipe\\discord-ipc-${index}`)
    }
    return pipes
  }

  const paths: string[] = []
  const seen = new Set<string>()
  for (const base of posixRuntimeBases({ env, uid })) {
    for (const subdir of SANDBOX_SUBDIRS) {
      for (let index = 0; index < IPC_INDEX_LIMIT; index += 1) {
        const path = join(base, subdir, `discord-ipc-${index}`)
        if (!seen.has(path)) {
          seen.add(path)
          paths.push(path)
        }
      }
    }
  }
  return paths
}

/**
 * Narrow the candidate list to paths that exist. Windows is returned unfiltered:
 * `existsSync` does not report named pipes reliably, so there the connect
 * attempt itself is the existence check.
 */
export function probeSocketPaths({
  platform,
  env = {},
  uid,
  exists = existsSync
}: SocketProbeOptions & { exists?: (path: string) => boolean }): string[] {
  const candidates = candidateSocketPaths({ platform, env, uid })
  if (platform === 'win32') {
    return candidates
  }
  return candidates.filter((path) => {
    try {
      return exists(path)
    } catch {
      return false
    }
  })
}
