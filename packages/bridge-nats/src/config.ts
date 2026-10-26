import {
  assertKnownConfigKeys,
  type BackendConfig,
  type BackendConfigKeys,
  isPlainObject,
} from '@sharptrick/parley-core';
import {
  describeConfigValue,
  isLoopbackHost,
  type PlaintextCredentialRisk,
  sanitizeBody,
} from '@sharptrick/parley-net-util';
import { readFileSync } from 'node:fs';
import { credsAuthenticator, nkeyAuthenticator, type ConnectionOptions } from 'nats';

/** Plugin-specific backend_config. */
export interface NatsBackendConfig {
  /** Server(s). Default `127.0.0.1:4222`. */
  servers?: string | string[];
  /** Subject prefix. Default `parley.`. Each topic → subject `<prefix><token>`. */
  subject_prefix?: string;
  /** JetStream stream-name prefix. Default `PARLEY_`. One stream per topic. */
  stream_prefix?: string;
  /**
   * Optional retention window in days, set as the stream's `max_age` at creation time. Omit for
   * the default — keep every message forever. Applies only when THIS plugin creates the stream
   * (`ensureStream`'s first caller); changing it later does not retroactively update an
   * already-existing stream — edit or recreate the stream out-of-band for that.
   */
  retention_days?: number | null;
  /** Token auth (`-auth`/`authorization.token`). Secret — `backend_config`/`.env` only. */
  token?: string;
  /** User/password auth. Secret — `backend_config`/`.env` only. */
  user?: string;
  pass?: string;
  /** Path to a NATS `.creds` file (JWT + nkey seed) — NGS and any JWT-secured cluster. */
  creds_file?: string;
  /** Raw nkey seed (`SU…`); prefer `creds_file`. Secret — `backend_config`/`.env` only. */
  nkey_seed?: string;
  /** TLS material, as file paths. */
  tls?: { ca_file?: string; cert_file?: string; key_file?: string };
}

const RECONNECT_WAIT_MS = 1000;
const RECONNECT_JITTER_MS = 500;
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f]');

/**
 * Every name `backend_config` declares, including the members of `tls` — the level a top-level key
 * check cannot see. Keep the `satisfies` on it, so that a key added to {@link NatsBackendConfig}
 * without being listed here is a compile error rather than a key `connect()` rejects.
 */
export const DECLARED: BackendConfigKeys = {
  keys: Object.keys({
    servers: 0,
    subject_prefix: 0,
    stream_prefix: 0,
    retention_days: 0,
    token: 0,
    user: 0,
    pass: 0,
    creds_file: 0,
    nkey_seed: 0,
    tls: 0,
  } satisfies Record<keyof Required<NatsBackendConfig>, 0>),
  nested: {
    tls: Object.keys({
      ca_file: 0,
      cert_file: 0,
      key_file: 0,
    } satisfies Record<keyof Required<NonNullable<NatsBackendConfig['tls']>>, 0>),
  },
};

/** What a value IS, for a diagnostic that must never carry what a value HOLDS. */
const typeName = (value: unknown): string =>
  Array.isArray(value) ? 'an array' : value === null ? 'null' : `a ${typeof value}`;

/**
 * A key this plugin does not read is a key it silently drops, and every field here is either a
 * credential or an addressing decision: a misspelled `token` connects anonymously, a misspelled
 * `subject_prefix` addresses a different stream than the sibling instance the operator meant to
 * share with. Refuse at connect(), naming the offender, rather than honouring the default.
 * Keep the walk one level INTO every declared object, so that `tls.ca_flie` is refused rather than
 * dropped — a dropped `ca_file` verifies the link against the system trust store instead of the
 * pinned CA, and a dropped `cert_file` presents no client certificate at all, both silently.
 */
export function assertKnownBackendConfig(config: BackendConfig): void {
  assertKnownConfigKeys('nats', config, DECLARED);
  const cfg = config as Record<string, unknown>;
  for (const key of Object.keys(DECLARED.nested ?? {})) {
    const value = cfg[key];
    if (!isPlainObject(value)) continue;
    for (const [member, held] of Object.entries(value)) {
      if (held === undefined || typeof held === 'string') continue;
      throw new Error(
        `parley-nats: invalid backend_config.${key}.${member} — expected a string, not ${typeName(held)}`,
      );
    }
  }
}

