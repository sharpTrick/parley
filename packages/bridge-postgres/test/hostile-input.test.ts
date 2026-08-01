import { asBackendMsgId, asHandle, asTopic } from '@sharptrick/parley-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgresPlugin } from '../src/index.js';
import { CORPUS, FIELDS, type Field, REFUSED, ROUND_TRIPS } from './storable-corpus.js';

// `since` is not the only agent-supplied string this plugin hands the driver. `content` arrives as a
// bare `z.string()` from core's `parley_post`, the topic is whatever a `post_topics` pattern admits,
// and the handle comes from the same untrusted side (DESIGN §5). PostgreSQL's TEXT type cannot hold
// a NUL byte, which JSON and JavaScript both consider an ordinary character — so left to the server
// the caller is handed `invalid byte sequence for encoding "UTF8": 0x00`, naming neither this
// plugin, nor the field, nor the fact that nothing was written, and core renders that into agent
// context.
//
// The class is therefore wider than cursors: NO agent-supplied field may render a raw driver or
// SQLSTATE string. So every seam call is crossed with every string argument it takes and with the
// shared storage-hostile corpus.
//
// This file is MOCKED, so it grades only what a fake can decide: whether a call was refused by name
// before any SQL reached the driver. The other half of a ROUND_TRIPS row — that the value comes
// back byte-identical — is a property only the SERVER decides, and grading it here is what let a
// value the driver silently rewrote to U+FFFD pass as "accepted, and reaches the database". That
// half lives in storable-roundtrip.test.ts, against a real server.

const state = vi.hoisted(() => ({ queries: [] as string[] }));

vi.mock('pg', async () => {
  const { FakeEmitter, fakePool, servePool } = await import('./fake-pg.js');

  class MockClient extends FakeEmitter {
    async connect(): Promise<void> {}
    async query(sql = '', values: readonly unknown[] = []): Promise<{ rows: unknown[] }> {
      state.queries.push(sql);
      return { rows: servePool([], sql, values) ?? (/RETURNING/.test(sql) ? [{ seq: '1' }] : []) };
    }
    async end(): Promise<void> {}
    release(): void {}
  }

  return {
    Pool: vi.fn(() =>
      fakePool(
        async (sql, values) => {
          state.queries.push(sql);
          return { rows: servePool([], sql, values) ?? [] };
        },
        () => new MockClient(),
      ),
    ),
    Client: MockClient,
  };
});

const URL = 'postgres://app:s3cret@db.example.com:5432/prod';

/** Every seam call, and the agent-supplied string arguments it puts into SQL. */
const CALLS: [call: string, fields: Field[]][] = [
  ['post', FIELDS],
  ['fetchRecent', ['topic']],
  ['subscribe', ['topic']],
  ['resolveIdentity', ['handle']],
];

function invoke(plugin: PostgresPlugin, call: string, field: Field, value: string): Promise<unknown> {
  const topic = asTopic(field === 'topic' ? value : 'hi-topic');
  const handle = asHandle(field === 'handle' ? value : 'u');
  switch (call) {
    case 'post':
      return plugin.post(
        topic,
        handle,
        field === 'content' ? value : 'hi',
        field === 'inReplyTo' ? { inReplyTo: asBackendMsgId(value) } : undefined,
      );
    case 'fetchRecent':
      return plugin.fetchRecent({ topic });
    case 'subscribe':
      return plugin.subscribe(topic, () => undefined);
    default:
      return plugin.resolveIdentity(handle);
  }
}

const CELLS = CALLS.flatMap(([call, fields]) =>
  fields.flatMap((field) =>
    CORPUS.map(
      ([label, value, arm]) => [`${call}(${field}) with ${label} — ${arm}`, call, field, value, arm] as const,
    ),
  ),
);

beforeEach(() => {
  state.queries = [];
});

describe('no agent-supplied field renders a raw driver string into agent context', () => {
  it('the corpus declares both arms, so neither branch below is unreachable', () => {
    expect([...new Set(CORPUS.map(([, , arm]) => arm))].sort()).toEqual([REFUSED, ROUND_TRIPS].sort());
  });

  it.each(CELLS)('%s', async (_label, call, field, value, arm) => {
    const plugin = new PostgresPlugin();
    await plugin.connect({ url: URL, table_name: 'parley_hi' });
    state.queries = [];
    try {
      let rejection: Error | undefined;
      await invoke(plugin, call, field, value).catch((err: unknown) => {
        rejection = err as Error;
      });

      if (arm === ROUND_TRIPS) {
        expect(rejection?.message, 'a value this backend can store was refused').toBeUndefined();
        expect(state.queries.length, 'an accepted value never reached the database').toBeGreaterThan(
          0,
        );
        return;
      }

      expect(rejection, 'a value this backend cannot store as given was accepted').toBeDefined();
      const message = String(rejection?.message);
      expect(message).toMatch(new RegExp(`^parley-postgres: invalid ${field} — `));
      expect(message, 'the refusal must say nothing was written').toMatch(/[Nn]othing was written/);
      expect(message, 'a driver or SQLSTATE string reached the caller').not.toMatch(
        /invalid byte sequence|invalid input syntax|out of range for type|22P02|SQLSTATE|0x00\b/,
      );
      expect(state.queries, 'a refused value still reached the database').toEqual([]);
    } finally {
      await plugin.disconnect();
    }
  }, 20000);
});
