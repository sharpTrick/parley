/**
 * CLASS: a `backend_config` key that reaches the WIRE is graded for effect, not only for validation.
 * `stream` decides which Zulip stream carries all Parley traffic and is put on the wire in three
 * separate places — `post`'s `to`, the read narrow, and the event-queue registration narrow — so a
 * plugin that honoured the configured value in some of them and defaulted in the rest would be a
 * bridge that writes where nobody reads, or a subscribe loop registered on a stream nothing is ever
 * written to, silently receiving nothing forever.
 *
 * Both streams below are deliberately NON-default, so a wire site pinned to the built-in `parley`
 * fails here rather than passing on the fixture's defaults agreeing with it, and every row grades
 * isolation in BOTH directions: what the configured stream must see, and what it must not.
 */
import { asTopic, type Topic } from '@sharptrick/parley-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZulipPlugin } from '../src/index.js';
import type { FakeZulip } from './fake-zulip.js';
import { rand, SENDER, sleep, useZulip, type ZulipPair } from './harness.js';

const boot = useZulip();

const CONFIGURED_STREAM = 'alpha-stream';
const OTHER_STREAM = 'beta-stream';

/** Plugins opened onto an already-running fake, so one server carries both stream configurations. */
let extra: ZulipPlugin[] = [];

afterEach(async () => {
  for (const plugin of extra) await plugin.disconnect().catch(() => undefined);
  extra = [];
});

async function openOn(fake: FakeZulip, stream: string): Promise<ZulipPlugin> {
  const plugin = new ZulipPlugin();
  await plugin.connect({ site_url: fake.url, events_timeout_ms: 500, stream });
  extra.push(plugin);
  return plugin;
}

/** How a message gets onto a named stream — through the plugin's own write path, or around it. */
interface StreamWriter {
  name: string;
  write: (fake: FakeZulip, stream: string, topic: Topic, content: string) => Promise<void>;
}

const WRITERS: StreamWriter[] = [
  {
    name: 'a post from a plugin configured on that stream',
    write: async (fake, stream, topic, content) => {
      await (await openOn(fake, stream)).post(topic, SENDER, content);
    },
  },
  {
    name: 'a third party writing straight to that stream',
    write: async (fake, stream, topic, content) => {
      fake.injectMessage({ topic, content, stream });
    },
  },
];

/** A seam read path, armed before the writes and then polled for everything it has seen. */
interface StreamReader {
  name: string;
  arm: (pair: ZulipPair, topic: Topic) => Promise<() => Promise<string[]>>;
}

const READERS: StreamReader[] = [
  {
    name: 'fetchRecent',
    arm: async ({ plugin }, topic) => async () =>
      (await plugin.fetchRecent({ topic })).messages.map((m) => m.content),
  },
  {
    name: 'subscribe',
    arm: async ({ plugin, fake }, topic) => {
      const seen: string[] = [];
      await plugin.subscribe(topic, (m) => seen.push(m.content));
      // Wait for the loop's first events poll, so that what arrives afterwards can only have come
      // through the QUEUE: until then the subscribe handshake's own gap-fill is still draining, and
      // it reads history through the narrow rather than the registration — a different wire site.
      await vi.waitFor(() => expect(fake.requestCount('GET /api/v1/events')).toBeGreaterThan(0), {
        timeout: 3000,
        interval: 10,
      });
      return async () => Promise.resolve([...seen]);
    },
  },
];

describe('zulip backend_config.stream scopes every wire path, in both directions', () => {
  for (const reader of READERS) {
    for (const writer of WRITERS) {
      it(`${reader.name} sees ${writer.name} only on the configured stream`, async () => {
        const pair = await boot(undefined, { stream: CONFIGURED_STREAM });
        const { fake } = pair;
        const topic = asTopic(`scope-${rand()}`);
        const probe = await reader.arm(pair, topic);

        await writer.write(fake, CONFIGURED_STREAM, topic, 'mine');
        await writer.write(fake, OTHER_STREAM, topic, 'theirs');

        await vi.waitFor(async () => expect(await probe()).toEqual(['mine']), {
          timeout: 3000,
          interval: 20,
        });
        // A push path can only be shown to EXCLUDE something by outliving its delivery latency.
        await sleep(300);
        expect(await probe()).toEqual(['mine']);

        const onOther = await openOn(fake, OTHER_STREAM);
        expect((await onOther.fetchRecent({ topic })).messages.map((m) => m.content)).toEqual([
          'theirs',
        ]);
      });
    }
  }

  it('the same topic name in two streams is two histories, not one merged by case folding', async () => {
    const { plugin, fake } = await boot(undefined, { stream: CONFIGURED_STREAM });
    const topic = asTopic(`Scope-${rand()}`);
    await plugin.post(topic, SENDER, 'mine');
    fake.injectMessage({ topic: topic.toUpperCase(), content: 'theirs', stream: OTHER_STREAM });

    expect((await plugin.fetchRecent({ topic })).messages.map((m) => m.content)).toEqual(['mine']);
  });
});
