/**
 * `prompt-audit`: persist a per-call, content-addressed digest of exactly what
 * was sent to the model, so "was this text ever delivered to the model?" can be
 * answered from local artifacts.
 *
 * The gap (Discussions #6376 / #6377 / #6378): a report could show that a turn
 * acted on an instruction with no `user/message` event behind it, but could not
 * separate the two explanations — a user-role message delivered without being
 * logged, or the model fabricating it. Separating them needs the assembled
 * request of the step in question, and the harness records events only: the
 * stored `request/header` carries provider/model/maxTokens and tool schemas, not
 * the prompt, and no logging switch or audit option exists under `$DSH_HOME`.
 *
 * Where the record comes from
 * ---------------------------
 *
 * `llm/stream` is the seam that carries the finished request. Its waterfall
 * receives the exact {@link GenerateOptions} the adapters are about to send, and
 * the loop owns that object: `agent-loop` freezes it and its `messages` array
 * (`agent.ts:604-616`), and its own invariant re-derives the history every call
 * and fails when `options.messages` diverges from
 * `session.deriveMessages()`. So the request observed here is the authoritative
 * wire payload *and* the durable history, not a reconstruction.
 *
 * That invariant is also what makes the stronger claim possible: the record is
 * taken at the same boundary the harness itself uses to assert the request and
 * the session log agree, so a difference between them is a detectable condition
 * rather than a silent one.
 *
 * What is recorded
 * ----------------
 *
 * Per call: the request identity (session, turn, step, provider, model), the
 * effective system prompt's identity and digest, every message as
 * `(role, message id, content digest, author)` in order, and digests of the
 * variable and tool inputs. Full content is not recorded — the report asked for
 * a digest precisely because that is enough to answer the question, and it keeps
 * the sidecar small enough to keep.
 *
 * The per-message `id` and `source` are the decisive fields. `source` separates
 * a human `user` message from `agent-instructions` / `plugin` / `skill-catalog`
 * text that also arrives in the user role, so "delivered without being logged"
 * and "never delivered" stop looking alike.
 *
 * Where it is written, and what it never touches
 * ----------------------------------------------
 *
 * The record goes to a sidecar file outside the session log. It has to: the
 * session's storage contract rejects unknown event types on append unless the
 * event is declared ignorable, and that declared-ignorable write path is not
 * reachable from a plugin (see the unknown-event-type registry). Writing an
 * audit record into the log is therefore not an option a plugin has, and the
 * audit must not require a core change to exist at all.
 *
 * Failure posture: this is an observability sidecar, so nothing here may change
 * a model call. The listener delegates first and never alters the stream it is
 * observing, digests are computed after the call is released, and every I/O and
 * serialization failure is logged and swallowed. If the audit cannot be written,
 * the call still happens.
 *
 * @module @argszero/cordis-plugin-prompt-audit
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
// Side-effect type imports: declaration-merge `ctx.llm`, `ctx.sessions`, `ctx.agents`.
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { digestJson, digestText, describeSource, messageSource, messageText } from './digest.ts'

export const name = 'prompt-audit'

/** Which services this plugin reads: the request seam, its sessions, and live agents. */
export const inject = ['llm', 'sessions', 'agents']

/** Configures the audit sidecar. */
export interface Config {
  /**
   * File receiving one JSON line per model call. Defaults to
   * `<DSH_HOME>/prompt-audit/requests.jsonl`. Relative paths resolve against
   * the current working directory.
   */
  path?: string
  /**
   * Harness home override used when `path` is omitted; defaults to `$DSH_HOME`,
   * then `~/.dsh`. Only consulted while no explicit `path` is set.
   */
  dshHome?: string
  /** Record calls with no session (hand-built one-shots). Default false. */
  includeSessionless?: boolean
}

/** The identity of one recorded call. */
interface RequestIdentity {
  readonly sessionId: string
  readonly turn: number | null
  readonly step: number | null
  readonly provider: string
  readonly model: string
  readonly attempts: number
}

/** One message as the audit records it. */
interface MessageRecord {
  readonly role: string
  readonly id: string
  readonly chars: number
  readonly digest: string
  readonly source: Record<string, unknown>
}

/** Tracks the step position a request belongs to, from the live event feed. */
interface StepTracker {
  turn: number | null
  step: number | null
}

/**
 * The last entered step per session.
 *
 * `agent-loop` commits `step/start` (`agent.ts:302`) before it assembles and
 * dispatches that step's request (`:307`), and `session/event` observers run
 * synchronously inside the append, so by dispatch time the tracker already holds
 * this call's position. Tracking the live feed rather than reading history keeps
 * the plugin off the deprecated synchronous history readers.
 */
