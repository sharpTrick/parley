import { describe, expect, it } from 'vitest';
import { asBackendMsgId, asCursor, asHandle, asTopic, type Message } from './message.js';
import { safeDeliver } from './safe-deliver.js';
import type { MessageHandler } from './seam.js';

const MESSAGE: Message = {
  topic: asTopic('room'),
  backendMsgId: asBackendMsgId('m1'),
  cursor: asCursor('1'),
  senderHandle: asHandle('someone'),
  mentions: [],
  content: 'hello',
  timestamp: new Date(0).toISOString(),
};

/** Run `body`, failing if anything it starts reaches Node as an unhandled rejection. */
async function withoutUnhandledRejections(body: () => void): Promise<void> {
  const escaped: unknown[] = [];
  const onEscape = (reason: unknown): void => void escaped.push(reason);
  process.on('unhandledRejection', onEscape);
  try {
    body();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  } finally {
    process.off('unhandledRejection', onEscape);
  }
  expect(escaped).toEqual([]);
}

describe('safeDeliver — the live path survives a hostile handler', () => {
  it('delivers the message to the handler', () => {
    const seen: Message[] = [];
    safeDeliver((m) => void seen.push(m), () => MESSAGE);
    expect(seen).toEqual([MESSAGE]);
  });

  it('absorbs a handler that throws synchronously', () => {
    const thrower: MessageHandler = () => {
      throw new Error('handler blew up');
    };
    expect(() => safeDeliver(thrower, () => MESSAGE)).not.toThrow();
  });

  it('absorbs a handler that rejects, so no unhandled rejection reaches Node', async () => {
    const rejector = (() => Promise.reject(new Error('handler blew up'))) as MessageHandler;
    await withoutUnhandledRejections(() => safeDeliver(rejector, () => MESSAGE));
  });

  it('absorbs a handler that throws before it ever returns a promise', async () => {
    const asyncThrower = (async () => {
      throw new Error('handler blew up');
    }) as MessageHandler;
    await withoutUnhandledRejections(() => safeDeliver(asyncThrower, () => MESSAGE));
  });

  it('contains a message the plugin could not build, so the caller cannot escape the guard', () => {
    const seen: Message[] = [];
    const handler: MessageHandler = (m) => void seen.push(m);
    expect(() =>
      safeDeliver(handler, () => {
        throw new TypeError('content.replace is not a function');
      }),
    ).not.toThrow();
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
