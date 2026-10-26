import { describe, expect, it } from 'vitest';
import { asBackendMsgId, asCursor, asHandle, asTopic, type Message } from './message.js';
import { safeDeliver } from './safe-deliver.js';
import type { MessageHandler } from './seam.js';
import {
  FAILURE_SHAPE_NAMES,
  FAILURE_SHAPES,
  unhandledDuring,
} from './testing/failure-shapes.js';

const MESSAGE: Message = {
  topic: asTopic('room'),
  backendMsgId: asBackendMsgId('m1'),
  cursor: asCursor('1'),
  senderHandle: asHandle('someone'),
  mentions: [],
  content: 'hello',
  timestamp: new Date(0).toISOString(),
};

describe('safeDeliver — the live path survives a hostile handler', () => {
  it('delivers the message to the handler', () => {
    const seen: Message[] = [];
    safeDeliver((m) => void seen.push(m), () => MESSAGE);
    expect(seen).toEqual([MESSAGE]);
  });

  /**
   * Driven from the SHARED table rather than a local list, so that a shape added for one
   * fire-and-forget site is graded at every one of them. The local harness this replaced listened
   * for `unhandledRejection` alone, which reads a synchronous throw out of an event handler — an
   * `uncaughtException` — as clean; {@link unhandledDuring} listens for both.
   */
  it.each(FAILURE_SHAPE_NAMES)('absorbs a handler that %s', async (shape) => {
    const handler = ((): unknown => FAILURE_SHAPES[shape](Promise.resolve())) as MessageHandler;
    const escaped = await unhandledDuring(async () => {
      expect(() => safeDeliver(handler, () => MESSAGE)).not.toThrow();
      return Promise.resolve();
    });
    expect(escaped.map(String)).toEqual([]);
  });

  it('contains a message the plugin could not build, so the caller cannot escape the guard', async () => {
    const seen: Message[] = [];
    const handler: MessageHandler = (m) => void seen.push(m);
    const escaped = await unhandledDuring(async () => {
      expect(() =>
        safeDeliver(handler, () => {
          throw new TypeError('content.replace is not a function');
        }),
      ).not.toThrow();
      return Promise.resolve();
    });
    expect(escaped.map(String)).toEqual([]);
    expect(seen).toEqual([]);
  });

  it('does not await the handler, so one that never settles cannot park the next message', () => {
    const order: string[] = [];
    const stalls = (() => {
      order.push('handler');
      return new Promise(() => undefined);
    }) as MessageHandler;
    safeDeliver(stalls, () => MESSAGE);
    order.push('after');
    expect(order).toEqual(['handler', 'after']);
  });
});
