import { afterEach, describe, expect, it, vi } from 'vitest';
import { PostgresPlugin } from '../src/index.js';

// Postgres must not silently connect with the repo-public default DSN
// (postgres://parley:parley@…). connect() opens a pool and runs the idempotent schema bootstrap,
// so mock `pg` to a no-op pool/client; the warning fires before `new Pool(...)`. The mock lets the
// whole connect() resolve so the gate sits on the happy path, not an incidental connection failure.
vi.mock('pg', () => {
  const makeClient = () => ({
    query: vi.fn(async () => ({ rows: [] })),
    release: vi.fn(),
    on: vi.fn(),
    connect: vi.fn(async () => undefined),
    end: vi.fn(async () => undefined),
  });
  return {
    Pool: vi.fn(() => ({
      on: vi.fn(),
      connect: vi.fn(async () => makeClient()),
      query: vi.fn(async () => ({ rows: [] })),
      end: vi.fn(async () => undefined),
    })),
    Client: vi.fn(() => makeClient()),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const spyWarn = () => vi.spyOn(console, 'warn').mockImplementation(() => undefined);

const DEFAULT_USER = 'parley';
const DEFAULT_PASSWORD = 'parley';

// The warning must key on the CREDENTIALS PG WILL ACTUALLY AUTHENTICATE WITH, not on a literal DSN
// string and not on the userinfo alone: the README tells the operator to provision exactly
// parley/parley, so every spelling that delivers that pair to the server is the same published
// password. `new Pool({connectionString})` parses with pg-connection-string, which honours the libpq
// `?user=`/`?password=` query parameters and percent-decodes userinfo — so a DSN can carry the
// published pair with an empty userinfo and authenticate fine.
const DSN_CASES: [label: string, url: string | undefined, warns: boolean][] = [
  ['url omitted (falls back to the default)', undefined, true],
  ['the exact default DSN', 'postgres://parley:parley@127.0.0.1:5432/parley', true],
  ['default creds via localhost', 'postgres://parley:parley@localhost:5432/parley', true],
  ['default creds via a docker-network host', 'postgres://parley:parley@db/parley', true],
  ['default creds, port omitted', 'postgres://parley:parley@127.0.0.1/parley', true],
  ['default creds, different database', 'postgres://parley:parley@127.0.0.1:5432/other', true],
  ['default creds, postgresql:// scheme', 'postgresql://parley:parley@db.internal:6432/app', true],
  ['default creds as libpq query params', 'postgres://127.0.0.1:5432/parley?user=parley&password=parley', true],
  ['default creds as query params, other params too', 'postgres://db/parley?application_name=x&user=parley&password=parley&sslmode=disable', true],
  ['default user in userinfo, default password as a query param', 'postgres://parley@db:5432/parley?password=parley', true],
  ['default creds percent-encoded in the userinfo', 'postgres://%70arley:%70arley@127.0.0.1/parley', true],
  ['default user, real password', 'postgres://parley:hunter2@127.0.0.1:5432/parley', false],
  ['real user, default password', 'postgres://app:parley@127.0.0.1:5432/parley', false],
  ['a real DSN', 'postgres://app:s3cret@db.example.com:5432/prod', false],
  ['real user as a query param, default password', 'postgres://db/parley?user=app&password=parley', false],
  ['default user as a query param, real password', 'postgres://db/parley?user=parley&password=s3cret', false],
];

describe('Postgres default-credential warning (default DSN)', () => {
  it.each(DSN_CASES)('%s', async (_label, url, warns) => {
    const warn = spyWarn();
    await new PostgresPlugin().connect(url === undefined ? {} : { url });
    expect(warn).toHaveBeenCalledTimes(warns ? 1 : 0);
  });

  it('names the backend and the key to set', async () => {
    const warn = spyWarn();
    await new PostgresPlugin().connect({});
    const msg = String(warn.mock.calls[0]?.[0]);
    expect(msg).toContain('parley-postgres');
    expect(msg).toContain('url');
  });
});

// The table above is a hand-listed set, and a hand-listed set only ever grades the spellings someone
// thought of. So the same property is also generated: place each (user, password) pair into each
// spelling pg accepts, and drive the expectation off the pair that was PUT IN rather than off the
// parser the implementation uses — otherwise the test agrees with the code by construction.
type Carrier = (user: string, password: string) => string;

const HOST = 'db.internal:6432/parley';
const encodeFirst = (v: string): string =>
  `%${v.charCodeAt(0).toString(16)}${v.slice(1)}`;

const CARRIERS: [name: string, build: Carrier][] = [
  ['userinfo', (u, p) => `postgres://${u}:${p}@${HOST}`],
  ['libpq query params', (u, p) => `postgres://${HOST}?user=${u}&password=${p}`],
  ['userinfo user + query password', (u, p) => `postgres://${u}@${HOST}?password=${p}`],
  ['query user + userinfo password', (u, p) => `postgres://:${p}@${HOST}?user=${u}`],
  ['percent-encoded userinfo', (u, p) => `postgres://${encodeFirst(u)}:${encodeFirst(p)}@${HOST}`],
  ['postgresql:// scheme, query params', (u, p) => `postgresql://${HOST}?user=${u}&password=${p}`],
];

const USERS = [DEFAULT_USER, 'app'];
const PASSWORDS = [DEFAULT_PASSWORD, 'hunter2'];

const GENERATED = CARRIERS.flatMap(([carrier, build]) =>
  USERS.flatMap((user) =>
    PASSWORDS.map((password) => ({
      label: `${carrier}: ${user}/${password}`,
      url: build(user, password),
      warns: user === DEFAULT_USER && password === DEFAULT_PASSWORD,
    })),
  ),
);

describe('every spelling that delivers the published pair warns, and only those', () => {
  it.each(GENERATED.map((c) => [c.label, c] as const))('%s', async (_label, cell) => {
    const warn = spyWarn();
    await new PostgresPlugin().connect({ url: cell.url });
    expect(warn, cell.url).toHaveBeenCalledTimes(cell.warns ? 1 : 0);
  });

  // Pin the carrier list by value as well: a table generated from it cannot notice a spelling
  // being dropped out of it, and dropping the query-param carrier is exactly the miss this covers.
  it('grades every spelling pg honours', () => {
    expect(CARRIERS.map(([name]) => name)).toEqual([
      'userinfo',
      'libpq query params',
      'userinfo user + query password',
      'query user + userinfo password',
      'percent-encoded userinfo',
      'postgresql:// scheme, query params',
    ]);
  });
});

// A DSN can carry no credentials at all and still authenticate as parley/parley: pg falls back to
// PGUSER/PGPASSWORD, so the effective credentials are not always in the string.
const ENV_CASES: [label: string, user: string, password: string, warns: boolean][] = [
  ['PGUSER and PGPASSWORD both default', DEFAULT_USER, DEFAULT_PASSWORD, true],
  ['PGUSER real, PGPASSWORD default', 'app', DEFAULT_PASSWORD, false],
  ['PGUSER default, PGPASSWORD real', DEFAULT_USER, 's3cret', false],
];

describe('credentials taken from the environment are graded too', () => {
  it.each(ENV_CASES)('%s', async (_label, user, password, warns) => {
    vi.stubEnv('PGUSER', user);
    vi.stubEnv('PGPASSWORD', password);
    const warn = spyWarn();
    await new PostgresPlugin().connect({ url: `postgres://${HOST}` });
    expect(warn).toHaveBeenCalledTimes(warns ? 1 : 0);
  });
});