/** Stands in for a topic token, so a prefix is judged by the name it actually composes. */
const PROBE_TOKEN = 'topic';

/**
 * A prefix is pasted straight onto a subject or a stream name, so an operator's typo becomes a
 * NATS wildcard or an illegal name. A wildcard is the dangerous one: `pw.*.` makes the per-topic
 * stream capture `pw.<anything>.<topic>`, delivering a foreign publisher's messages as if they were
 * on an allowlisted topic. Rejected at connect(), naming the field, rather than at the first post
 * with a driver error that names neither.
 */
export function validatePrefix(
  field: string,
  value: string | undefined,
  fallback: string,
  illegal: RegExp,
  maxComposedBytes?: number,
): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') {
    throw new Error(`parley-nats: invalid ${field} ${describeConfigValue(field, value)} — expected a string`);
  }
  const offender = (illegal.exec(value) ?? CONTROL_CHARS.exec(value))?.[0];
  if (offender !== undefined) {
    throw new Error(
      `parley-nats: invalid ${field} ${describeConfigValue(field, value)} — ${describeConfigValue(field, offender)} is not allowed in a NATS name`,
    );
  }
  const composed = value + PROBE_TOKEN;
  if (composed.split('.').some((token) => token === '')) {
    throw new Error(
      `parley-nats: invalid ${field} composes the illegal name ${describeConfigValue(field, composed)}: no dot-separated token of a NATS name may be empty`,
    );
  }
  const bytes = Buffer.byteLength(composed, 'utf8');
  if (maxComposedBytes !== undefined && bytes > maxComposedBytes) {
    throw new Error(
      `parley-nats: invalid ${field} ${describeConfigValue(field, value)} — with a topic token it composes ${bytes} bytes, over the ${maxComposedBytes}-byte limit, so no topic could be named at all`,
    );
  }
  return value;
}

const NS_PER_DAY = 86_400_000_000_000;

/**
 * Floor for `retention_days`: one minute, expressed in days — the same floor the SQL-backed
 * backends state, for the same reason. `max_age` is locked in at stream creation, so a window too
 * short to hold a conversation expires every message as fast as it is posted; the nanosecond guard
 * below only refuses a window that composes ZERO, which leaves the whole band between "instantly
 * empty" and "one minute" quietly accepted.
 */
export const MIN_RETENTION_DAYS = 1 / 1440;

/**
 * One past the largest `max_age` JetStream's int64 can hold. Every double below this is a legal
 * int64; `2**63` itself and everything above it — including `Infinity` — is not.
 */
const MAX_AGE_NS_LIMIT = 2 ** 63;

/**
 * The stream's `max_age`, in the nanoseconds JetStream takes, or undefined for unlimited.
 * JetStream reads `max_age: 0` as UNLIMITED, so a window that composes zero would mean the exact
 * opposite of what an operator wrote, and a negative value fails later with an unrelated driver
 * error. Judge the NANOSECONDS the days compose rather than the days, and bound them from BOTH
 * sides, so that neither a positive number of days too small to round to one nanosecond nor one
 * large enough to leave int64 can slip past into a stream whose retention is then locked in at
 * creation. Over int64 the two failures differ but neither is survivable: up to the double's own
 * range the server refuses the stream with `parley-nats: invalid json` on every post, and past it the composed
 * value is `Infinity`, which serializes to `null` and which the server stores as `max_age: 0` —
 * unlimited, silently, exactly what the low guard exists to prevent.
 */
