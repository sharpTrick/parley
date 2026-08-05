import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { AuthSchema } from './config-auth.js';
import {
  assertNoBackendKey,
  describeDocument,
  issueLines,
  messageOf,
} from './config-diagnostics.js';
import {
  DEFAULT_PRESENCE_TOPIC,
  MAX_HANDLE_LEN,
  MAX_RECORD_TOPICS,
  MAX_TOPIC_LEN,
} from './engine/presence.js';
import { isMentionableHandle } from './mentions.js';
import { isRedosSafeSource } from './regex-safety.js';

export * from './config-auth.js';

/**
 * Most `post_topics` patterns one config may carry. {@link isRedosSafeSource} bounds what ONE source
 * can spend, but `Allowlist.has` matches a caller-supplied topic against all of them in turn, so the
 * calibrated per-source cost multiplies by this count on every post/reply/fetch. Mirrors the
 * `MAX_RECORD_TOPICS` cap the presence path already puts on the same shape of untrusted list.
 *
 * `Allowlist` enforces it too, for the embedder that builds one without going through this schema;
 * the `.max()` below is the earlier, better-located operator error.
 */
export const MAX_POST_TOPICS = 64;

/**
 * Longest server-side clamp `catchup.block_max_ms` may name. A blocked `parley_fetch_recent` holds
 * the tool call open for its whole clamp, so a clamp past every configurable MCP client tool timeout
 * turns the long-poll into the client-side timeout the field exists to stay under.
 */
export const MAX_BLOCK_MS = 300_000;

/**
 * A string a presence beat carries verbatim. Capped where it is DECLARED, because every reader drops
 * a longer one out of the decoded record: a longer value loads cleanly and then leaves this bridge
 * silently unadvertised on it forever, with no error anywhere.
 */
const beatString = z.string().min(1).max(MAX_TOPIC_LEN, {
  message: `at most ${MAX_TOPIC_LEN} characters: a presence beat carries this string verbatim and every reader drops a longer one, so it would be silently unreachable for hand-off`,
});

/**
 * The single config object that drives a bridge (DESIGN §11). Sane defaults everywhere.
 * `backend_config` is opaque to core and passed verbatim to the plugin's `connect()`.
 *
 * Post-parse cross-field checks (regex compilation, presence-topic collision) live in the
 * `.superRefine` on {@link ConfigSchema} below — they need the whole object.
 */
