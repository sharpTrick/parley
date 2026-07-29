import { describe, expect, it, vi } from 'vitest';
import { PostgresPlugin } from '../src/index.js';
import { assertTableName, buildSchema, MAX_TABLE_NAME_BYTES, schemaNames } from '../src/schema.js';

// `table_name` is the one config value this package string-interpolates into DDL, INSERT, SELECT
// and DROP, and it is also the stem every other relation name is derived from. Both halves of that
// — the charset guard and the length budget — are load-bearing and must fail loudly, so this file
// drives them from a corpus rather than the single always-safe name the conformance suite uses.

const poolCtor = vi.hoisted(() => vi.fn());
vi.mock('pg', () => {
  const makeClient = () => ({
    query: vi.fn(async () => ({ rows: [] })),
    release: vi.fn(),
    on: vi.fn(),
    connect: vi.fn(async () => undefined),
    end: vi.fn(async () => undefined),
  });
  return {
    Pool: vi.fn((...args: unknown[]) => {
      poolCtor(...args);
      return {
        on: vi.fn(),
        connect: vi.fn(async () => makeClient()),
        query: vi.fn(async () => ({ rows: [] })),
        end: vi.fn(async () => undefined),
      };
    }),
    Client: vi.fn(() => makeClient()),
  };
});

const PG_IDENTIFIER_BYTES = 63;

const ACCEPTED = [
  ['plain', 'parley_messages'],
  ['leading underscore', '_msgs'],
  ['digits after the first char', 'm1_2'],
  ['single char', 'm'],
  ['exactly the byte budget', 'a'.repeat(MAX_TABLE_NAME_BYTES)],
  // Reserved words are accepted because every interpolation quotes the identifier. Before that,
  // they slipped past the guard and surfaced as a bare PostgreSQL parse error naming neither
  // Parley nor the config key.
  ['reserved word user', 'user'],
  ['reserved word order', 'order'],
  ['reserved word table', 'table'],
  ['reserved word select', 'select'],
  ['reserved word group', 'group'],
] as const;

const REJECTED = [
  ['empty', ''],
  ['leading digit', '1abc'],
  ['hyphen', 'a-b'],
  ['statement terminator', 'x; DROP TABLE parley_messages; --'],
  ['inline comment', 'x--'],
  ['block comment', 'x/*'],
  ['embedded quotes', '"x"'],
  ['whitespace', 'x y'],
  ['newline', 'x\nDROP TABLE t'],
  ['backtick', 'x`y'],
  ['shell substitution', 'x$(id)'],
  ['non-ascii letters', 'ä'.repeat(40)],
  ['fullwidth homoglyph', 'ｍｓｇｓ'],
  ['one byte over the budget', 'a'.repeat(MAX_TABLE_NAME_BYTES + 1)],
  ['truncates a derived name onto another', 'a'.repeat(62)],
  ['at the raw identifier limit', 'a'.repeat(PG_IDENTIFIER_BYTES)],
  ['absurdly long', 'a'.repeat(200)],
] as const;

describe('assertTableName', () => {
  it.each(ACCEPTED)('accepts %s', (_label, name) => {
    expect(assertTableName(name)).toBe(name);
    expect(() => buildSchema(name)).not.toThrow();
  });

  // The rejection contract is stated once, in validateBackendConfig's JSDoc, and an operator
  // reading a message that names neither the plugin nor the key has no idea which knob to fix.
  // It only holds if EVERY path a table_name can be rejected on formats it the same way.
  const CONTRACT = /^parley-postgres: invalid backend_config\.table_name — /;

  it.each(REJECTED)('rejects %s, naming the plugin and the key', (_label, name) => {
    expect(() => assertTableName(name)).toThrow(CONTRACT);
    expect(() => buildSchema(name)).toThrow(CONTRACT);
  });

  it('lower-cases the accepted name, so the quoted relation is the one an unquoted spelling would have made', () => {
    expect(assertTableName('MixedCase')).toBe('mixedcase');
    expect(schemaNames('MixedCase').senders).toBe('mixedcase_senders');
    expect(buildSchema('MixedCase')).toContain('"mixedcase"');
  });

  it('quotes every relation it interpolates, so a reserved word is a table name and not a parse error', () => {
    const ddl = buildSchema('user');
    expect(ddl).toContain('"user"');
    expect(ddl).not.toMatch(/(FROM|TABLE|ON|EXISTS) user\b/);
  });

  // The stem is only half the story: every relation the schema derives from it must ALSO survive
  // PostgreSQL's identifier limit, or two derived names truncate onto one relation and connect()
  // reports success on a schema it never created.
  it('every derived relation of every accepted length fits the identifier limit and stays distinct', () => {
    for (let len = 1; len <= MAX_TABLE_NAME_BYTES; len++) {
      const name = `t${'a'.repeat(len - 1)}`;
      const derived = Object.values(schemaNames(name));
      for (const rel of derived) {
        expect(
          Buffer.byteLength(rel, 'utf8'),
          `${rel} (from table_name of ${len} bytes)`,
        ).toBeLessThanOrEqual(PG_IDENTIFIER_BYTES);
      }
      expect(new Set(derived).size, `derived names collide for ${name}`).toBe(derived.length);
    }
  });

  it('names every derived suffix in the length error, so the operator can see the budget', () => {
    expect(() => assertTableName('a'.repeat(MAX_TABLE_NAME_BYTES + 1))).toThrow(
      new RegExp(String(MAX_TABLE_NAME_BYTES)),
    );
  });
});

describe('connect() rejects a bad table_name before it touches the database', () => {
  it.each(REJECTED)('%s never reaches a connection', async (_label, name) => {
    poolCtor.mockClear();
    await expect(
      new PostgresPlugin().connect({ url: 'postgres://app:s3cret@db.example.com:5432/prod', table_name: name }),
    ).rejects.toThrow(/^parley-postgres: invalid backend_config\.table_name — /);
    expect(poolCtor).not.toHaveBeenCalled();
  });
});
