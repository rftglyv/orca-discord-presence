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

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { SETTINGS_PAGE_HTML } from './settings-page.mjs'

const MAX_BODY_BYTES = 64 * 1024
/** Tried first so a bookmarked link keeps working across worker restarts. */
export const PREFERRED_PORT = 47_317
/**
 * The friendly address. Browsers and macOS resolve every `*.localhost` name to
 * the loopback interface with no DNS or hosts-file change (RFC 6761), so this
 * works out of the box — Chrome-family browsers map it to 127.0.0.1, macOS's
 * resolver to ::1, which is why the server listens on both.
 */
export const FRIENDLY_HOST = 'orcadcrpc.localhost'
const TOKEN_PLACEHOLDER = '__SETTINGS_TOKEN__'
const ART_FILES = new Set(['orca.png', 'working.png', 'waiting.png', 'idle.png'])

export type SettingsServerHandlers = {
  snapshot: () => unknown
  update: (patch: unknown) => Promise<unknown>
  reconnect: () => Promise<unknown>
}

export type SettingsServer = {
  url: string
  close: () => Promise<void>
}

export function createSettingsToken(): string {
  return randomBytes(24).toString('hex')
}

function tokensMatch(expected: string, given: string | null | undefined): boolean {
  if (typeof given !== 'string') {
    return false
  }
  const left = Buffer.from(expected)
  const right = Buffer.from(given)
  return left.length === right.length && timingSafeEqual(left, right)
}

function send(
  response: http.ServerResponse,
  status: number,
  body: string | Buffer,
  type = 'application/json; charset=utf-8'
): void {
  response.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    // The page is served to the user's own browser; nothing may frame it.
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy':
      "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'"
  })
  response.end(body)
}

function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

function listen(server: http.Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.removeListener('error', onError)
      resolve((server.address() as AddressInfo).port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

export async function startSettingsServer({
  token,
  handlers,
  artDir,
  preferredPort = PREFERRED_PORT
}: {
  token: string
  handlers: SettingsServerHandlers
  /** Directory holding the card artwork, for the page's preview. */
  artDir: string
  preferredPort?: number
}): Promise<SettingsServer> {
  let allowedHosts = new Set<string>()
  const handle: http.RequestListener = (request, response) => {
    void (async () => {
      // Only our own loopback names: a DNS-rebinding page arrives with its
      // own hostname in Host, and is turned away here.
      const host = request.headers.host ?? ''
      if (!allowedHosts.has(host)) {
        send(response, 421, '{"error":"wrong host"}')
        return
      }
      const url = new URL(request.url ?? '/', `http://${host}`)

      if (request.method === 'GET' && url.pathname === '/') {
        // The page carries the API token inline. Another origin cannot read
        // this response (same-origin policy) or frame it (X-Frame-Options),
        // so typing the bare address is as safe as following the link.
        send(response, 200, SETTINGS_PAGE_HTML.replace(TOKEN_PLACEHOLDER, token), 'text/html; charset=utf-8')
        return
      }

      // Artwork carries nothing private; it is served without the token so
      // <img> tags in the page need no credentials.
      const art = url.pathname.match(/^\/art\/([a-z]+\.png)$/)
      if (request.method === 'GET' && art && ART_FILES.has(art[1] as string)) {
        try {
          send(response, 200, await readFile(`${artDir}/${art[1]}`), 'image/png')
        } catch {
          send(response, 404, '{"error":"missing art"}')
        }
        return
      }

      if (url.pathname.startsWith('/api/')) {
        // Browsers stamp requests with where they came from. Another site's
        // script — even one that guessed the port — never reaches the API.
        // (Opening the page from a link is cross-site too, and is fine: the
        // page itself only reads, and another origin cannot see it.)
        if (request.headers['sec-fetch-site'] === 'cross-site') {
          send(response, 403, '{"error":"cross-site request"}')
          return
        }
        const header = request.headers['x-settings-token']
        if (!tokensMatch(token, Array.isArray(header) ? header[0] : header)) {
          send(response, 403, '{"error":"bad token"}')
          return
        }
        if (request.method === 'GET' && url.pathname === '/api/state') {
          send(response, 200, JSON.stringify(handlers.snapshot()))
          return
        }
        if (request.method === 'POST' && url.pathname === '/api/reconnect') {
          send(response, 200, JSON.stringify(await handlers.reconnect()))
          return
        }
        if (request.method === 'POST' && url.pathname === '/api/settings') {
          let patch: unknown
          try {
            patch = JSON.parse(await readBody(request))
          } catch {
            send(response, 400, '{"error":"invalid JSON"}')
            return
          }
          send(response, 200, JSON.stringify(await handlers.update(patch)))
          return
        }
      }
      send(response, 404, '{"error":"not found"}')
    })().catch((error: unknown) => {
      if (!response.headersSent) {
        send(response, 500, JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
      }
    })
  }

  const ipv4 = http.createServer(handle)
  let port: number
  try {
    port = await listen(ipv4, '127.0.0.1', preferredPort)
  } catch {
    port = await listen(ipv4, '127.0.0.1', 0)
  }
  const servers = [ipv4]
  // Best effort: a machine without IPv6 loopback still has the 127.0.0.1 address.
  const ipv6 = http.createServer(handle)
  try {
    await listen(ipv6, '::1', port)
    servers.push(ipv6)
  } catch {
    // Nothing to do; the friendly name falls back to 127.0.0.1 in Chrome-family browsers.
  }
  allowedHosts = new Set([
    `127.0.0.1:${port}`,
    `[::1]:${port}`,
    `localhost:${port}`,
    `${FRIENDLY_HOST}:${port}`
  ])
  for (const server of servers) {
    // A stray socket error must never reach the worker's uncaught handler,
    // which would take the whole plugin down.
    server.on('clientError', (_error, socket) => socket.destroy())
    server.on('error', () => {})
    server.unref()
  }
  return {
    url: `http://${FRIENDLY_HOST}:${port}/`,
    close: () =>
      Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))).then(
        () => undefined
      )
  }
}
