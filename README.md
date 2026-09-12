# @argszero/cordis-plugin-prompt-audit

Record a content-addressed digest of **every assembled model request** — per
message (role, id, content hash, **author**) plus the effective system prompt's
identity and hash — to a sidecar file outside the session log.

It answers one question from local artifacts:

> Was this text ever delivered to the model as a user message, and if so, who
> delivered it?

Closes Discussions [#6376](https://github.com/deepseek-ai/deepseek-harness/discussions/6376) /
[#6377](https://github.com/deepseek-ai/deepseek-harness/discussions/6377) /
[#6378](https://github.com/deepseek-ai/deepseek-harness/discussions/6378).

## The gap

A reported turn acted on an instruction that no user sent, and nine file edits
followed. The report could show that the turn had exactly one `user/message`
event — a two-word "continue" — and that no recorded event carried the
instruction. What it could not do was separate the two explanations:

1. the harness delivered a user-role message that was **not recorded**, or
2. the **model fabricated** the instruction from its own prior output.

Separating them needs the request actually sent at that step. The harness records
events only: the stored `request/header` carries provider/model/maxTokens and
tool schemas, not the prompt, and `$DSH_HOME` has no log directory or audit
switch. `session.v3.jsonl.zstd` cannot answer the question, and the model's own
assistant text is replayed into later requests, so a fabricated instruction looks
exactly like an instruction.

## What this plugin does

```sh
dsh plugin add @argszero/cordis-plugin-prompt-audit
```

It mounts on `llm/stream`, the seam that carries the finished request, and writes
one JSON line per model call to `<DSH_HOME>/prompt-audit/requests.jsonl`:

```json
{"kind":"prompt-audit/request","at":"...","request":{"sessionId":"session-1","turn":1,"step":29,"provider":"go","model":"deepseek-v4.1-flash","attempts":1},
 "system":{"chars":4102,"digest":"sha256:..."},
 "messages":[
   {"role":"system","id":"m0","chars":4102,"digest":"sha256:...","source":{"kind":"plugin","plugin":"@deepseek-ai/dsh-system-prompt",...}},
   {"role":"user","id":"m1","chars":32,"digest":"sha256:...","source":{"kind":"plugin","plugin":"@deepseek-ai/dsh-agent-instructions","form":"instructions",...}},
   {"role":"user","id":"m2","chars":8,"digest":"sha256:...","source":{"kind":"user",...}}],
 "tools":{"count":36,"digest":"sha256:..."},"variables":"sha256:..."}
```

**Full content is not recorded.** The report asked for a digest precisely because
it is sufficient, and a digest keeps the sidecar small enough to retain.

### Why the `source` field is the point

`source` answers *who produced this message*, and it is what separates the two
explanations. In the record above, `m1` and `m2` are both `role: "user"` — but
one was injected by an instruction file and the other is a human. **User-channel
text is not by itself evidence of human authorship**, and the log alone cannot
tell you which is which.

## Answering the question

The package ships an offline verifier:

```sh
node node_modules/@argszero/cordis-plugin-prompt-audit/tools/verify-request.mjs \
  <text-file> <sidecar> [session.jsonl[.zstd]]
```

```
$ node tools/verify-request.mjs injected.txt requests.jsonl session.jsonl
delivered:             YES — 1 matching message(s)
  delivered by         plugin (@deepseek-ai/dsh-agent-instructions) — role=user id=m1
    in                 call session-1 turn=1 step=29 attempt=1

in session log:        NO user/message event

VERDICT: delivered to the model with no user/message event behind it.
         The text reached the request over the user channel without being logged.
```

Passing the session log turns the answer three-way:

| delivered | in session log | verdict |
|---|---|---|
| yes | yes | an ordinary recorded message |
| yes | **no** | **delivered over the user channel without being logged** |
| no | — | the model produced it itself |

The middle row is the one the session log cannot produce on its own.

## How it is recorded

The record is taken at the same boundary the harness itself uses to assert its
request agrees with its session log. `agent-loop` freezes the request and its
`messages` array (`agent.ts:604-616`), and its own invariant re-derives the
history on every call and fails when `options.messages` diverges from
`session.deriveMessages()`. So what this plugin hashes is the authoritative wire
payload *and* the durable history — not a reconstruction.

Each message's content address is computed over the text the provider receives,
so a digest match is exact.

## Why a sidecar and not the session log

The session storage contract rejects unknown event types on append unless the
event is declared ignorable, and that declared-ignorable write path is not
reachable from a plugin. An audit record therefore cannot live in the log
without a core change — and the point is that the audit exists today, with no
core change and no flag required.

## Configuration

| option | default | meaning |
|---|---|---|
| `path` | `<DSH_HOME>/prompt-audit/requests.jsonl` | sidecar file; one JSON line per call |
| `dshHome` | `$DSH_HOME`, then `~/.dsh` | home override used when `path` is omitted |
| `includeSessionless` | `false` | also record hand-built one-shot calls with no session |

```yaml
- set:
    - id: prompt-audit
      config:
        path: /var/log/dsh/prompts.jsonl
```

## Failure posture

The audit is observability, so nothing here may change a model call:

- the listener delegates to the rest of the chain first and **never alters the
  stream it observes**;
- digests are computed and the write queued **after** the call is released, on a
  serialized queue that cannot interleave lines;
- every filesystem and serialization failure is **logged and swallowed** — if the
  audit cannot be written, the call still happens;
- a failed directory creation is **not memoized**, so a transient failure does
  not disable recording for the rest of the run.

## Limits

- A digest answers *was this exact text delivered* — it is not full-text search,
  and it cannot match a paraphrase. That is the deliberate trade for a record
  small enough to keep.
- `source` is reported verbatim and merge-extensible: an unknown `kind` is
  recorded as-is (with its full shape addressable by digest) rather than
  interpreted.
- The record covers **delivery**, not authorization. It shows what the model was
  sent; whether the text *should* have been sent is a policy question it does
  not answer.

## Compatibility

Requires dsh `0.1.2-alpha.2` or later within the `0.1.x` line. The `llm/stream`
seam, per-message `source`, and `ctx.sessions` are present in every admitted
version; the peer range is derived against all published versions rather than by
intuition. Node `^22.19 || >=24` (zstd decompression of session logs uses the
built-in `node:zlib`).

## License

MIT
