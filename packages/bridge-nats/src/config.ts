import type { BackendConfig } from '@sharptrick/parley-core';
import { isLoopbackHost } from '@sharptrick/parley-net-util';
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
  retention_days?: number;
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

const CONFIG_KEYS = [
  'servers',
  'subject_prefix',
  'stream_prefix',
  'retention_days',
  'token',
  'user',
  'pass',
  'creds_file',
  'nkey_seed',
  'tls',
] as const satisfies readonly (keyof NatsBackendConfig)[];

/**
 * A key this plugin does not read is a key it silently drops, and every field here is either a
 * credential or an addressing decision: a misspelled `token` connects anonymously, a misspelled
 * `subject_prefix` addresses a different stream than the sibling instance the operator meant to
 * share with. Refuse at connect(), naming the offender, rather than honouring the default.
 */
export function assertKnownConfigKeys(config: BackendConfig): void {
  for (const key of Object.keys(config)) {
    if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
      throw new Error(
        `parley-nats: unknown backend_config key '${key}' — expected one of ${CONFIG_KEYS.join(', ')}`,
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
    throw new Error(`invalid ${field} ${JSON.stringify(value)} — expected a string`);
  }
  const offender = (illegal.exec(value) ?? CONTROL_CHARS.exec(value))?.[0];
  if (offender !== undefined) {
    throw new Error(
      `invalid ${field} ${JSON.stringify(value)} — ${JSON.stringify(offender)} is not allowed in a NATS name`,
    );
  }
  const composed = value + PROBE_TOKEN;
  if (composed.split('.').some((token) => token === '')) {
    throw new Error(
      `invalid ${field} ${JSON.stringify(value)} — it composes the illegal name ${JSON.stringify(composed)}: no dot-separated token of a NATS name may be empty`,
    );
  }
  const bytes = Buffer.byteLength(composed, 'utf8');
  if (maxComposedBytes !== undefined && bytes > maxComposedBytes) {
    throw new Error(
      `invalid ${field} ${JSON.stringify(value)} — it composes ${JSON.stringify(composed)} at ${bytes} bytes, over the ${maxComposedBytes}-byte limit, so no topic could be named at all`,
    );
  }
  return value;
}

/**
 * JetStream reads `max_age: 0` as UNLIMITED, so `retention_days: 0` would mean the exact opposite
 * of what an operator wrote, and a negative value fails later with an unrelated driver error.
 * Reject both at connect, before a stream is created with a window that is then locked in.
 */
export function validateRetentionDays(days: number | undefined): number | undefined {
  if (days === undefined) return undefined;
  if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0) {
    throw new Error(
      `invalid retention_days ${JSON.stringify(days)} — expected a positive number of days, or omit it for unlimited retention`,
    );
  }
  return days;
}

/** The schemes nats.js opens unencrypted. A bare `host:port` is one of them — it reads as `nats:`. */
const PLAINTEXT_SCHEMES = ['nats:', 'ws:'];
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
 * The server as written — userinfo redacted — when it would carry the CONNECT frame's credential in
 * the clear, else undefined. nats.js upgrades a `nats://`/`ws://` link only when
 * `backend_config.tls` asks it to or the server refuses to go on without it, and it sends
 * `token`/`user`/`pass` in the first frame either way — so a plaintext scheme to a host we cannot
 * PROVE is loopback is a credential on the wire. Keep an unparseable server on the warned side, so
 * that an address this cannot classify is reported rather than excused.
 */
export function plaintextRemoteServer(server: string): string | undefined {
  const text = server.trim();
  const prefix = schemePrefix(text);
  if (prefix !== '' && !PLAINTEXT_SCHEMES.includes(prefix.slice(0, -2).toLowerCase())) return undefined;
  // Keep the authority split by hand rather than through `URL`, so that every scheme is classified
  // by the same rules: `URL` canonicalizes an integer-form IPv4 host for `ws:` and leaves it alone
  // for `nats:`, which would excuse under one scheme exactly what it warns about under the other.
  const authority = text.slice(prefix.length);
  const host = authorityHead(authority)
    .slice(userinfoEnd(authority) + 1)
    .replace(/^(\[[^\]]*]):\d+$/, '$1')
    .replace(/^([^:[]*):\d+$/, '$1')
    .toLowerCase();
  return host !== '' && isLoopbackHost(host) ? undefined : redactUserinfo(text);
}

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

/**
 * One warning per `servers` entry that would put a configured credential on an unencrypted remote
 * link. A warning rather than a load error: a cluster fronted by a TLS-terminating sidecar, and a
 * loopback fixture, are both legitimate — but neither is a reason for the mistake to be silent.
 * The offending fields are named — never their values.
 */
export function plaintextCredentialRisks(cfg: NatsBackendConfig): string[] {
  const fields = (['token', 'user', 'pass', 'creds_file', 'nkey_seed'] as const).filter(
    (field) => cfg[field] !== undefined,
  );
  if (fields.length === 0 || cfg.tls !== undefined) return [];
  const servers = [cfg.servers ?? DEFAULT_SERVERS].flat();
  return servers.flatMap((server) => {
    const plaintext = plaintextRemoteServer(String(server));
    return plaintext === undefined
      ? []
      : [
          `backend_config.servers ${JSON.stringify(plaintext)} is an unencrypted NATS scheme to a ` +
            'non-loopback host and backend_config.tls is unset, so the CONNECT frame carries ' +
            `backend_config.${fields.join('/')} across the network in the clear. Use tls:// (or ` +
            'wss://), or set backend_config.tls.',
        ];
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
