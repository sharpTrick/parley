import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { DEFAULT_PRESENCE_TOPIC } from './engine/presence.js';

/**
 * Remote-mode auth via an external OIDC IdP (e.g. Keycloak) — the delegated resource-server
 * variant of DESIGN §10. Parley hosts no /authorize,/token,/register in this mode; it publishes
 * Protected Resource Metadata pointing at the issuer and validates inbound Bearer JWTs locally.
 * Nothing in this block is a secret (issuer/audience/claim policy are public-side config).
 */
export const OidcAuthSchema = z.object({
  /** OIDC issuer, e.g. https://kc.example.com/realms/myrealm. Discovery is fetched from
   *  `<issuer>/.well-known/openid-configuration` at startup. */
  issuer: z.string().url(),
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
});

export type OidcAuthConfig = z.infer<typeof OidcAuthSchema>;

/** Remote-mode auth selection: the built-in single-tenant OAuth AS (default) or external OIDC. */
export const AuthSchema = z
  .object({
    mode: z.enum(['builtin', 'oidc']).default('builtin'),
    oidc: OidcAuthSchema.optional(),
  })
  .superRefine((a, ctx) => {
    if (a.mode === 'oidc' && a.oidc === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['oidc'],
        message: 'auth.mode "oidc" requires an auth.oidc block',
      });
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
  /** Which backend plugin to load. v0.1 ships only local-sqlite. */
  backend: z.string().default('local-sqlite'),
  /** Read-state namespace; defaults to identity.handle. Distinct sessions sharing a handle
   *  MUST set distinct instance_ids (DESIGN §10). */
  instance_id: z.string().optional(),
  /** Override the read-state file path (default: XDG_STATE_HOME/parley/<instance>/read-state.json). */
  state_path: z.string().optional(),
  identity: z.object({
    handle: z.string().min(1),
  }),
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
    })
    .default({}),
  live_push: z
    .object({
      enabled: z.boolean().default(false),
      mention_filter: z.boolean().default(false),
    })
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
    .default({})
    // Dependent default: TTL tracks the heartbeat unless explicitly pinned.
    .transform((p) => ({ ...p, ttl_ms: p.ttl_ms ?? p.heartbeat_ms * 3 })),
  permissions: z
    .object({
      // DANGEROUS; sandbox-only; default OFF (DESIGN §2.5/§14). Read but unused in v0.1.
      skip_permissions: z.boolean().default(false),
    })
    .default({}),
  /** Remote-mode auth selection; ignored in local stdio mode. Absent = built-in OAuth AS. */
  auth: AuthSchema.default({}),
  /** Opaque to core; handed to the plugin verbatim (DESIGN §11). */
  backend_config: z.record(z.unknown()).default({}),
});

/**
 * The load-time config schema. Wraps {@link ConfigObject} with cross-field validation:
 *  - every `post_topics` pattern must be a compilable regex;
 *  - the reserved presence topic must not appear in the explicit `topics` list.
 * (A `post_topics` pattern that *could* match the presence topic is allowed — a broad `.*` is
 * legitimate — because the reserved guard in {@link Allowlist} blocks that at runtime.)
 */
export const ConfigSchema = ConfigObject.superRefine((cfg, ctx) => {
  cfg.post_topics.forEach((src, i) => {
    try {
      new RegExp(src);
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['post_topics', i],
        message: `invalid regex: ${err instanceof Error ? err.message : String(err)}`,
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
});

export type ParleyConfig = z.infer<typeof ConfigSchema>;

/** Validate + default a raw config object (already parsed from YAML/JSON). */
export function parseConfig(raw: unknown): ParleyConfig {
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
