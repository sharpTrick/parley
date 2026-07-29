import { afterEach, describe, expect, it, vi } from 'vitest';
import { PostgresPlugin } from '../src/index.js';

// SEC-06 — Postgres must not silently connect with the repo-public default DSN
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
});

const spyWarn = () => vi.spyOn(console, 'warn').mockImplementation(() => undefined);

// The warning must key on the CREDENTIALS, not on a literal DSN string: the README tells the
// operator to provision exactly parley/parley, so every host, port, database and URL spelling that
// carries that pair is the same published password and must warn.
const DSN_CASES: [label: string, url: string | undefined, warns: boolean][] = [
  ['url omitted (falls back to the default)', undefined, true],
  ['the exact default DSN', 'postgres://parley:parley@127.0.0.1:5432/parley', true],
  ['default creds via localhost', 'postgres://parley:parley@localhost:5432/parley', true],
  ['default creds via a docker-network host', 'postgres://parley:parley@db/parley', true],
  ['default creds, port omitted', 'postgres://parley:parley@127.0.0.1/parley', true],
  ['default creds, different database', 'postgres://parley:parley@127.0.0.1:5432/other', true],
  ['default creds, postgresql:// scheme', 'postgresql://parley:parley@db.internal:6432/app', true],
  ['default user, real password', 'postgres://parley:hunter2@127.0.0.1:5432/parley', false],
  ['real user, default password', 'postgres://app:parley@127.0.0.1:5432/parley', false],
  ['a real DSN', 'postgres://app:s3cret@db.example.com:5432/prod', false],
];

describe('Postgres default-credential warning (SEC-06)', () => {
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
