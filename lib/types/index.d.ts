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
import type { Context } from '@deepseek-ai/cordis';
export declare const name = "prompt-audit";
/** Which services this plugin reads: the request seam, its sessions, and live agents. */
export declare const inject: string[];
/** Configures the audit sidecar. */
export interface Config {
    /**
     * File receiving one JSON line per model call. Defaults to
     * `<DSH_HOME>/prompt-audit/requests.jsonl`. Relative paths resolve against
     * the current working directory.
     */
    path?: string;
    /**
     * Harness home override used when `path` is omitted; defaults to `$DSH_HOME`,
     * then `~/.dsh`. Only consulted while no explicit `path` is set.
     */
    dshHome?: string;
    /** Record calls with no session (hand-built one-shots). Default false. */
    includeSessionless?: boolean;
}
/**
 * Register the audit listener.
 * @param ctx - context carrying the llm service, sessions, and agents.
 * @param config - resolved sidecar options.
 */
export declare function apply(ctx: Context, config?: Config): void;
