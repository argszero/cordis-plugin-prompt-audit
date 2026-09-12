#!/usr/bin/env node
/**
 * Answer one question against a `prompt-audit` sidecar: was this text ever
 * delivered to the model, and if so, by whom?
 *
 * This is the offline half of the plugin. The record decides what is possible;
 * this tool is what turns it into a yes/no with a provenance answer. It reads
 * the sidecar the plugin wrote, scans the *session log* `user/message` events for
 * the same text, and reports the three-way result the report could not get
 * locally:
 *
 *   delivered AND logged   → an ordinary recorded message; the log has it.
 *   delivered, not logged  → delivered over the user channel without a
 *                            `user/message` event behind it (the audit's unique
 *                            contribution: the log alone cannot show this).
 *   not delivered          → the text never reached the model in a request, so
 *                            the model produced it on its own.
 *
 * Usage:
 *   node tools/verify-request.mjs <text-file> <sidecar.jsonl> [session.jsonl[.zstd]]
 *
 * The session argument is optional; without it the tool still reports delivery
 * and authorship, which is already enough to separate "delivered unlogged" from
 * "never delivered". With it, the tool also states whether the log agrees.
 *
 * @module @argszero/cordis-plugin-prompt-audit/tools/verify-request
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

/**
 * Content-address one UTF-8 string; must match `src/digest.ts`.
 * @param text - the exact text to address.
 * @returns its `sha256:<hex>` digest.
 */
function digestText(text) {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`
}

/**
 * Read a possibly-zstd-compressed JSONL log.
 * @param path - file path.
 * @returns decoded lines, skipping blanks.
 */
function readLog(path) {
  const raw = readFileSync(path)
  // zstd frames start with the magic number 0x28 B5 2F FD.
  const isZstd = raw.length > 4 && raw[0] === 0x28 && raw[1] === 0xb5 && raw[2] === 0x2f && raw[3] === 0xfd
  const text = isZstd ? zstdDecompressSync(raw).toString('utf8') : raw.toString('utf8')
  return text.split('\n').filter(line => line.trim().length > 0)
}

/**
 * The text a message's content blocks contribute.
 * @param message - a recorded or logged message.
 * @returns the concatenated text blocks.
 */
function messageText(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => (block && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('')
}

/**
 * Report one finding line.
 * @param label - the finding's kind.
 * @param detail - the human-readable detail.
 */
function report(label, detail) {
  console.log(`${label.padEnd(22)} ${detail}`)
}

const [textPath, sidecarPath, sessionPath] = process.argv.slice(2)
if (textPath === undefined || sidecarPath === undefined) {
  console.error('usage: verify-request.mjs <text-file> <sidecar.jsonl> [session.jsonl[.zstd]]')
  process.exit(2)
}

const target = digestText(readFileSync(textPath, 'utf8').replace(/\r\n/g, '\n'))

console.log(`text file   : ${textPath}`)
console.log(`content addr: ${target}`)
console.log('')

const matches = []
for (const [index, line] of readLog(sidecarPath).entries()) {
  let record
  try {
    record = JSON.parse(line)
  } catch {
    continue
  }
  for (const message of record.messages ?? []) {
    if (message.digest !== target) continue
    matches.push({ index, record, message })
  }
  // The system prompt is a text the model also receives; a match there is a
  // different finding from a user-channel delivery.
  if (record.system?.digest === target) matches.push({ index, record, message: null, system: true })
}

report('delivered:', matches.length > 0 ? `YES — ${matches.length} matching message(s)` : 'NO')
for (const match of matches) {
  const { request } = match.record
  const where = `call ${request.sessionId} turn=${request.turn} step=${request.step} attempt=${request.attempts}`
  if (match.system === true) {
    report('  as system prompt', where)
    continue
  }
  const source = match.message.source ?? {}
  const author = source.kind === 'user'
    ? 'a human user message'
    : `${String(source.kind)}${source.plugin === undefined ? '' : ` (${String(source.plugin)})`}`
  report('  delivered by', `${author} — role=${match.message.role} id=${match.message.id}`)
  report('    in', where)
}

if (sessionPath !== undefined) {
  const logged = []
  for (const line of readLog(sessionPath)) {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event.type !== 'user/message') continue
    const text = messageText(event.data)
    if (digestText(text) === target) logged.push(event)
  }
  console.log('')
  report('in session log:', logged.length > 0 ? `YES — ${logged.length} user/message event(s)` : 'NO user/message event')
  for (const event of logged) {
    report('  event', `seq=${event.seq} source=${JSON.stringify(event.data?.source?.kind ?? 'absent')}`)
  }
  if (matches.length > 0 && logged.length === 0) {
    console.log('')
    console.log('VERDICT: delivered to the model with no user/message event behind it.')
    console.log('         The text reached the request over the user channel without being logged.')
  } else if (matches.length > 0) {
    console.log('')
    console.log('VERDICT: delivered and logged; the log records this delivery.')
  } else {
    console.log('')
    console.log('VERDICT: never delivered in any recorded request — the model produced it itself.')
  }
}
