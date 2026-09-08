import {
  assertKnownConfigKeys,
  type BackendConfig,
  type BackendConfigKeys,
} from '@sharptrick/parley-core';
import { describeConfigValue, isLoopbackHost } from '@sharptrick/parley-net-util';
import { parse as parseDsn } from 'pg-connection-string';
import { badConfig } from './errors.js';

/** Plugin-specific backend_config (DESIGN §11). */
export interface PostgresBackendConfig {
  /** Connection URL. Default {@link DEFAULT_URL}. */
  url?: string;
  /**
   * Message table name; the sender registry lives beside it as `<table_name>_senders`. Default
   * {@link DEFAULT_TABLE_NAME}. Validated by `assertTableName` — it is interpolated into SQL.
   */
  table_name?: string;
  /** Max pooled connections for queries/writes (the LISTEN connection is separate). Default 5. */
  pool_size?: number;
  /**
   * Optional retention window in days, between {@link MIN_RETENTION_DAYS} and
   * {@link MAX_RETENTION_DAYS}: rows older than it are pruned on a background timer. Omit to keep
   * every message forever. Safe to enable at any time — `seq` is a BIGSERIAL and never reused, so
   * a cursor minted before a prune stays valid and just returns fewer rows.
   */
  retention_days?: number | null;
}

export const DEFAULT_URL = 'postgres://parley:parley@127.0.0.1:5432/parley';
export const DEFAULT_TABLE_NAME = 'parley_messages';
/** The repo-public credential pair the README's docker snippet provisions. */
const DEFAULT_USER = 'parley';
const DEFAULT_PASSWORD = 'parley';
/** Pooled connections `connect()` opens when `pool_size` is omitted. */
export const DEFAULT_POOL_SIZE = 5;
export const MIN_POOL_SIZE = 1;
export const MAX_POOL_SIZE = 1000;
/**
 * Widest retention window this backend accepts, in days (50 years). Keep a ceiling here, so that
 * every accepted window still has a cutoff a stored row could fall on.
 */
export const MAX_RETENTION_DAYS = 18_250;
/**
 * Narrowest retention window this backend accepts, in days: one minute. Keep a floor here, so that
 * an accepted window cannot empty the whole shared table on the prune `connect()` runs immediately.
 * Matches bridge-sqlite's floor for the identical key.
 */
export const MIN_RETENTION_DAYS = 1 / 1440;

/**
 * Every name `backend_config` declares. Keep the `satisfies` on it, so that a key added to
 * {@link PostgresBackendConfig} without being listed here is a compile error rather than a key
 * `connect()` rejects.
 */
const CONFIG_KEYS: BackendConfigKeys = {
  keys: Object.keys({
    url: 0,
    table_name: 0,
    pool_size: 0,
    retention_days: 0,
  } satisfies Record<keyof Required<PostgresBackendConfig>, 0>),
};

/**
 * Validate `backend_config` before the pool is opened or anything is deleted (§11). Every rejection
 * names the key and the plugin, and happens before `connect()` has touched the database, so a typo
 * or a mis-typed retention window can never take an irreversible action.
 */
export function validateBackendConfig(config: BackendConfig): PostgresBackendConfig {
  const cfg = config as Record<string, unknown>;
  assertKnownConfigKeys('postgres', config, CONFIG_KEYS);

  const url = cfg['url'];
  if (url !== undefined && (typeof url !== 'string' || url === '')) {
    throw badConfig('url', `expected a non-empty string, got ${describeConfigValue('url', url)}`);
  }

  const tableName = cfg['table_name'];
  if (tableName !== undefined && (typeof tableName !== 'string' || tableName === '')) {
    throw badConfig('table_name', `expected a non-empty string, got ${describeConfigValue('table_name', tableName)}`);
  }

  const poolSize = cfg['pool_size'];
  if (
    poolSize !== undefined &&
    (typeof poolSize !== 'number' ||
      !Number.isInteger(poolSize) ||
      poolSize < MIN_POOL_SIZE ||
      poolSize > MAX_POOL_SIZE)
  ) {
    throw badConfig(
      'pool_size',
      `expected an integer between ${MIN_POOL_SIZE} and ${MAX_POOL_SIZE}, got ` +
        `${describeConfigValue('pool_size', poolSize)} — a pool that cannot hand out a connection makes connect() ` +
        `wait forever`,
    );
  }

  const retention = cfg['retention_days'];
  if (
    retention !== undefined &&
    retention !== null &&
    (typeof retention !== 'number' ||
      !Number.isFinite(retention) ||
      !(retention >= MIN_RETENTION_DAYS) ||
      retention > MAX_RETENTION_DAYS)
  ) {
    throw badConfig(
      'retention_days',
      `expected a finite number of days between ${MIN_RETENTION_DAYS} (one minute) and ` +
        `${MAX_RETENTION_DAYS}, got ` +
        `${describeConfigValue('retention_days', retention)} — a window shorter than a minute empties the whole shared ` +
        'table on the prune connect() runs immediately, which is what 0 and negatives were ' +
        `already refused for, and a window past ${MAX_RETENTION_DAYS} days puts the cutoff ` +
        'before any message this backend could have written, so pruning would silently never run ' +
        'at all; omit the key (or set it to null) to keep every message forever',
    );
  }

  return cfg as PostgresBackendConfig;
}

/**
 * The origin to name when the DSN would put a credential on the wire in the clear, else undefined.
 *
 * Postgres carries no scheme that means TLS: `postgres://` is encrypted or not according to
 * `sslmode`/`ssl`, and `new Pool({ connectionString })` with neither leaves node-postgres at
 * ssl:false. So the question every sibling backend asks of its scheme is asked here of the SSL
 * settings the same parser `pg` itself uses reports. Keep the ORIGIN the thing that is named, so
 * that neither the password nor the database name reaches stderr; and keep the loopback question
 * delegated, so that this backend and the others answer it the same way.
 */
export function plaintextCredentialOrigin(url: string): string | undefined {
  let parsed: ReturnType<typeof parseDsn>;
  try {
    parsed = parseDsn(url);
  } catch {
    return undefined;
  }
  const host = parsed.host ?? '';
  const carriesCredential = (parsed.user ?? '') !== '' || (parsed.password ?? '') !== '';
  if (!carriesCredential || host === '' || isLoopbackHost(host) || Boolean(parsed.ssl)) {
    return undefined;
  }
  return `postgres://${host}${parsed.port === null || parsed.port === undefined ? '' : `:${parsed.port}`}`;
}

/**
 * True when the DSN carries the repo-public `parley:parley` pair, whatever host/port/database.
 *
 * Keep this deriving the credentials from `pg-connection-string` — the parser `new Pool({
 * connectionString })` itself uses — so that every spelling pg honours is graded: `new URL` sees
 * only the userinfo, and misses the published pair spelled as libpq `?user=`/`?password=`.
 */
export function usesDefaultCredentials(url: string): boolean {
  try {
    const parsed = parseDsn(url);
    // Keep these `||`, so that the env fallback still runs: the parser reports a credential the DSN
    // omits as '', and pg authenticates such a DSN as PGUSER/PGPASSWORD.
    const user = parsed.user || process.env['PGUSER'];
    const password = parsed.password || process.env['PGPASSWORD'];
    return user === DEFAULT_USER && password === DEFAULT_PASSWORD;
  } catch {
    return false;
  }
}
