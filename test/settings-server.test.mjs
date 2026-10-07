import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { createSettingsToken, startSettingsServer } from '../dist/lib/settings-server.mjs'

const artDir = fileURLToPath(new URL('../assets/discord', import.meta.url))

/** Raw request so the Host header can be forged, which fetch() does not allow. */
function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const req = http.request(
      { hostname: target.hostname, port: target.port, path: target.pathname + target.search, method, headers },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
      }
    )
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

async function withServer(run) {
  const token = createSettingsToken()
  let settings = { privacy: 'minimal' }
  const server = await startSettingsServer({
    token,
    artDir,
    preferredPort: 0,
    handlers: {
      snapshot: () => ({ settings }),
      update: async (patch) => {
        settings = { ...settings, ...patch }
        return { settings }
      }
    }
  })
  try {
    await run({ server, token, base: 'http://127.0.0.1:' + new URL(server.url).port })
  } finally {
    await server.close()
  }
}

test('the friendly address serves the page with its token inlined', async () => {
  await withServer(async ({ server, base, token }) => {
    assert.match(server.url, /^http:\/\/orcadcrpc\.localhost:\d+\/$/)
    const port = new URL(server.url).port
    const page = await request(base + '/', { headers: { Host: 'orcadcrpc.localhost:' + port } })
    assert.equal(page.status, 200)
    assert.match(page.body, /Discord Presence settings/)
    assert.ok(page.body.includes("var token = '" + token + "'"))
    assert.match(page.headers['content-security-policy'], /default-src 'none'/)
    assert.equal(page.headers['x-frame-options'], 'DENY')
  })
})

test('a forged Host header is refused, which stops DNS rebinding', async () => {
  await withServer(async ({ base }) => {
    const forged = await request(base + '/', { headers: { Host: 'evil.example:80' } })
    assert.equal(forged.status, 421)
  })
})

test('API requests another site makes are refused', async () => {
  await withServer(async ({ base, token }) => {
    // Following a link to the page is cross-site navigation, and allowed.
    const page = await request(base + '/', { headers: { 'Sec-Fetch-Site': 'cross-site' } })
    assert.equal(page.status, 200)
    const api = await request(base + '/api/state', {
      headers: { 'Sec-Fetch-Site': 'cross-site', 'X-Settings-Token': token }
    })
    assert.equal(api.status, 403)
  })
})

test('the API needs the token header; a query-string token is not enough', async () => {
  await withServer(async ({ base, token }) => {
    assert.equal((await request(base + '/api/state?t=' + token)).status, 403)
    const ok = await request(base + '/api/state', { headers: { 'X-Settings-Token': token } })
    assert.equal(ok.status, 200)
    assert.deepEqual(JSON.parse(ok.body), { settings: { privacy: 'minimal' } })
  })
})

test('settings updates round-trip, and bad bodies are rejected', async () => {
  await withServer(async ({ base, token }) => {
    const headers = { 'X-Settings-Token': token, 'Content-Type': 'application/json' }
    const saved = await request(base + '/api/settings', {
      method: 'POST',
      headers,
      body: JSON.stringify({ privacy: 'full' })
    })
    assert.equal(saved.status, 200)
    assert.equal(JSON.parse(saved.body).settings.privacy, 'full')

    const bad = await request(base + '/api/settings', { method: 'POST', headers, body: '{nope' })
    assert.equal(bad.status, 400)

    // A cross-site form post carries no custom header, so it never gets in.
    const forged = await request(base + '/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ enabled: false })
    })
    assert.equal(forged.status, 403)
  })
})

test('card artwork is served for the preview, and nothing else from disk', async () => {
  await withServer(async ({ base }) => {
    const art = await request(base + '/art/working.png')
    assert.equal(art.status, 200)
    assert.equal(art.headers['content-type'], 'image/png')
    assert.equal((await request(base + '/art/..%2F..%2Fpackage.json')).status, 404)
    assert.equal((await request(base + '/art/secret.png')).status, 404)
  })
})