export function validateRetentionMaxAgeNs(days: number | null | undefined): number | undefined {
  if (days === undefined || days === null) return undefined;
  if (typeof days !== 'number' || !Number.isFinite(days) || days < MIN_RETENTION_DAYS) {
    throw new Error(
      `parley-nats: invalid retention_days ${describeConfigValue('retention_days', days)} — expected a number of days no smaller than ${MIN_RETENTION_DAYS} (one minute), or omit it (or set it to null) for unlimited retention`,
    );
  }
  const maxAgeNs = Math.round(days * NS_PER_DAY);
  if (maxAgeNs < 1) {
    throw new Error(
      `parley-nats: invalid retention_days ${describeConfigValue('retention_days', days)} — it composes a max_age of ${maxAgeNs}ns, which JetStream reads as UNLIMITED retention, the opposite of a retention window`,
    );
  }
  if (maxAgeNs >= MAX_AGE_NS_LIMIT) {
    throw new Error(
      `parley-nats: invalid retention_days ${describeConfigValue('retention_days', days)} — it composes a max_age of ${maxAgeNs}ns, past the 2^63-1 nanoseconds JetStream's int64 can hold, so the stream would either be refused on every post or be created with UNLIMITED retention`,
    );
  }
  return maxAgeNs;
}

/** Where nats.js connects when `backend_config.servers` is unset. */
const DEFAULT_SERVERS = '127.0.0.1:4222';
/** What stands in for a URL's userinfo everywhere a server address is named. */
const REDACTED_USERINFO = '<redacted>';

/** The scheme's `xxx://`, as written, or `''` — a bare `host:port` carries none. */
const schemePrefix = (server: string): string => /^[a-z][a-z0-9+.-]*:\/\//i.exec(server)?.[0] ?? '';