const trackers = new WeakMap<object, StepTracker>()

/**
 * Record one observed call.
 * @param options - the frozen request handed to the waterfall.
 * @param identity - the resolved call identity.
 * @param systemText - the effective system prompt's full text.
 * @returns the JSON line to persist.
 */
function buildRecord(
  options: GenerateOptions,
  identity: RequestIdentity,
  systemText: string,
): Record<string, unknown> {
  const messages: MessageRecord[] = options.messages.map((message: Message) => ({
    role: message.role,
    id: String(message.id),
    chars: messageText(message).length,
    digest: digestText(messageText(message)),
    source: describeSource(messageSource(message)),
  }))

  // The system prompt travels as message 0 of a loop-built request and as
  // `options.system` for a one-shot; report whichever was actually sent.
  const system = options.system ?? (messages.length > 0 && messages[0]?.role === 'system' ? systemText : '')

  return {
    kind: 'prompt-audit/request',
    at: new Date().toISOString(),
    request: identity,
    system: { chars: system.length, digest: digestText(system) },
    messages,
    tools: { count: options.tools?.length ?? 0, digest: digestJson(options.tools ?? []) },
    variables: digestJson({
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      stop: options.stop,
      purpose: options.purpose,
      reasoningEffort: options.reasoningEffort,
    }),
  }
}

/**
 * Resolve the audit file path.
 * @param config - the plugin config.
 * @returns the absolute path of the sidecar.
 */
function resolvePath(config: Config): string {
  return config.path ?? join(resolveDshHome(config.dshHome), 'prompt-audit', 'requests.jsonl')
}

/**
 * Register the audit listener.
 * @param ctx - context carrying the llm service, sessions, and agents.
 * @param config - resolved sidecar options.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const target = resolvePath(config)
  const includeSessionless = config.includeSessionless === true
  /** Serializes writes so concurrent calls cannot interleave a line. */
  let queue: Promise<void> = Promise.resolve()
  /** Whether the audit file was already proven writable this run. */
  let ready: Promise<void> | undefined
  /** Per-session call counter, mirroring the provider's own attempt numbering. */
  const attempts = new Map<string, number>()

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'step/start') return
    trackers.set(session as unknown as object, { turn: event.data.turn, step: event.data.step })
  })

  /**
   * Append one line, creating the directory once.
   *
   * A failure must not disable the audit permanently: the memoized directory
   * creation is cleared on error so the next call retries it, rather than
   * inheriting the first call's rejected promise forever.
   * @param line - the serialized record.
   */
  const write = (line: string): void => {
    queue = queue.then(async () => {
      try {
        ready ??= mkdir(dirname(target), { recursive: true }).then(() => undefined)
        await ready
        await appendFile(target, `${line}\n`, 'utf8')
      } catch (error: unknown) {
        ready = undefined
        throw error
      }
    }).catch((error: unknown) => {
      // A failed audit must not affect anything else, and must not wedge the
      // queue for later calls.
      ctx.logger.warn(`prompt-audit: record not written: ${String(error)}`)
    })
  }

  ctx.on('llm/stream', (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> => {
    // Delegate first: this listener observes the request, it never alters the
    // stream. Any listener after this one still owns the outcome.
    const stream = next()

    const sessionId = options.sessionId
    if (sessionId === undefined && !includeSessionless) return stream

    // Everything below is pure observation and must never reach the caller.
    try {
      const session = sessionId === undefined ? undefined : ctx.sessions.get(sessionId)
      const tracker = session === undefined ? undefined : trackers.get(session as unknown as object)
      const systemText = options.messages.length > 0 && options.messages[0]?.role === 'system'
        ? messageText(options.messages[0])
        : ''
      const count = sessionId === undefined ? 0 : (attempts.get(String(sessionId)) ?? 0) + 1
      if (sessionId !== undefined) attempts.set(String(sessionId), count)

      const identity: RequestIdentity = {
        sessionId: String(sessionId ?? ''),
        turn: tracker?.turn ?? null,
        step: tracker?.step ?? null,
        provider: options.provider,
        model: options.model,
        attempts: count,
      }

      // The captured request is frozen by the loop, but its identity is read
      // now (synchronously, before returning) so the record cannot drift when a
      // caller reuses a mutable options object for a hand-built one-shot.
      write(JSON.stringify(buildRecord(options, identity, systemText)))
    } catch (error: unknown) {
      ctx.logger.warn(`prompt-audit: request not recorded: ${String(error)}`)
    }

    return stream
  })

  // Flush any pending write on disposal so a shutdown does not silently drop
  // the last records.
  ctx.effect(() => () => queue)
}