const ConfigObject = z.object({
  // No `backend` field: naming a plugin here would put backend names in core, so that the seam's
  // one-way dependency (CLAUDE.md) stays intact. See assertNoBackendKey.
  /** Read-state namespace; defaults to identity.handle. Distinct sessions sharing a handle
   *  MUST set distinct instance_ids (DESIGN §10). */
  instance_id: z.string().min(1).optional(),
  /** Override the read-state file path (default: XDG_STATE_HOME/parley/<instance>/read-state.json). */
  state_path: z.string().min(1).optional(),
  identity: z
    .object({
      handle: z.string().min(1).max(MAX_HANDLE_LEN, {
        message: `identity.handle accepts at most ${MAX_HANDLE_LEN} characters: every presence beat carries it and a reader drops the WHOLE beat past that length, so this bridge would never appear in any peer's parley_list_users`,
      }),
    })
    .strict(),
  /**
   * Topics to subscribe to / catch up on. THIS IS THE ALLOWLIST (DESIGN §14). Capped at
   * `MAX_RECORD_TOPICS`: every presence beat advertises this whole list and every reader caps
   * a record at that count, so a longer list would load cleanly and then under-advertise this bridge
   * on its trailing topics forever — no peer would ever see it as a hand-off partner there.
   */
  topics: z
    .array(beatString)
    .min(1)
    .max(MAX_RECORD_TOPICS, {
      message: `topics accepts at most ${MAX_RECORD_TOPICS} entries: a presence beat carries the whole list and every reader keeps only the first ${MAX_RECORD_TOPICS}, so the rest would be silently unreachable for hand-off`,
    }),
  /**
   * Extra topics allowed for `post`/`fetch_recent` ONLY, as full-match regex sources (anchored
   * `^(?:…)$` at compile time). Lets a chat instance post to ad-hoc topics without listing each
   * one. These are never subscribed to and never caught up on — that stays the explicit `topics`
   * list — but every presence beat DOES advertise them, as the record's `postTopics`: a peer
   * matches its own topics against these sources to decide whether this bridge is reachable for
   * hand-off (DESIGN §7). That topic is shared and readable by every participant on the backend,
   * so a pattern source must not encode anything confidential — it is published verbatim on every
   * beat. A pattern can never match the presence topic itself (it is reserved). Invalid
   * regexes are rejected at load (DESIGN §14). Capped at `MAX_POST_TOPICS`: the ReDoS screen
   * bounds each source on its own, and `Allowlist.has` matches a caller-supplied topic against every
   * one of them, so the count is the other half of that bound.
   */
  post_topics: z.array(beatString).max(MAX_POST_TOPICS).default([]),
  catchup: z
    .object({
      on_start: z.boolean().default(true),
      limit: z.number().int().positive().default(100),
      /**
       * Server-side cap (ms) on the `parley_fetch_recent` `block_ms` long-poll. A
       * caller's `block_ms` is clamped to this before it reaches a plugin, kept safely below MCP /
       * client tool timeouts so a blocked call never trips them. Default 60s, capped at
       * {@link MAX_BLOCK_MS}.
       */
      block_max_ms: z
        .number()
        .int()
        .nonnegative()
        .max(MAX_BLOCK_MS, {
          message: `catchup.block_max_ms must be <= ${MAX_BLOCK_MS} (ms): a blocked parley_fetch_recent holds the tool call for the whole clamp, and a longer one trips the MCP client tool timeout this field exists to stay under`,
        })
        .default(60_000),
      /**
       * Poll cadence (ms) for core's generic long-poll fallback — how often it re-queries when a
       * backend does not block natively. No correctness impact; latency/cost knob only.
       */
      block_poll_interval_ms: z.number().int().positive().default(250),
    })
    .strict()
    .default({}),
  live_push: z
    .object({
      enabled: z.boolean().default(false),
      mention_filter: z.boolean().default(false),
    })
    .strict()
    .default({}),
  /**
   * Presence (DESIGN §7): the bridge announces itself (hello/heartbeat/goodbye) to ONE shared
   * `topic` so `parley_list_users` can report who is LIVE — even an idle instance that hasn't
   * posted. Each beat carries the instance's subscribed topics, so a human only has to mute this
   * single topic. `ttl_ms` is the liveness window (a handle counts as live if its last beat is
   * within it); when unset it defaults to 3× `heartbeat_ms`. Reactive-only instances that cannot
   * receive `<channel>` pushes (the chat front door) should set `enabled: false`.
   */
  presence: z
    .object({
      enabled: z.boolean().default(true),
      topic: z.string().min(1).default(DEFAULT_PRESENCE_TOPIC),
      heartbeat_ms: z.number().int().positive().default(600_000),
      ttl_ms: z.number().int().positive().optional(),
    })
    .strict()
    .default({})
    // Dependent default: TTL tracks the heartbeat unless explicitly pinned.
    .transform((p) => ({ ...p, ttl_ms: p.ttl_ms ?? p.heartbeat_ms * 3 })),
  permissions: z
    .object({
      /**
       * Not implemented (DESIGN §2.5/§14): nothing reads this, so `true` is a load error. Keep it
       * rejected rather than ignored, so that no operator believes a sandbox mode is active.
       */
      skip_permissions: z.boolean().default(false),
    })
    .strict()
    .default({}),
  /** Remote-mode auth selection; ignored in local stdio mode. Absent = built-in OAuth AS. */
  auth: AuthSchema.default({}),
  /** Opaque to core; handed to the plugin verbatim (DESIGN §11). */
  backend_config: z.record(z.unknown()).default({}),
});

/**
 * Unknown keys are a load error, not silently dropped: a misspelled `live_push.enable` or
 * `presense:` would otherwise leave the operator with a bridge that quietly does nothing.
 * `backend_config` stays open — it is opaque to core (DESIGN §11).
 */
const StrictConfigObject = ConfigObject.strict();

