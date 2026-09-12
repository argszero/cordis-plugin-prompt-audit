/**
 * The digest vocabulary of `prompt-audit`: content addressing plus the
 * message/section projections a record is built from.
 *
 * Hashes use Node's built-in `node:crypto`, which is a runtime builtin rather
 * than a dependency — the plugin stays dependency-free so its peer range is the
 * only thing a deployment has to satisfy.
 *
 * @module @argszero/cordis-plugin-prompt-audit/digest
 */

import { createHash } from 'node:crypto'
import type { Message, MessageSource } from '@deepseek-ai/dsh-llm'

/** A `sha256:<hex>` content address. */
export type Digest = `sha256:${string}`

/**
 * Content-address one UTF-8 string.
 * @param text - the exact text to address.
 * @returns its `sha256:<hex>` digest.
 */
export function digestText(text: string): Digest {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`
}

/**
 * Content-address one already-canonicalized JSON value.
 *
 * The value must be JSON-serializable by construction (every input here came
 * out of the session log or off a frozen request), but `JSON.stringify` returns
 * `undefined` for values it cannot represent, so an unrepresentable input
 * degrades to a digest of the empty string rather than throwing mid-audit.
 * @param value - the value to address.
 * @returns its `sha256:<hex>` digest.
 */
export function digestJson(value: unknown): Digest {
  return digestText(JSON.stringify(value) ?? '')
}

/** The exact text a message contributes to the request, hashable. */
export function messageText(message: Message): string {
  const blocks = message.content as readonly unknown[]
  return blocks.map((block) => {
    if (typeof block !== 'object' || block === null) return ''
    const record = block as { type?: unknown; text?: unknown }
    return record.type === 'text' && typeof record.text === 'string' ? record.text : ''
  }).join('')
}

/**
 * The `source` of a message, or absence when a producer left it out.
 *
 * `Message.source` is required by the type, but the value arrives from a
 * provider/plugin boundary, so the record treats a literal `undefined` as a
 * fact about the message rather than reading through it.
 * @param message - the message whose authorship is being recorded.
 * @returns the producer's declared source, or undefined.
 */
export function messageSource(message: Message): MessageSource | undefined {
  return message.source as MessageSource | undefined
}

/** The fields of `Message.source` this record surfaces verbatim. */
interface SourceFields {
  kind?: unknown
  plugin?: unknown
  model?: unknown
  provider?: unknown
  callId?: unknown
}

/**
 * Describe the author of one message.
 *
 * This is the field that answers the question the audit exists for: whether a
 * given user-role text was delivered by a human (`source.kind === 'user'`) or
 * injected by a subsystem (any other `kind`). `source` is merge-extensible —
 * plugins add their own kinds — so the kind is reported verbatim and the whole
 * source objects stays addressable by digest rather than being interpreted.
 * @param source - the message's declared source, if any.
 * @returns a compact, JSON-serializable description of the author.
 */
export function describeSource(source: MessageSource | undefined): Record<string, unknown> {
  if (source === undefined) return { kind: 'absent' }
  const fields = source as SourceFields
  const described: Record<string, unknown> = {
    kind: typeof fields.kind === 'string' ? fields.kind : 'unknown',
  }
  if (typeof fields.plugin === 'string') described.plugin = fields.plugin
  if (typeof fields.provider === 'string') described.provider = fields.provider
  if (typeof fields.model === 'string') described.model = fields.model
  if (typeof fields.callId === 'string') described.callId = fields.callId
  // Unknown/known-but-unread kinds keep their full shape addressable without
  // this plugin having to understand it.
  described.fields = digestJson(source)
  return described
}
