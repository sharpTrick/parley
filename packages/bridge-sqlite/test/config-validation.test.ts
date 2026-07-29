import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asHandle, asTopic, type BackendConfig } from '@sharptrick/parley-core';
import { afterEach, describe, expect, it } from 'vitest';
import { SqlitePlugin } from '../src/index.js';

/**
 * `backend_config` is untyped YAML from an operator. Every knob is validated before the database
 * is opened, so a bad value fails fast with a message naming the key — and, above all, can never
 * take an irreversible action (`retention_days: 0` used to mean "delete the entire history").
 */

const T = asTopic('ctx');
const me = asHandle('alice');
const dbFile = () => join(mkdtempSync(join(tmpdir(), 'parley-cfg-')), 'p.db');

let open: SqlitePlugin[] = [];
afterEach(async () => {
  await Promise.all(open.map((p) => p.disconnect()));
  open = [];
});

const BAD_VALUES: unknown[] = [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, '', 'abc', null, [], {}, 1e308];

/** Values each key must accept, so the rejection table cannot degenerate into "reject everything". */
const GOOD_VALUES: Record<string, unknown[]> = {
  db_path: ['x.db'],
  poll_interval_ms: [10, 1000],
  retention_days: [0.5, 1, 3650],
};

/** Bad values that are legitimate for a given key and therefore exempt from the rejection table. */
const EXEMPT: Record<string, unknown[]> = {
  db_path: ['abc'],
  poll_interval_ms: [],
  retention_days: [0.5, 1e308],
};

describe('connect() rejects every bad backend_config value', () => {
  for (const key of Object.keys(GOOD_VALUES)) {
    for (const value of BAD_VALUES) {
      if (EXEMPT[key]?.includes(value)) continue;
      it(`${key} = ${JSON.stringify(value) ?? String(value)}`, async () => {
        const p = new SqlitePlugin();
        const cfg = { db_path: dbFile(), [key]: value } as unknown as BackendConfig;
        await expect(p.connect(cfg)).rejects.toThrow(
          new RegExp(`parley-sqlite:.*${key}`),
        );
      });
    }

    for (const value of GOOD_VALUES[key] ?? []) {
      it(`${key} = ${JSON.stringify(value)} is accepted`, async () => {
        const p = new SqlitePlugin();
        open.push(p);
        const cfg = { db_path: dbFile(), [key]: value } as unknown as BackendConfig;
        await expect(p.connect(cfg)).resolves.toBeUndefined();
      });
    }
  }

  it('a mistyped key is rejected rather than silently ignored', async () => {
    const p = new SqlitePlugin();
    await expect(
      p.connect({ db_path: dbFile(), retention_day: 30 } as unknown as BackendConfig),
    ).rejects.toThrow(/parley-sqlite: unknown backend_config key 'retention_day'/);
  });

  it('a rejected config deletes nothing', async () => {
    const path = dbFile();
    const writer = new SqlitePlugin();
    await writer.connect({ db_path: path, poll_interval_ms: 20 });
    await writer.post(T, me, 'precious');
    await writer.disconnect();

    for (const value of [0, -1, 'abc']) {
      const p = new SqlitePlugin();
      await expect(
        p.connect({ db_path: path, retention_days: value } as unknown as BackendConfig),
      ).rejects.toThrow(/retention_days/);
    }

    const reader = new SqlitePlugin();
    open.push(reader);
    await reader.connect({ db_path: path, poll_interval_ms: 20 });
    const { messages } = await reader.fetchRecent({ topic: T });
    expect(messages.map((m) => m.content)).toEqual(['precious']);
  });
});
