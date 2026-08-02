import { asTopic, type Message, type MessageHandler, type Topic } from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscordPlugin } from '../src/index.js';
import { FAKE_TOKEN, startFakeDiscord, type FakeDiscord } from './fake-discord.js';

/**
 * CLASS: a subscribe handler's FAILURE, in every shape the seam's `(msg: Message) => void` admits.
 *
 * That return type does not forbid an `async` handler, and core is free to pass one, so a `try {
 * handler(m) } catch {}` around the call sees a synchronous throw and NOTHING else: a rejected
 * promise walks straight past it and, under Node's default `--unhandled-rejections=throw`, ends the
 * bridge process — the whole MCP server killed by whatever the agent-side handler did with one
 * message. So the axis is the failure SHAPE, not whether the plugin happens to call the handler
 * synchronously today.
 *
 * `never settles` is the other half, and the reason the rejection arm must not be awaited: awaiting
 * would park delivery behind a handler that never resolves, trading a crash for a silent stall.
 * Every row asserts the same three things — the later messages still arrive, still in ascending
 * order, and nothing reached the process.
 */
const FAILING_HANDLERS: Array<{ name: string; make: (seen: string[]) => MessageHandler }> = [
  {
    name: 'throws on the first message only',
    make: (seen) => {
      let first = true;
      return (m) => {
        seen.push(m.content);
        if (!first) return;
        first = false;
        throw new Error('handler exploded');
      };
    },
  },
  {
    name: 'throws on every message',
    make: (seen) => (m) => {
      seen.push(m.content);
      throw new Error('handler exploded');
    },
  },
  {
    name: 'throws a non-Error',
    make: (seen) => (m) => {
      seen.push(m.content);
      throw 'handler exploded';
    },
  },
  {
    name: 'rejects on the first message only',
    make: (seen) => {
      let first = true;
      const handler = async (m: Message): Promise<void> => {
        seen.push(m.content);
        if (!first) return;
        first = false;
        throw new Error('handler rejected');
      };
      return handler;
    },
  },
  {
    name: 'rejects on every message',
    make: (seen) => {
      const handler = async (m: Message): Promise<void> => {
        seen.push(m.content);
        throw new Error('handler rejected');
      };
      return handler;
    },
  },
  {
    name: 'rejects with a non-Error',
    make: (seen) => {
      const handler = async (m: Message): Promise<void> => {
        seen.push(m.content);
        throw 'handler rejected';
      };
      return handler;
    },
  },
  {
    name: 'rejects a turn after it returned',
    make: (seen) => {
      const handler = async (m: Message): Promise<void> => {
        seen.push(m.content);
        await new Promise((r) => setTimeout(r, 5));
        throw new Error('handler rejected late');
      };
      return handler;
    },
  },
  {
    name: 'never settles',
    make: (seen) => {
      const handler = (m: Message): Promise<void> => {
        seen.push(m.content);
        return new Promise<void>(() => undefined);
      };
      return handler;
    },
  },
];

/**
 * Both ways a handler's failure reaches the process. Keep BOTH listeners, so that a fix which only
 * absorbs the synchronous half still loses every rejection row: an escaped rejection arrives as
 * `unhandledRejection`, never as `uncaughtException`.
 */
function watchForCrashes(): { crashes: unknown[]; stop: () => void } {
  const crashes: unknown[] = [];
  const record = (err: unknown): void => {
    crashes.push(err);
  };
  process.on('uncaughtException', record);
  process.on('unhandledRejection', record);
  return {
    crashes,
    stop: () => {
      process.off('uncaughtException', record);
      process.off('unhandledRejection', record);
    },
  };
}

const FAILING_PUSHES = 5;

let seq = 0;
const freshChannelId = (): string =>
  String(600_000 + ++seq) + String(Math.floor(Math.random() * 900) + 100);

describe("a subscribe handler's failure never leaves the handler", () => {
  let fake: FakeDiscord;
  let plugin: DiscordPlugin;

  const liveTopic = (): Topic => {
    const id = freshChannelId();
    fake.createChannel(id);
    return asTopic(id);
  };

  beforeEach(async () => {
    fake = await startFakeDiscord();
    plugin = new DiscordPlugin();
    await plugin.connect({
      token: FAKE_TOKEN,
      api_url: fake.apiUrl,
      gateway_url: fake.gatewayUrl,
    });
  });
  afterEach(async () => {
    await plugin.disconnect();
    await fake.close();
  });

  for (const behaviour of FAILING_HANDLERS) {
    it(`a handler that ${behaviour.name}: later messages still arrive in order, nothing escapes`, async () => {
      const topic = liveTopic();
      const seen: string[] = [];
      const watch = watchForCrashes();
      try {
        await plugin.subscribe(topic, behaviour.make(seen));

        const texts = Array.from({ length: FAILING_PUSHES }, (_u, i) => `m${i}`);
        for (const text of texts) fake.deliver(topic as string, { content: text });

        await vi.waitFor(() => expect(seen).toEqual(texts), { timeout: 5000, interval: 10 });

        // An escaped rejection is reported a turn of the loop later than the throw that caused it.
        await new Promise((r) => setTimeout(r, 150));
        expect(
          watch.crashes.map(String),
          "the handler's failure reached the process",
        ).toEqual([]);

        const { messages } = await plugin.fetchRecent({ topic, limit: 10 });
        expect(
          messages.map((m) => m.content),
          'catch-up stopped answering for a topic whose handler failed',
        ).toEqual(texts);
      } finally {
        watch.stop();
      }
    });
  }

  it('a handler that fails does not stop a LATER subscriber on another topic', async () => {
    const broken = liveTopic();
    const healthy = liveTopic();
    const watch = watchForCrashes();
    try {
      const rejecting = async (_m: Message): Promise<void> => {
        throw new Error('handler rejected');
      };
      await plugin.subscribe(broken, rejecting);
      const seen: string[] = [];
      await plugin.subscribe(healthy, (m) => seen.push(m.content));

      fake.deliver(broken as string, { content: 'boom' });
      fake.deliver(healthy as string, { content: 'still here' });

      await vi.waitFor(() => expect(seen).toEqual(['still here']), { timeout: 5000, interval: 10 });
      await new Promise((r) => setTimeout(r, 150));
      expect(watch.crashes.map(String)).toEqual([]);
    } finally {
      watch.stop();
    }
  });
});