/** An address's authority: everything before the first `/`, `?` or `#`. */
const authorityHead = (authority: string): string => /^[^/?#]*/.exec(authority)?.[0] ?? '';

/** Where an authority's userinfo ends: the LAST `@`, since a password may hold one. */
const userinfoEnd = (authority: string): number => authorityHead(authority).lastIndexOf('@');

/**
 * `server` with any URL userinfo replaced. Keep every diagnostic that names a server routed through
 * this, so that a password written into the address — `nats://user:pass@host`, the standard NATS
 * spelling — cannot reach a log line.
 */
export function redactUserinfo(server: string): string {
  const text = server.trim();
  const prefix = schemePrefix(text);
  const authority = text.slice(prefix.length);
  const at = userinfoEnd(authority);
  return at < 0 ? text : `${prefix}${REDACTED_USERINFO}@${authority.slice(at + 1)}`;
}

/**
 * The server as written — userinfo redacted — when it names a host we cannot PROVE is loopback, else
 * undefined. nats.js strips the scheme before it dials (`servers.js` `hostPort()`) and decides
 * encryption from `backend_config.tls` and the server's INFO alone, so `tls://` and `wss://` select
 * nothing: every scheme reaches this server over the same plain TCP socket, carrying
 * `token`/`user`/`pass` in the CONNECT frame. Keep the scheme out of this judgement, so that an
 * address cannot be excused by a prefix the driver never reads.
 */
export function plaintextRemoteServer(server: string): string | undefined {
  const host = serverHost(server);
  return host !== '' && isLoopbackHost(host) ? undefined : redactUserinfo(server.trim());
}

/**
 * The `host[:port]` an address names, userinfo dropped. Keep the authority split by hand rather
 * than through `URL`, so that every scheme is classified by the same rules: `URL` canonicalizes an
 * integer-form IPv4 host for `ws:` and leaves it alone for `nats:`, which would excuse under one
 * scheme exactly what it warns about under the other.
 */
export function serverAuthority(server: string): string {
  const text = server.trim();
  const authority = text.slice(schemePrefix(text).length);
  return authorityHead(authority).slice(userinfoEnd(authority) + 1);
}

const serverHost = (server: string): string =>
  serverAuthority(server)
    .replace(/^(\[[^\]]*]):\d+$/, '$1')
    .replace(/^([^:[]*):\d+$/, '$1')
    .toLowerCase();

/** Longest DNS name there is, plus a port; a diagnostic naming a server needs no more. */
const MAX_AUTHORITY_IN_DIAGNOSTIC = 259;

/**
 * nats.js builds its server list from the address's HOST alone (`servers.js` `hostPort()` keeps
 * `url.host`), so a credential written into a `servers` URL never reaches the CONNECT frame and the
 * link is opened anonymously. Refuse at connect(), naming the field and never the value, rather than
 * leaving an operator believing a cluster is authenticated.
 */
export function assertNoServerCredentials(cfg: NatsBackendConfig): void {
  for (const server of [cfg.servers ?? DEFAULT_SERVERS].flat()) {
    const text = String(server).trim();
    const redacted = redactUserinfo(text);
    if (redacted === text) continue;
    throw new Error(
      `parley-nats: backend_config.servers ${JSON.stringify(redacted)} carries a credential in the ` +
        'URL, which nats.js drops before it connects — the link would be opened anonymously. Put ' +
        'it in backend_config.user/pass, token, creds_file or nkey_seed instead.',
    );
  }
}

/** Every `backend_config` key the CONNECT frame carries as a credential. */
const CREDENTIAL_CONFIG_KEYS = ['token', 'user', 'pass', 'creds_file', 'nkey_seed'] as const;

/** A `servers` entry that widens this backend's trust boundary, as the fact rather than the sentence. */
export type ConfigRisk = PlaintextCredentialRisk<
  'servers',
  (typeof CREDENTIAL_CONFIG_KEYS)[number]
>;

/** The operator's stderr line for a risk. Rendered from the risk, so it cannot describe another. */
export const describeRisk = (risk: ConfigRisk): string =>
  `backend_config.${risk.key} ${JSON.stringify(risk.origin)} is a non-loopback host and ` +
  'backend_config.tls is unset, so nothing here forces encryption and the CONNECT frame ' +
  `may carry backend_config.${risk.exposes.join('/')} across the network in the clear. Set ` +
  'backend_config.tls — nats.js discards the URL scheme, so tls:// does not encrypt.';

/**
 * One risk per `servers` entry that would put a configured credential on a remote link nothing
 * in this config forces to be encrypted. A warning rather than a load error: a TLS-terminating
 * sidecar, a loopback fixture, and a server whose INFO offers TLS (which nats.js then upgrades to
 * on its own) are all legitimate — but none is a reason for the mistake to be silent. Setting
 * `backend_config.tls` is what turns that opportunistic upgrade into a fail-fast guarantee.
 */
export function configRisks(cfg: NatsBackendConfig): ConfigRisk[] {
  const exposes = CREDENTIAL_CONFIG_KEYS.filter((field) => cfg[field] !== undefined);
  if (exposes.length === 0 || cfg.tls !== undefined) return [];
  const servers = [cfg.servers ?? DEFAULT_SERVERS].flat();
  return servers.flatMap((server) => {
    const text = String(server);
    if (plaintextRemoteServer(text) === undefined) return [];
    const origin = sanitizeBody(serverAuthority(text)).slice(0, MAX_AUTHORITY_IN_DIAGNOSTIC);
    return [{ key: 'servers', origin, exposes }];
  });
}

export function connectionOptions(cfg: NatsBackendConfig): ConnectionOptions {
  const opts: ConnectionOptions = {
    servers: cfg.servers ?? DEFAULT_SERVERS,
    // Keep the unbounded reconnect: nats.js defaults to 10 attempts, after which the connection
    // CLOSES for good — every later post/fetch throws CONNECTION_CLOSED and live delivery stops.
    maxReconnectAttempts: -1,
    reconnectTimeWait: RECONNECT_WAIT_MS,
    reconnectJitter: RECONNECT_JITTER_MS,
  };
  if (cfg.token !== undefined) opts.token = cfg.token;
  if (cfg.user !== undefined) opts.user = cfg.user;
  if (cfg.pass !== undefined) opts.pass = cfg.pass;
  if (cfg.creds_file !== undefined) {
    opts.authenticator = credsAuthenticator(readFileSync(cfg.creds_file));
  } else if (cfg.nkey_seed !== undefined) {
    opts.authenticator = nkeyAuthenticator(new TextEncoder().encode(cfg.nkey_seed));
  }
  if (cfg.tls !== undefined) {
    opts.tls = {
      caFile: cfg.tls.ca_file,
      certFile: cfg.tls.cert_file,
      keyFile: cfg.tls.key_file,
    };
  }
  return opts;
}
