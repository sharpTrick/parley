import { asTopic, type BackendPlugin, type Topic } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import {
  assertConformanceContext,
  type BackendFactory,
  CONTEXT_FIELDS,
  type ConformanceContext,
  openContext,
} from '@sharptrick/parley-conformance';

function reference(): ConformanceContext {
  return {
    plugin: {} as BackendPlugin,
    freshTopic: (): Topic => asTopic('t'),
    cleanup: async () => undefined,
    concurrentPost: async () => undefined,
    supportsBlockingFetch: false,
    carriesSenderIdentity: false,
    absentTopicBehaviour: 'empty-page',
  };
}

/**
 * A field is optional exactly when its validator accepts `undefined`. Derived rather than listed,
 * so that making another field optional — the trade the "every field is required" doctrine exists
 * to prevent — cannot pass unnoticed.
 */
const optionalFields = (): string[] =>
  Object.entries(CONTEXT_FIELDS)
    .filter(([, ok]) => ok(undefined))
    .map(([field]) => field);

describe('assertConformanceContext', () => {
  it('accepts a complete context', () => {
    expect(() => assertConformanceContext('ref', reference())).not.toThrow();
  });

  it('accepts the documented `unsupported` sentinel for concurrentPost', () => {
    expect(() =>
      assertConformanceContext('ref', { ...reference(), concurrentPost: 'unsupported' }),
    ).not.toThrow();
  });

  // Generated from the reference context, so a field added to ConformanceContext later is covered
  // the moment it appears there — the guard cannot quietly stop covering the whole type.
  it.each(Object.keys(reference()))('rejects a context missing `%s` unless it is optional', (field) => {
    const ctx: Record<string, unknown> = { ...reference() };
    delete ctx[field];
    if (optionalFields().includes(field)) {
      expect(() => assertConformanceContext('ref', ctx)).not.toThrow();
      return;
    }
    expect(() => assertConformanceContext('ref', ctx)).toThrow(
      new RegExp(`ref has an invalid \`${field}\``),
    );
  });

  // The doctrine this validator enforces is "every field is required"; the one exception defaults to
  // the STRICTER contract, so it cannot buy a weaker grade. Any other optional field could.
  it('has exactly one optional field, the one whose default is the stricter arm', () => {
    expect(optionalFields()).toEqual(['absentTopicBehaviour']);
  });

  it.each([
    ['absentTopicBehaviour', 'maybe'],
    ['absentTopicBehaviour', null],
    ['absentTopicBehaviour', true],
    ['carriesSenderIdentity', 'true'],
    ['supportsBlockingFetch', 1],
    ['concurrentPost', 'unsuported'],
    ['concurrentPost', true],
    ['freshTopic', 't-1'],
    ['cleanup', null],
    ['plugin', null],
  ])('rejects a wrongly-typed `%s`', (field, value) => {
    expect(() => assertConformanceContext('ref', { ...reference(), [field]: value })).toThrow(
      new RegExp(`ref has an invalid \`${field}\``),
    );
  });

  it.each([undefined, null, 'ctx', 42])('rejects a non-object context (%s)', (bad) => {
    expect(() => assertConformanceContext('ref', bad)).toThrow(/is not an object/);
  });

  it('names the backend so a failure points at the fixture that is wrong', () => {
    expect(() => assertConformanceContext('my-backend', {})).toThrow(/my-backend/);
  });

  it('checks every field of the reference context', () => {
    expect(Object.keys(CONTEXT_FIELDS).sort()).toEqual(Object.keys(reference()).sort());
  });
});

/**
 * Teardown must run whatever setup ran. A factory CONNECTS before it returns, so every way a
 * fixture can be wrong lands after a live plugin exists — and the validator used to throw from
 * inside `beforeEach` with the context never assigned, leaving `afterEach` to dereference
 * `undefined` and the connection to survive the case. Thirty-two cases, thirty-two live sockets and
 * poll loops on Matrix or Postgres, which is a hung run rather than a clean red.
 *
 * A row per WAY a factory can be wrong, so the next one is covered by the shape of the table.
 */
describe('a fixture is disconnected however it turns out to be wrong', () => {
  const failing = (
    build: (record: () => void) => unknown,
  ): { factory: BackendFactory; disconnects: () => number } => {
    let disconnects = 0;
    return {
      factory: (() => Promise.resolve(build(() => disconnects++))) as BackendFactory,
      disconnects: () => disconnects,
    };
  };

  const WRONG: [string, (record: () => void) => unknown, RegExp, boolean][] = [
    [
      'an invalid capability flag',
      (record) => ({ ...reference(), supportsBlockingFetch: undefined, cleanup: async () => record() }),
      /invalid `supportsBlockingFetch`/,
      true,
    ],
    [
      'a missing capability flag',
      (record) => {
        const ctx: Record<string, unknown> = { ...reference(), cleanup: async () => record() };
        delete ctx.concurrentPost;
        return ctx;
      },
      /invalid `concurrentPost`/,
      true,
    ],
    [
      'a plugin that is not an object',
      (record) => ({ ...reference(), plugin: 'a plugin', cleanup: async () => record() }),
      /invalid `plugin`/,
      true,
    ],
    ['a factory that returns a non-object', () => 'not a context', /is not an object/, false],
    ['a factory that returns null', () => null, /is not an object/, false],
    [
      // The teardown itself failing must not mask the fixture problem that caused it to run.
      'a cleanup that rejects on a fixture that is already invalid',
      (record) => ({
        ...reference(),
        carriesSenderIdentity: 'yes',
        cleanup: async () => {
          record();
          throw new Error('teardown exploded');
        },
      }),
      /invalid `carriesSenderIdentity`/,
      true,
    ],
  ];

  it.each(WRONG)('disconnects after %s', async (_label, build, names, disconnects) => {
    const { factory, disconnects: count } = failing(build);
    const err: unknown = await openContext('my-backend', factory).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(names);
    expect((err as Error).message).not.toMatch(/Cannot read properties of undefined/);
    expect((err as Error).message).toContain('my-backend');
    expect(count(), 'the fixture was left connected').toBe(disconnects ? 1 : 0);
  });

  it('hands a well-formed fixture straight back, connected', async () => {
    const ctx = await openContext('ref', (() => Promise.resolve(reference())) as BackendFactory);
    expect(ctx.supportsBlockingFetch).toBe(false);
  });

  it('lets a rejecting factory reject, without inventing a teardown for a fixture that never was', async () => {
    const boom = new Error('the server never came up');
    await expect(
      openContext('ref', (() => Promise.reject(boom)) as BackendFactory),
    ).rejects.toBe(boom);
  });
});
