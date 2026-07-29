import { asTopic, type BackendPlugin, type Topic } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import {
  assertConformanceContext,
  CONTEXT_FIELDS,
  type ConformanceContext,
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
