import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { DEFAULT_PRESENCE_TOPIC } from './engine/presence.js';
import { isMentionableHandle } from './mentions.js';
import { isRedosSafeSource } from './regex-safety.js';

/**
 * Remote-mode auth via an external OIDC IdP (e.g. Keycloak) — the delegated resource-server
 * variant of DESIGN §10. Parley hosts no /authorize,/token,/register in this mode; it publishes
 * Protected Resource Metadata pointing at the issuer and validates inbound Bearer JWTs locally.
 * Nothing in this block is a secret (issuer/audience/claim policy are public-side config).
 */
export const OidcAuthSchema = z
  .object({
    /** OIDC issuer, e.g. https://kc.example.com/realms/myrealm. Discovery is fetched from
     *  `<issuer>/.well-known/openid-configuration` at startup. Must be https — the JWKS trust
     *  root depends on TLS — except on loopback, where test/dev fakes serve over http. */
    issuer: z
      .string()
      .url()
      .refine(
        (u) => {
          const url = new URL(u);
          return (
            url.protocol === 'https:' || url.hostname === '127.0.0.1' || url.hostname === 'localhost'
          );
        },
        { message: 'auth.oidc.issuer must use https (the JWKS trust root depends on TLS)' },
      ),
    /** Expected `aud` value. Default: the canonical resource id (public URL + mcpPath). Keycloak
     *  ignores RFC 8707 `resource`, so an audience mapper must emit this exact string — see
     *  docs/keycloak-integration.md. */
    audience: z.string().min(1).optional(),
    /** Override the JWKS URI (default: `jwks_uri` from discovery). */
    jwks_uri: z.string().url().optional(),
    /** If set, the token's `scope` (space-separated) must include this value. */
    required_scope: z.string().min(1).optional(),
    /** Identity gates preserving the single-tenant posture: any that are set must ALL pass.
     *  Issuer + audience validation is always mandatory regardless. */
    allowed_subjects: z.array(z.string().min(1)).nonempty().optional(),
    /** Matched against the `preferred_username` claim. */
    allowed_usernames: z.array(z.string().min(1)).nonempty().optional(),
    /** Required realm role (Keycloak `realm_access.roles`). */
    required_role: z.string().min(1).optional(),
    /** exp/nbf tolerance in seconds. */
    clock_skew_s: z.number().int().min(0).max(300).default(30),
  })
  .strict();

export type OidcAuthConfig = z.infer<typeof OidcAuthSchema>;

/** Remote-mode auth selection: the built-in single-tenant OAuth AS (default) or external OIDC. */
export const AuthSchema = z
  .object({
    mode: z.enum(['builtin', 'oidc']).default('builtin'),
    oidc: OidcAuthSchema.optional(),
  })
  .strict()
  .superRefine((a, ctx) => {
    if (a.mode === 'oidc' && a.oidc === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['oidc'],
        message: 'auth.mode "oidc" requires an auth.oidc block',
      });
      return;
    }
    if (a.mode === 'oidc' && a.oidc !== undefined) {
      // Delegated OIDC has no owner-consent step, so an identity gate is the ONLY thing that
      // keeps a shared/corporate realm from authorizing every realm user. Require at least one.
      // `required_scope` alone is insufficient (Claude's connector may request no scopes).
      const { allowed_subjects, allowed_usernames, required_role } = a.oidc;
      if (
        allowed_subjects === undefined &&
        allowed_usernames === undefined &&
        required_role === undefined
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['oidc'],
          message:
            'auth.mode "oidc" requires an identity gate: set at least one of ' +
            'allowed_subjects / allowed_usernames / required_role to preserve the single-tenant ' +
            'posture (required_scope alone is not sufficient). See docs/keycloak-integration.md.',
        });
      }
    }
  });

