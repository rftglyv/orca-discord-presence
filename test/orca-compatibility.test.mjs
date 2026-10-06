import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { assessCompatibility } from '../scripts/check-orca-compatibility.mjs'

const baseline = JSON.parse(
  await readFile(new URL('../orca-compatibility.json', import.meta.url), 'utf8')
)

function matchingSnapshot() {
  return {
    latestRelease: baseline.verifiedRelease,
    mainCommit: 'a'.repeat(40),
    releaseObjects: { ...baseline.contracts },
    mainObjects: { ...baseline.contracts }
  }
}

test('the Orca compatibility baseline is complete and pinned to Git object ids', () => {
  assert.equal(baseline.upstream, 'stablyai/orca')
  assert.match(baseline.verifiedRelease, /^v\d+\.\d+\.\d+$/)
  assert.match(baseline.verifiedAt, /^\d{4}-\d{2}-\d{2}$/)
  assert.ok(Object.keys(baseline.contracts).length >= 10)
  for (const [path, objectId] of Object.entries(baseline.contracts)) {
    assert.ok(path.startsWith('src/'), path)
    assert.match(objectId, /^[0-9a-f]{40}$/, path)
  }
})

test('an unchanged release and main pass the compatibility assessment', () => {
  assert.deepEqual(assessCompatibility(baseline, matchingSnapshot()), [])
})

test('a new stable release requires review even when the contracts match', () => {
  const snapshot = matchingSnapshot()
  snapshot.latestRelease = 'v99.0.0'
  assert.deepEqual(assessCompatibility(baseline, snapshot), [
    `latest stable release is v99.0.0; reviewed baseline is ${baseline.verifiedRelease}`
  ])
})

test('released and unreleased contract drift name the exact file', () => {
  const snapshot = matchingSnapshot()
  const [path] = Object.keys(baseline.contracts)
  snapshot.releaseObjects[path] = 'b'.repeat(40)
  snapshot.mainObjects[path] = 'c'.repeat(40)
  const findings = assessCompatibility(baseline, snapshot)
  assert.equal(findings.length, 2)
  assert.ok(findings.every((finding) => finding.includes(path)))
  assert.ok(findings.some((finding) => finding.includes(baseline.verifiedRelease)))
  assert.ok(findings.some((finding) => finding.includes('on main')))
})
