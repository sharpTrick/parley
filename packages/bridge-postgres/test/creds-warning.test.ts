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

describe('Postgres default-credential warning (SEC-06)', () => {
  it('warns once, naming the backend and the key to set, when url is omitted', async () => {
    const warn = spyWarn();
    await new PostgresPlugin().connect({});
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0]?.[0]);
    expect(msg).toContain('parley-postgres');
    expect(msg).toContain('url');
  });

  it('warns when url is set literally to the well-known default DSN', async () => {
    const warn = spyWarn();
    await new PostgresPlugin().connect({ url: 'postgres://parley:parley@127.0.0.1:5432/parley' });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does NOT warn when a real DSN is supplied', async () => {
    const warn = spyWarn();
    await new PostgresPlugin().connect({ url: 'postgres://app:s3cret@db.example.com:5432/prod' });
    expect(warn).not.toHaveBeenCalled();
  });
});