export type AuthConfig = z.infer<typeof AuthSchema>;

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
  instance_id: z.string().optional(),
  /** Override the read-state file path (default: XDG_STATE_HOME/parley/<instance>/read-state.json). */
  state_path: z.string().optional(),
  identity: z
    .object({
      handle: z.string().min(1),
    })
    .strict(),
  /** Topics to subscribe to / catch up on. THIS IS THE ALLOWLIST (DESIGN §14). */
  topics: z.array(z.string().min(1)).min(1),
  /**
   * Extra topics allowed for `post`/`fetch_recent` ONLY, as full-match regex sources (anchored
   * `^(?:…)$` at compile time). Lets a chat instance post to ad-hoc topics without listing each
   * one. These are NEVER subscribed / caught up on / announced in presence — that stays the
   * explicit `topics` list. The presence topic can never be matched (it is reserved). Invalid
   * regexes are rejected at load (DESIGN §14).
   */
  post_topics: z.array(z.string().min(1)).default([]),
  catchup: z
    .object({
      on_start: z.boolean().default(true),
      limit: z.number().int().positive().default(100),
      /**
       * Server-side cap (ms) on the `parley_fetch_recent` `block_ms` long-poll (issue #20). A
       * caller's `block_ms` is clamped to this before it reaches a plugin, kept safely below MCP /
       * client tool timeouts so a blocked call never trips them. Default 60s.
       */
      block_max_ms: z.number().int().nonnegative().default(60_000),
      /**
       * Poll cadence (ms) for core's generic long-poll fallback — how often it re-queries when a
       * backend does not block natively (issue #20). No correctness impact; latency/cost knob only.
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
 * The load-time config schema. Wraps {@link ConfigObject} with cross-field validation:
 *  - every `post_topics` pattern must be a compilable regex;
 *  - the reserved presence topic must not appear in the explicit `topics` list.
 * (A `post_topics` pattern that *could* match the presence topic is allowed — a broad `.*` is
 * legitimate — because the reserved guard in {@link Allowlist} blocks that at runtime.)
 */
export const ConfigSchema = StrictConfigObject.superRefine((cfg, ctx) => {
  cfg.post_topics.forEach((src, i) => {
    try {
      new RegExp(src);
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['post_topics', i],
        message: `invalid regex: ${err instanceof Error ? err.message : String(err)}`,
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
  // `ttl_ms` is populated by the dependent-default transform before superRefine runs (default 3×, or
  // the pinned value), so it is always a number here. A ttl below the heartbeat cadence would make
  // every genuinely running instance read as offline in computeRoster between beats (BUG-34).
  if (cfg.presence.ttl_ms < cfg.presence.heartbeat_ms) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['presence', 'ttl_ms'],
      message:
        'presence.ttl_ms must be >= presence.heartbeat_ms; peers would appear offline between beats',
    });
  }
  if (cfg.live_push.mention_filter && !isMentionableHandle(cfg.identity.handle)) {
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

/**
 * Reject a legacy `backend:` key rather than letting zod strip it, so that a config naming one
 * backend can never run a different one silently.
 */
function assertNoBackendKey(raw: unknown): void {
  if (typeof raw !== 'object' || raw === null || !('backend' in raw)) return;
  const value = (raw as { backend: unknown }).backend;
  const named = typeof value === 'string' ? value.replace(/^local-/, '') : undefined;
  const suggestion =
    named !== undefined ? `parley-${named}` : 'parley-sqlite, parley-matrix, parley-redis, …';
  throw new Error(
    'config: `backend` is not a supported field. The backend is selected by which binary you run, ' +
      `not by config — run \`${suggestion}\` (each backend package ships its own bin). ` +
      'Remove `backend:` from the config file.',
  );
}

/** Validate + default a raw config object (already parsed from YAML/JSON). */
export function parseConfig(raw: unknown): ParleyConfig {
  assertNoBackendKey(raw);
  return ConfigSchema.parse(raw);
}

/** Load + validate a YAML config file. */
export function loadConfig(path: string): ParleyConfig {
  const data: unknown = parseYaml(readFileSync(path, 'utf8'));
  return parseConfig(data);
}

/** The instance id used to namespace per-instance read-state (defaults to the handle). */
export function instanceIdOf(cfg: ParleyConfig): string {
  return cfg.instance_id ?? cfg.identity.handle;
}