/**
 * The load-time config schema: {@link ConfigObject} plus the checks that need the whole object.
 * A `post_topics` pattern that *could* match the presence topic is allowed — a broad `.*` is
 * legitimate — because the reserved guard in `Allowlist` blocks that at runtime.
 */
export const ConfigSchema = StrictConfigObject.superRefine((cfg, ctx) => {
  cfg.post_topics.forEach((src, i) => {
    try {
      new RegExp(src);
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['post_topics', i],
        message: `invalid regex: ${messageOf(err)}`,
      });
      return;
    }
    // The topic these patterns are matched against comes from a caller, so screen them here, so
    // that one careless operator pattern cannot be driven into catastrophic backtracking by a
    // hostile tool call.
    if (!isRedosSafeSource(src)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['post_topics', i],
        message:
          'pattern risks catastrophic backtracking (a repeatable ambiguous group, or too many ' +
          'alternations / optional or unbounded quantifiers); a caller-supplied topic could hang ' +
          'the bridge. Simplify it.',
      });
    }
  });
  if (cfg.topics.includes(cfg.presence.topic)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['topics'],
      message: `${JSON.stringify(cfg.presence.topic)} is reserved for presence (presence.topic); rename the topic or change presence.topic`,
    });
  }
  // A ttl below the heartbeat cadence would make every genuinely running instance read as offline
  // between beats. The dependent-default transform runs first, so `ttl_ms` is always a number here.
  if (cfg.presence.ttl_ms < cfg.presence.heartbeat_ms) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['presence', 'ttl_ms'],
      message:
        'presence.ttl_ms must be >= presence.heartbeat_ms; peers would appear offline between beats',
    });
  }
  if (cfg.live_push.mention_filter && !cfg.live_push.enabled) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['live_push', 'mention_filter'],
      message:
        'live_push.mention_filter is only read on the live push path, which live_push.enabled: ' +
        'false never starts — so it would filter nothing. Set live_push.enabled: true, or remove ' +
        'mention_filter.',
    });
  }
  if (
    cfg.live_push.enabled &&
    cfg.live_push.mention_filter &&
    !isMentionableHandle(cfg.identity.handle)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['identity', 'handle'],
      message:
        `live_push.mention_filter matches ${JSON.stringify(cfg.identity.handle)} against the ` +
        '@mentions parsed out of message content, and no message can ever produce that handle ' +
        '(a mention is ASCII letters/digits, with optional interior "." "-" "_"). Every inbound ' +
        'message would be dropped: choose a mentionable handle or set mention_filter: false.',
    });
  }
  if (cfg.permissions.skip_permissions) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['permissions', 'skip_permissions'],
      message:
        'permissions.skip_permissions is not implemented — nothing in core or any plugin reads it. ' +
        'Remove it (or set it to false); leaving it true would imply a permission mode that does not exist.',
    });
  }
});

export type ParleyConfig = z.infer<typeof ConfigSchema>;

/** Validate + default a raw config object (already parsed from YAML/JSON). */
export function parseConfig(raw: unknown): ParleyConfig {
  assertNoBackendKey(raw);
  return ConfigSchema.parse(raw);
}

/**
 * Load + validate a YAML config file. Every failure names the file and what kind of failure it was;
 * {@link parseConfig} stays the entry point for an embedder that wants the structured zod issues.
 */
export function loadConfig(path: string): ParleyConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`cannot read config ${path}: ${messageOf(err)}`, { cause: err });
  }
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (err) {
    throw new Error(`${path} is not valid YAML: ${messageOf(err)}`, { cause: err });
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data))
    throw new Error(
      `${path} is ${describeDocument(data)}; a Parley config is a top-level YAML mapping — ` +
        '`identity:`, `topics:` and the rest at the left margin.',
    );
  try {
    return parseConfig(data);
  } catch (err) {
    throw new Error(`${path} is not a valid Parley config:\n${issueLines(err)}`, { cause: err });
  }
}

/** The instance id used to namespace per-instance read-state (defaults to the handle). */
export function instanceIdOf(cfg: ParleyConfig): string {
  return cfg.instance_id ?? cfg.identity.handle;
}
