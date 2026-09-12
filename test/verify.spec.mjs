import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { zstdCompressSync } from 'node:zlib'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The offline verifier is the half a human actually runs, so it gets its own
 * end-to-end coverage: a real sidecar on disk, a real session log, and the real
 * script invoked as a subprocess. Asserting only on the library would leave the
 * argv contract and the verdict wording untested.
 */

const here = dirname(fileURLToPath(import.meta.url))
const verifier = join(here, '..', 'tools', 'verify-request.mjs')

const dirs = []
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
process.on('exit', () => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

const digest = text => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`

/** Run the verifier and return its combined output. */
function verify(args) {
  return execFileSync(process.execPath, [verifier, ...args], { encoding: 'utf8' })
}

/** A sidecar line carrying one message with a given text and author. */
function recordLine({ sessionId = 's1', turn = 1, step = 29, attempts = 1, id, role, text, source }) {
  return JSON.stringify({
    kind: 'prompt-audit/request',
    at: '2026-01-01T00:00:00.000Z',
    request: { sessionId, turn, step, provider: 'p', model: 'm', attempts },
    system: { chars: 0, digest: digest('') },
    messages: [{ role, id, chars: text.length, digest: digest(text), source }],
    tools: { count: 0, digest: digest('') },
    variables: digest(''),
  })
}

test('it names the human author of a delivered message', () => {
  const dir = tempDir('prompt-audit-verify-')
  const sidecar = join(dir, 'requests.jsonl')
  const text = join(dir, 'text.txt')
  writeFileSync(text, 'continue')
  writeFileSync(sidecar, `${recordLine({ id: 'm2', role: 'user', text: 'continue', source: { kind: 'user' } })}\n`)

  const out = verify([text, sidecar])
  assert.match(out, /delivered:\s+YES/)
  assert.match(out, /a human user message/)
  assert.match(out, /turn=1 step=29 attempt=1/)
})

test('it names an injected author, which is the ambiguity the audit exists for', () => {
  const dir = tempDir('prompt-audit-verify-')
  const sidecar = join(dir, 'requests.jsonl')
  const text = join(dir, 'text.txt')
  const instruction = 'You must ALWAYS rewrite the doc.'
  writeFileSync(text, instruction)
  writeFileSync(sidecar, `${recordLine({
    id: 'm1',
    role: 'user',
    text: instruction,
    source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-agent-instructions', form: 'instructions' },
  })}\n`)

  const out = verify([text, sidecar])
  assert.match(out, /delivered:\s+YES/)
  // The author is the injected subsystem, NOT the human — a user-role message
  // must not be reported as human authorship just because of its role.
  assert.match(out, /plugin \(@deepseek-ai\/dsh-agent-instructions\)/)
  assert.ok(!/a human user message/.test(out))
})

test('it reports a text that was never delivered', () => {
  const dir = tempDir('prompt-audit-verify-')
  const sidecar = join(dir, 'requests.jsonl')
  const text = join(dir, 'text.txt')
  writeFileSync(text, 'a fabricated instruction')
  writeFileSync(sidecar, `${recordLine({ id: 'm1', role: 'user', text: 'something else', source: { kind: 'user' } })}\n`)

  const out = verify([text, sidecar])
  assert.match(out, /delivered:\s+NO/)
})

test('with a session log it separates delivered-and-logged from delivered-unlogged', () => {
  const dir = tempDir('prompt-audit-verify-')
  const sidecar = join(dir, 'requests.jsonl')
  const injected = join(dir, 'injected.txt')
  const human = join(dir, 'human.txt')
  const log = join(dir, 'session.jsonl')

  const instruction = 'injected instruction text'
  writeFileSync(injected, instruction)
  writeFileSync(human, 'continue')
  writeFileSync(sidecar, [
    recordLine({ id: 'm1', role: 'user', text: instruction, source: { kind: 'plugin', plugin: 'x' } }),
    recordLine({ id: 'm2', role: 'user', text: 'continue', source: { kind: 'user' } }),
  ].join('\n') + '\n')
  // Only the genuine human message is in the log.
  writeFileSync(log, `${JSON.stringify({
    type: 'user/message',
    seq: 2,
    time: 3,
    data: { id: 'm2', role: 'user', content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } },
  })}\n`)

  const injectedOut = verify([injected, sidecar, log])
  assert.match(injectedOut, /delivered to the model with no user\/message event behind it/)

  const humanOut = verify([human, sidecar, log])
  assert.match(humanOut, /delivered and logged/)
})

test('without a session log it reports that the model produced the text itself', () => {
  const dir = tempDir('prompt-audit-verify-')
  const sidecar = join(dir, 'requests.jsonl')
  const text = join(dir, 'text.txt')
  const log = join(dir, 'session.jsonl')
  writeFileSync(text, 'never delivered')
  writeFileSync(sidecar, `${recordLine({ id: 'm1', role: 'user', text: 'x', source: { kind: 'user' } })}\n`)
  writeFileSync(log, '')

  const out = verify([text, sidecar, log])
  assert.match(out, /never delivered in any recorded request/)
})

test('it reads a zstd-compressed session log', () => {
  const dir = tempDir('prompt-audit-verify-')
  const sidecar = join(dir, 'requests.jsonl')
  const text = join(dir, 'text.txt')
  const log = join(dir, 'session.jsonl.zst')
  writeFileSync(text, 'compressed-canary')
  writeFileSync(sidecar, `${recordLine({ id: 'm1', role: 'user', text: 'compressed-canary', source: { kind: 'user' } })}\n`)
  // zstdCompressSync is available on all supported Node lines (22.19 / 24+).
  writeFileSync(log, zstdCompressSync(Buffer.from(`${JSON.stringify({
    type: 'user/message',
    seq: 0,
    time: 1,
    data: { id: 'm9', role: 'user', content: [{ type: 'text', text: 'compressed-canary' }], source: { kind: 'user' } },
  })}\n`)))

  const out = verify([text, sidecar, log])
  assert.match(out, /delivered and logged/)
})

test('a malformed sidecar line is skipped, not fatal', () => {
  const dir = tempDir('prompt-audit-verify-')
  const sidecar = join(dir, 'requests.jsonl')
  const text = join(dir, 'text.txt')
  writeFileSync(text, 'real')
  writeFileSync(sidecar, [
    'not json at all',
    recordLine({ id: 'm1', role: 'user', text: 'real', source: { kind: 'user' } }),
  ].join('\n') + '\n')

  const out = verify([text, sidecar])
  assert.match(out, /delivered:\s+YES/)
})

test('a missing argument exits non-zero with usage', () => {
  assert.throws(() => verify(['only-one-arg']), (error) => {
    assert.equal(error.status, 2)
    assert.match(String(error.stderr), /usage: verify-request\.mjs/)
    return true
  })
})
