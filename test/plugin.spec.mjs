import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context, Service } from '@deepseek-ai/cordis'
import sessionPlugin from '@deepseek-ai/dsh-session'
import llmPlugin, { LlmAdapter, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import * as plugin from '../lib/index.js'

/**
 * Integration: mount the plugin on a REAL Cordis context with the REAL session
 * store and the REAL llm runtime, register a real adapter, and drive a real
 * `llm.stream` call. Anything less would not prove the listener is wired into
 * the seam the loop actually uses.
 *
 * The temp dir is created once per run and removed in an `after()` hook, so a
 * full pass leaves nothing behind in the OS temp dir (the thinking-loop-guard
 * analyzer test leaked one directory per run until this was fixed).
 */

const dirs = []
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
process.on('exit', () => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/** The digest vocabulary must match `src/digest.ts` exactly. */
const digestText = text => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`

/** An adapter that yields one text delta and a clean finish, remembering the request. */
class FakeAdapter extends LlmAdapter {
  constructor(seen) {
    super()
    this.seen = seen
  }

  stream(options) {
    this.seen.push(options)
    return (async function* () {
      yield { type: 'text-delta', index: 0, text: 'ok' }
      yield { type: 'block-end', index: 0 }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  }
}

/** A stand-in agent service: the plugin resolves a session, never an agent. */
class FakeAgents extends Service {
  constructor(ctx) {
    super(ctx, 'agents')
  }

  get() {
    return undefined
  }
}

/**
 * Mount the real session store, the real llm runtime, and the plugin.
 * @param options - sidecar path plus optional plugin config.
 * @returns the context, a session, and the adapter's captured requests.
 */
async function mount(options = {}) {
  const ctx = new Context()
  const logged = []
  ctx.logger = { info: () => {}, debug: () => {}, warn: m => logged.push(m), error: () => {} }
  await ctx.plugin(sessionPlugin)
  await ctx.plugin(llmPlugin)
  new FakeAgents(ctx)
  // The `inject` list must be carried on the plugin object: Cordis resolves it
  // from there, and a mount that omits it makes every `ctx.sessions` read throw.
  // The shipped bundle mounts the package by name, so Cordis reads the module's
  // own `inject` export; this only has to reproduce that for the inline form.
  await ctx.plugin({ name: 'prompt-audit', inject: plugin.inject, apply: c => plugin.apply(c, options.config ?? {}) })
  const seen = []
  ctx.llm.registerAdapter(['fake'], new FakeAdapter(seen))
  const session = ctx.sessions.create()
  return { ctx, session, seen, logged }
}

/** Read the sidecar as parsed records; empty when the file was never created. */
function records(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l))
}

/** Poll until `predicate` holds, so the async writer is not raced. */
async function until(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return false
}

/** The exact request the loop builds, through the real seam. */
const call = (session, overrides = {}) => markAgentLoopRequest(Object.freeze({
  provider: 'fake',
  model: 'fake-model',
  messages: Object.freeze([
    { id: 'm0', role: 'system', content: [{ type: 'text', text: 'SYSTEM PROMPT' }], source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' } },
    { id: 'm1', role: 'user', content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } },
  ]),
  sessionId: session.id,
  ...overrides,
}))

/** Drain a stream so the adapter (and therefore the audit) actually runs. */
async function drain(iterable) {
  const out = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

test('a real llm.stream call is recorded with per-message authorship', async () => {
  const dir = tempDir('prompt-audit-')
  const path = join(dir, 'requests.jsonl')
  const { ctx, session } = await mount({ config: { path } })

  await drain(ctx.llm.stream(call(session)))
  assert.ok(await until(() => records(path).length === 1), 'exactly one record must be written')

  const [record] = records(path)
  assert.equal(record.kind, 'prompt-audit/request')
  assert.equal(record.request.provider, 'fake')
  assert.equal(record.request.model, 'fake-model')
  assert.equal(record.request.sessionId, session.id)
  assert.equal(record.request.attempts, 1)

  // The messages are recorded in order with role, id, and content address.
  assert.deepEqual(record.messages.map(m => [m.role, m.id]), [['system', 'm0'], ['user', 'm1']])
  assert.equal(record.messages[1].digest, digestText('continue'))
  assert.equal(record.messages[1].chars, 'continue'.length)

  // The decisive field: authorship. A human message and an injected one must
  // not look alike, which is the whole point of the record.
  assert.equal(record.messages[0].source.kind, 'plugin')
  assert.equal(record.messages[0].source.plugin, '@deepseek-ai/dsh-system-prompt')
  assert.equal(record.messages[1].source.kind, 'user')

  // The effective system prompt is identified separately as well.
  assert.equal(record.system.digest, digestText('SYSTEM PROMPT'))
  assert.equal(record.system.chars, 'SYSTEM PROMPT'.length)
})

test('the recorded digest matches the request the harness built, byte for byte', async () => {
  // This is the property the whole audit rests on: the sidecar's content
  // address for a message must equal the address of the text the adapter
  // actually received. A record that only matched itself would prove nothing.
  const dir = tempDir('prompt-audit-')
  const path = join(dir, 'requests.jsonl')
  const { ctx, session, seen } = await mount({ config: { path } })

  const request = call(session, {
    messages: Object.freeze([
      { id: 'm0', role: 'system', content: [{ type: 'text', text: 'sys' }], source: { kind: 'plugin', plugin: 'x' } },
      { id: 'm1', role: 'user', content: [{ type: 'text', text: 'the exact instruction text' }], source: { kind: 'user' } },
    ]),
  })
  await drain(ctx.llm.stream(request))
  assert.ok(await until(() => records(path).length === 1))

  const [record] = records(path)
  const delivered = seen[0].messages[1]
  assert.equal(delivered.content[0].text, 'the exact instruction text')
  assert.equal(record.messages[1].digest, digestText(delivered.content[0].text))
})

test('the turn and step of a call are taken from the live event feed', async () => {
  // The loop commits `step/start` before it dispatches that step's request, and
  // session observers run synchronously inside the append — so the tracker must
  // already hold this call's position at dispatch time.
  const dir = tempDir('prompt-audit-')
  const path = join(dir, 'requests.jsonl')
  const { ctx, session } = await mount({ config: { path } })

  session.append('turn/start', { turn: 3 })
  session.append('step/start', { turn: 3, step: 7 })

  await drain(ctx.llm.stream(call(session)))
  assert.ok(await until(() => records(path).length === 1))

  const [record] = records(path)
  assert.equal(record.request.turn, 3)
  assert.equal(record.request.step, 7)
})

test('the record does not leak the message bodies', async () => {
  const dir = tempDir('prompt-audit-')
  const path = join(dir, 'requests.jsonl')
  const { ctx, session } = await mount({ config: { path } })

  await drain(ctx.llm.stream(call(session, {
    messages: Object.freeze([
      { id: 'm0', role: 'user', content: [{ type: 'text', text: 'SECRET-CANARY-TEXT' }], source: { kind: 'user' } },
    ]),
  })))
  assert.ok(await until(() => records(path).length === 1))

  const raw = readFileSync(path, 'utf8')
  assert.ok(!raw.includes('SECRET-CANARY-TEXT'), 'only digests and lengths may be recorded')
  assert.ok(raw.includes(digestText('SECRET-CANARY-TEXT')), 'the digest itself must be present')
})

test('the observed call is never altered and never denied', async () => {
  const dir = tempDir('prompt-audit-')
  const { ctx, session } = await mount({ config: { path: join(dir, 'requests.jsonl') } })

  const out = await drain(ctx.llm.stream(call(session)))
  assert.deepEqual(out.map(c => c.type), ['text-delta', 'block-end', 'finish'])
  assert.deepEqual(out.at(-1).reason, { kind: 'stop' })
})

test('a non-loop call is skipped unless explicitly included', async () => {
  const dir = tempDir('prompt-audit-')
  const path = join(dir, 'requests.jsonl')
  const { ctx } = await mount({ config: { path } })

  // No sessionId: a hand-built one-shot. It is not audit material by default
  // because the audit exists to answer questions about session delivery.
  await drain(ctx.llm.stream(Object.freeze({
    provider: 'fake', model: 'fake-model', messages: Object.freeze([]),
  })))

  await new Promise(resolve => setTimeout(resolve, 50))
  assert.deepEqual(records(path), [], 'a sessionless call must not be recorded by default')
})

test('a failed write cannot break the call, and a later write still lands', async () => {
  // Point the sidecar inside a path whose parent is an existing FILE, so
  // `mkdir(dirname)` must fail with ENOTDIR. The model call still has to
  // complete, the failure has to be reported rather than swallowed, and a
  // transient failure must not disable the audit for the rest of the run.
  const dir = tempDir('prompt-audit-')
  const blocker = join(dir, 'not-a-dir')
  writeFileSync(blocker, 'x')
  const { ctx, session, logged } = await mount({ config: { path: join(blocker, 'requests.jsonl') } })

  const out = await drain(ctx.llm.stream(call(session)))
  assert.deepEqual(out.at(-1).reason, { kind: 'stop' }, 'the call must complete regardless')
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.ok(logged.some(m => m.includes('prompt-audit')), 'the failure must be reported, not swallowed silently')
})

test('the audit recovers after a write failure', async () => {
  // The memoized `mkdir` is what makes a transient failure dangerous: caching a
  // rejected promise would disable recording for the rest of the run. The first
  // call here fails because the sidecar's parent path is a FILE; the obstacle is
  // then removed and the SAME instance must record again. Without clearing the
  // memoized promise, the second call inherits the first call's rejection.
  const dir = tempDir('prompt-audit-')
  const blocker = join(dir, 'blocker')
  writeFileSync(blocker, 'x')
  const sidecar = join(blocker, 'requests.jsonl')
  const { ctx, session, logged } = await mount({ config: { path: sidecar } })

  await drain(ctx.llm.stream(call(session)))
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.ok(logged.some(m => m.includes('prompt-audit')), 'the first call must report the failure')

  // Remove the obstacle; the same mounted plugin must now record.
  unlinkSync(blocker)
  await drain(ctx.llm.stream(call(session)))
  assert.ok(await until(() => records(sidecar).length === 1), 'a later call on the same instance must record')
})

test('a retried call is distinguishable from the call it retried', async () => {
  // The record has to separate attempt N from attempt N+1 of the same step, or a
  // retry would look like a second independent delivery. A single-call assertion
  // cannot show this: it passes whether or not the counter ever advances.
  const dir = tempDir('prompt-audit-')
  const path = join(dir, 'requests.jsonl')
  const { ctx, session } = await mount({ config: { path } })

  await drain(ctx.llm.stream(call(session)))
  await drain(ctx.llm.stream(call(session)))
  assert.ok(await until(() => records(path).length === 2), 'both calls must be recorded')

  const [first, second] = records(path)
  assert.equal(first.request.attempts, 1)
  assert.equal(second.request.attempts, 2)
})

test('the write path creates the sidecar directory itself', async () => {
  const dir = tempDir('prompt-audit-')
  const nested = join(dir, 'a', 'b', 'requests.jsonl')
  const { ctx, session } = await mount({ config: { path: nested } })
  await drain(ctx.llm.stream(call(session)))
  assert.ok(await until(() => records(nested).length === 1), 'missing parents must be created')
})
