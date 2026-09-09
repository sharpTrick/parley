import { asTopic } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { validatePrefix } from '../src/config.js';
import { NatsPlugin } from '../src/index.js';
import {
  MAX_STREAM_NAME_BYTES,
  MAX_SUBJECT_BYTES,
  streamNameFor,
  subjectFor,
} from '../src/naming.js';

/**
 * CLASS: a prefix `connect()` accepts that no `post` can then spell. Both names this plugin
 * composes have a hard server ceiling, and a prefix over it is a CONFIGURATION error the operator
 * can act on — while the failure it causes is not: an over-long subject takes the whole PUB line
 * past `max_control_line`, which nats-server answers by closing the connection, so every post dies
 * with a bare TIMEOUT naming neither the subject nor the prefix that composed it.
 */
const TOPIC = asTopic('topic');

const NAMES = [
  {
    field: 'subject_prefix',
    ceiling: MAX_SUBJECT_BYTES,
    compose: subjectFor,
    check: (value: string): void =>
      void validatePrefix('subject_prefix', value, 'parley.', /[*>\s]/, MAX_SUBJECT_BYTES),
  },
  {
    field: 'stream_prefix',
    ceiling: MAX_STREAM_NAME_BYTES,
    compose: streamNameFor,
    check: (value: string): void =>
      void validatePrefix('stream_prefix', value, 'PARLEY_', /[.*>/\\\s]/, MAX_STREAM_NAME_BYTES),
  },
] as const;

describe.each(NAMES)('$field is bounded by what the server will name', ({ field, ceiling, compose, check }) => {
  const prefixOf = (bytes: number): string => 'x'.repeat(bytes - String(TOPIC).length);

  it('accepts a prefix that composes exactly the ceiling', () => {
    const prefix = prefixOf(ceiling);
    expect(() => {
      check(prefix);
    }).not.toThrow();
    expect(Buffer.byteLength(compose(prefix, TOPIC), 'utf8')).toBe(ceiling);
  });

  it('refuses a prefix that composes one byte over it', () => {
    expect(() => {
      check(prefixOf(ceiling + 1));
    }).toThrow(new RegExp(`^invalid ${field} `));
  });

  it('refuses it at connect, before anything is dialled', async () => {
    await expect(
      new NatsPlugin().connect({
        servers: 'nats://127.0.0.1:4222',
        [field]: prefixOf(ceiling + 1),
      }),
    ).rejects.toThrow(new RegExp(`^invalid ${field} `));
  });
});
