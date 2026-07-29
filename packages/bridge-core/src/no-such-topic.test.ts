import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { isNoSuchTopicError } from './no-such-topic.js';
import { NoSuchTopicError } from './seam.js';

/** A second install of parley-core resolved alongside this one: same contract, different class. */
class DuplicateInstall extends Error {
  constructor(readonly topic: string) {
    super(`no such topic: ${JSON.stringify(topic)}`);
    this.name = 'NoSuchTopicError';
  }
}

const CROSS_REALM: unknown = runInNewContext(
  `class NoSuchTopicError extends Error {
     constructor(topic) {
       super('no such topic: ' + JSON.stringify(topic));
       this.name = 'NoSuchTopicError';
       this.topic = topic;
     }
   }
   new NoSuchTopicError('ctx')`,
);

describe('isNoSuchTopicError', () => {
  it('the foreign twins really are foreign (otherwise the rows below prove nothing)', () => {
    expect(new DuplicateInstall('ctx') instanceof NoSuchTopicError).toBe(false);
    expect(CROSS_REALM instanceof NoSuchTopicError).toBe(false);
    expect(CROSS_REALM instanceof Error).toBe(false);
  });

  it.each([
    ['the native class', new NoSuchTopicError('ctx')],
    ['a duplicate install of the same package', new DuplicateInstall('ctx')],
    ['an instance from another realm', CROSS_REALM],
    ['a bare object carrying the marker', { name: 'NoSuchTopicError' }],
  ])('recognises %s', (_label, err) => {
    expect(isNoSuchTopicError(err)).toBe(true);
  });

  it.each([
    ['a plain Error', new Error('boom')],
    ['a TypeError', new TypeError('boom')],
    ['a different seam error', Object.assign(new Error('x'), { name: 'TopicNotAllowedError' })],
    ['an error whose MESSAGE mentions it', new Error('threw NoSuchTopicError earlier')],
    ['the name as a string', 'NoSuchTopicError'],
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['an unmarked object', {}],
  ])('does not recognise %s', (_label, err) => {
    expect(isNoSuchTopicError(err)).toBe(false);
  });
});
