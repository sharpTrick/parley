import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { Allowlist } from '../allowlist.js';
import { decodePresence, DEFAULT_PRESENCE_TOPIC, type PresenceKind } from '../engine/presence.js';
import { SeenSet } from '../engine/seen-set.js';
import { asHandle, asTopic, type Handle, type Topic } from '../message.js';
import {
  FAILURE_SHAPE_NAMES,
  FAILURE_SHAPES,
  unhandledDuring,
  type FailureShape,
} from '../testing/failure-shapes.js';
import { FakePlugin } from '../testing/fake-plugin.js';
import { startPresenceLoop } from './presence-loop.js';
import { startPushLoop } from './push-loop.js';

/**
 * Core fires several seam calls and deliberately does NOT await them — the presence beats and the
 * live-push emit. Every one of them must absorb the failure whatever SHAPE it arrives in, because
 * an escaped rejection from a fire-and-forget call has no handler anywhere and Node terminates the
 * process: a best-effort beat killing the bridge it exists to advertise.
 *
 * Table the shapes against every fire-and-forget call site and assert on captured
 * `unhandledRejection` events, not on "the call returned" — a site that lets one escape returns
 * perfectly well and takes the process down a tick later.
 */
const PRESENCE_TOPIC = asTopic(DEFAULT_PRESENCE_TOPIC);

/** A plugin whose presence `post` fails — in the given shape — for ONE beat kind only. */
function pluginFailingOn(kind: PresenceKind, shape: FailureShape): FakePlugin {
  const p = new FakePlugin();
  const orig = p.post.bind(p);
  p.post = ((topic: Topic, identity: Handle, content: string) => {
    const real = orig(topic, identity, content);
    if (topic === PRESENCE_TOPIC && decodePresence(content)?.kind === kind) {
      return FAILURE_SHAPES[shape](real);
    }
    return real;
  }) as FakePlugin['post'];
  return p;
}

describe('no fire-and-forget seam call escapes as an unhandled rejection', () => {
  describe.each(['hello', 'heartbeat', 'goodbye'] as PresenceKind[])('presence %s', (kind) => {
    it.each(FAILURE_SHAPE_NAMES)('whose post %s', async (shape) => {
      const failing = pluginFailingOn(kind, shape);
      await failing.connect({});
      const attempts: PresenceKind[] = [];
      const posted = failing.post.bind(failing);
      failing.post = ((topic: Topic, identity: Handle, content: string) => {
        const decoded = topic === PRESENCE_TOPIC ? decodePresence(content) : null;
        if (decoded !== null) attempts.push(decoded.kind);
        return posted(topic, identity, content);
      }) as FakePlugin['post'];

      const escaped = await unhandledDuring(async () => {
        const loop = startPresenceLoop(failing, asHandle('agent'), new Allowlist(['ctx']), {
          presenceTopic: PRESENCE_TOPIC,
          heartbeatMs: 10,
          goodbyeTimeoutMs: 50,
        });
        await new Promise((r) => setTimeout(r, 80));
        await loop.stop();
      });

      expect(escaped).toEqual([]);
      // The failing site was actually exercised — without this the row proves nothing.
      expect(attempts).toContain(kind);
      await failing.disconnect();
    });
  });

  describe.each(FAILURE_SHAPE_NAMES)('push emit whose channel notification %s', (shape) => {
    it('is absorbed by the emit path', async () => {
      const plugin = new FakePlugin();
      await plugin.connect({});
      let notifications = 0;
      const server = {
        server: {
          notification: (): Promise<void> => {
            notifications++;
            return FAILURE_SHAPES[shape](Promise.resolve());
          },
        },
      } as unknown as McpServer;

      const escaped = await unhandledDuring(async () => {
        await startPushLoop(server, plugin, new Allowlist(['ctx']), new SeenSet(), {
          mentionFilter: false,
          identity: asHandle('agent'),
        });
        await plugin.post(asTopic('ctx'), asHandle('bob'), 'hi');
        await vi.waitFor(() => expect(notifications).toBeGreaterThan(0));
      });

      expect(escaped).toEqual([]);
      await plugin.disconnect();
    });
  });
});

/**
 * The harness itself has to be able to produce the input it advertises. A synchronous throw
 * re-wrapped in an `async` function silently degrades to an ordinary rejection, which is how a
 * sync-throw row can sit in a table for rounds while never once exercising the class it names.
 */
describe('the failure-shape fixtures are what they claim', () => {
  const SYNC: FailureShape[] = ['rejects synchronously', 'throws a non-Error synchronously'];
  const ASYNC: FailureShape[] = ['rejects', 'rejects with a non-Error'];

  it.each(SYNC)('%s really throws before returning a promise', (shape) => {
    expect(() => FAILURE_SHAPES[shape](Promise.resolve())).toThrow();
  });

  it.each(ASYNC)('%s returns a promise rather than throwing', async (shape) => {
    let pending: Promise<unknown> | undefined;
    expect(() => {
      pending = FAILURE_SHAPES[shape](Promise.resolve());
    }).not.toThrow();
    await expect(pending).rejects.toBeDefined();
  });

  it.each(SYNC)('a plugin carrying "%s" throws synchronously from post()', async (shape) => {
    const plugin = pluginFailingOn('hello', shape);
    await plugin.connect({});
    const hello = JSON.stringify({
      v: 2,
      kind: 'hello',
      at: 0,
      topics: ['ctx'],
      postTopics: [],
      instanceId: 'i',
    });
    expect(() => plugin.post(PRESENCE_TOPIC, asHandle('agent'), hello)).toThrow();
    await plugin.disconnect();
  });
});
