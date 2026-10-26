import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import type { LiveDeliveryReport, TopicLiveDelivery } from '../engine/live-delivery.js';
import { asCursor, asHandle, asTopic, type Message, type Topic } from '../message.js';
import type { FetchRecentArgs, FetchRecentResult, MessageHandler } from '../seam.js';
import { connectedFake, DeadListenerPlugin, FakePlugin } from '../test-support/fake-plugin.js';
import { CHANNEL_NOTIFICATION_METHOD } from './channel-emit.js';
import { buildReactiveServer } from './http.js';
import { buildBridge } from './stdio-bridge.js';
import { toolDepsFor } from './tools.js';

/**
 * Clause 3 of the seam — "one whose live path delivers nothing at all is not [conformant]" — had a
 * CI enforcer and no run-time one. A deployment whose `subscribe` registers nothing loses no
 * message: catch-up is complete, so the agent reads everything, a little later, and nothing
 * anywhere says the live half is dead.
 *
 * Graded at the composition root against two plugins that differ in exactly that, so what is being
 * asserted is the PROMISE — this bridge can tell them apart — rather than either counter.
 */

const TOPIC = 'ctx';
const T = asTopic(TOPIC);
const ME = asHandle('agent');
const PEER = asHandle('bob');

interface Session {
  client: Client;
  plugin: FakePlugin;
  pushes: string[];
  shutdown(): Promise<void>;
}

type Cfg = { livePush?: boolean; onStart?: boolean; statePath?: string; catchUpLimit?: number };

const freshStatePath = (): string =>
  join(mkdtempSync(join(tmpdir(), 'parley-live-status-')), 'read-state.json');

async function session(plugin: FakePlugin, opts: Cfg = {}): Promise<Session> {
  const cfg = parseConfig({
    identity: { handle: String(ME) },
    topics: [TOPIC],
    state_path: opts.statePath ?? freshStatePath(),
    catchup: { on_start: opts.onStart ?? true, limit: opts.catchUpLimit ?? 100 },
    live_push: { enabled: opts.livePush ?? true },
  });
  const bridge = await buildBridge(plugin, cfg);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' }, { capabilities: {} });
  const pushes: string[] = [];
  client.fallbackNotificationHandler = async (n): Promise<void> => {
    if (n.method === CHANNEL_NOTIFICATION_METHOD) pushes.push(String(n.params?.content ?? ''));
  };
  await Promise.all([bridge.attach(serverT), client.connect(clientT)]);
  return { client, plugin, pushes, shutdown: () => bridge.shutdown() };
}

const call = async (s: Session, name: string, args: Record<string, unknown> = {}): Promise<unknown> => {
  const res = await s.client.callTool({ name, arguments: args });
  return JSON.parse((res.content as Array<{ text: string }>)[0]!.text);
};

const liveStatus = (s: Session): Promise<LiveDeliveryReport> =>
  call(s, 'parley_live_status') as Promise<LiveDeliveryReport>;

const rowFor = (report: LiveDeliveryReport): TopicLiveDelivery => {
  expect(report.decided, JSON.stringify(report)).toBe(true);
  const row = (report as { topics: TopicLiveDelivery[] }).topics.find((t) => t.topic === T);
  expect(row, 'the report names no row for the subscribed topic').toBeDefined();
  return row!;
};

let open: Session[] = [];
const track = async (s: Promise<Session>): Promise<Session> => {
  const opened = await s;
  open.push(opened);
  return opened;
};

afterEach(async () => {
  for (const s of open) await s.shutdown();
  open = [];
});

describe('a live path that delivers nothing is distinguishable from one that delivers', () => {
  const PLUGINS: Array<[name: string, make: () => FakePlugin, expected: string]> = [
    ['the reference plugin', () => new FakePlugin(), 'delivering'],
    ['a plugin whose subscribe registers no listener', () => new DeadListenerPlugin(), 'not-delivering'],
  ];

  for (const [name, make, expected] of PLUGINS) {
    it(`${name} reports ${expected}`, async () => {
      const s = await track(session(make()));

      // Precondition: with no traffic either way the bridge claims nothing, so the verdict below
      // cannot be the value this surface answers with by default.
      expect(rowFor(await liveStatus(s)).status).toBe('no-traffic');

      await s.plugin.post(T, PEER, 'from-a-peer');
      const page = (await call(s, 'parley_fetch_recent', { topic: TOPIC })) as {
        messages: Array<{ content: string }>;
      };

      // Precondition on the OTHER side: both fixtures really reached the agent, so neither verdict
      // is about a message that never arrived.
      expect(page.messages.map((m) => m.content)).toEqual(['from-a-peer']);
      expect(s.pushes.length > 0).toBe(expected === 'delivering');

      expect(rowFor(await liveStatus(s)).status).toBe(expected);
    });
  }

  /**
   * The window the verdict has to be reached in: ONE reconciling read of ONE message the live path
   * never carried. A surface that only calls it after a threshold of traffic is one an operator
   * reads as healthy for however long the threshold takes.
   */
  it('reaches the verdict on the first message the live path missed', async () => {
    const s = await track(session(new DeadListenerPlugin()));
    await s.plugin.post(T, PEER, 'one');
    await call(s, 'parley_fetch_recent', { topic: TOPIC });
    expect(rowFor(await liveStatus(s)).status).toBe('not-delivering');
  });

  /**
   * The mention filter decides what the AGENT is shown, not whether the path carried anything. A
   * counter behind it reports every session nobody mentions as a dead bridge.
   */
  it('a session nothing mentions still reads as delivering', async () => {
    const cfg = parseConfig({
      identity: { handle: String(ME) },
      topics: [TOPIC],
      state_path: join(mkdtempSync(join(tmpdir(), 'parley-live-status-')), 'read-state.json'),
      live_push: { enabled: true, mention_filter: true },
    });
    const plugin = await connectedFake();
    const bridge = await buildBridge(plugin, cfg);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' }, { capabilities: {} });
    await Promise.all([bridge.attach(serverT), client.connect(clientT)]);
    try {
      await plugin.post(T, PEER, 'addressed to nobody');
      const res = await client.callTool({ name: 'parley_live_status', arguments: {} });
      const report = JSON.parse((res.content as Array<{ text: string }>)[0]!.text) as LiveDeliveryReport;
      expect(rowFor(report).status).toBe('delivering');
    } finally {
      await bridge.shutdown();
    }
  });
});

/**
 * A healthy push whose delivery lands AFTER the agent's pull has already handed the message over: a
 * polling backend's ordinary lag, held here until the test releases it so the order is not a race.
 */
class LaggingPushPlugin extends FakePlugin {
  private readonly held: Array<() => void> = [];

  override async subscribe(topic: Topic, handler: MessageHandler): Promise<void> {
    await super.subscribe(topic, (m: Message) => this.held.push(() => handler(m)));
  }

  release(): number {
    const due = this.held.splice(0);
    for (const deliver of due) deliver();
    return due.length;
  }
}

type Page = { messages: Array<{ content: string }>; nextCursor?: string };

/** The documented catch-up loop. Returns everything it was handed. */
async function catchUpAsAnAgentWould(s: Session): Promise<string[]> {
  const got: string[] = [];
  let since: string | undefined;
  for (let page = 0; page < 50; page++) {
    const answer = (await call(s, 'parley_fetch_recent', {
      topic: TOPIC,
      ...(since !== undefined ? { since } : {}),
    })) as Page;
    got.push(...answer.messages.map((m) => m.content));
    if (answer.nextCursor === undefined || answer.nextCursor === since) break;
    since = answer.nextCursor;
  }
  return got;
}

/**
 * A dead live path over a backend that mints a fresh cursor for every page it returns, as a sync
 * token does: the cursor the agent pages with never byte-equals one catch-up was handed for the
 * same position.
 */
class FreshCursorDeadPlugin extends DeadListenerPlugin {
  private minted = 0;

  override async fetchRecent(args: FetchRecentArgs): Promise<FetchRecentResult> {
    const since = args.since === undefined ? undefined : asCursor(String(args.since).split('#')[0]!);
    const result = await super.fetchRecent({ ...args, since });
    if (result.messages.length === 0) return { ...result, nextCursor: args.since ?? result.nextCursor };
    return { ...result, nextCursor: asCursor(`${result.nextCursor}#${++this.minted}`) };
  }
}

/**
 * The verdict is about the post-subscribe tail (seam.ts clause 3), so it has to hold whatever this
 * boot inherited: a backlog the agent reads through `parley_fetch_recent` predates the subscription,
 * and push owes it nothing. Each state below reaches that backlog by a different route past what
 * on-start catch-up warmed — and the last reaches nothing new at all, so the post-subscribe read
 * cannot lean on passing the backlog to be recognised.
 */
describe('the verdict is about the post-subscribe tail, whatever backlog the boot inherited', () => {
  const BACKLOG = ['old-0', 'old-1', 'old-2', 'old-3', 'old-4'];

  const postWhileDown = async (plugin: FakePlugin, contents: readonly string[]): Promise<void> => {
    await plugin.connect({});
    for (const c of contents) await plugin.post(T, PEER, c);
    await plugin.disconnect();
  };

  type Boot = { cfg: Cfg; handedEarlier: string[] };
  const BOOTS: Array<[name: string, prepare: (p: FakePlugin, statePath: string) => Promise<Boot>]> = [
    ['a fresh, empty topic', async () => ({ cfg: {}, handedEarlier: [] })],
    [
      'a cold boot whose backlog is deeper than catchup.limit',
      async (p) => {
        await postWhileDown(p, BACKLOG);
        return { cfg: { catchUpLimit: 2 }, handedEarlier: [] };
      },
    ],
    [
      'a restart past a marker the agent never read up to, with more arriving while down',
      async (p, statePath) => {
        await postWhileDown(p, BACKLOG.slice(0, 3));
        await (await session(p, { statePath })).shutdown();
        await postWhileDown(p, ['while-down']);
        return { cfg: {}, handedEarlier: [] };
      },
    ],
    [
      'a restart after the agent read everything, with nothing arriving while down',
      async (p, statePath) => {
        await postWhileDown(p, BACKLOG.slice(0, 3));
        const first = await session(p, { statePath });
        const handedEarlier = await catchUpAsAnAgentWould(first);
        await first.shutdown();
        return { cfg: {}, handedEarlier };
      },
    ],
  ];

  const PUSHES: Array<[name: string, make: () => FakePlugin, expected: string]> = [
    ['push lands before the pull', () => new FakePlugin(), 'delivering'],
    ['push lands after the pull', () => new LaggingPushPlugin(), 'delivering'],
    ['push never lands', () => new DeadListenerPlugin(), 'not-delivering'],
  ];

  for (const [boot, prepare] of BOOTS) {
    for (const [push, make, expected] of PUSHES) {
      it(`${boot}; ${push}: no-traffic until post-subscribe traffic, then ${expected}`, async () => {
        const plugin = make();
        const statePath = freshStatePath();
        const { cfg, handedEarlier } = await prepare(plugin, statePath);
        const s = await track(session(plugin, { ...cfg, statePath }));

        const handed = [...handedEarlier, ...(await catchUpAsAnAgentWould(s))];
        // Precondition: whatever the boot inherited really reached the agent through the
        // reconciling read, so `no-traffic` below is not about a backlog nobody read.
        expect(new Set(handed)).toEqual(new Set(plugin.recorded(T).map((m) => m.content)));
        expect(rowFor(await liveStatus(s)).status).toBe('no-traffic');

        await plugin.post(T, PEER, 'after-arming');
        const page = (await call(s, 'parley_fetch_recent', { topic: TOPIC })) as Page;
        expect(page.messages.map((m) => m.content)).toEqual(['after-arming']);
        if (plugin instanceof LaggingPushPlugin) expect(plugin.release()).toBe(1);

        expect(rowFor(await liveStatus(s)).status).toBe(expected);
      });
    }
  }

  it('a backend minting a fresh cursor per read is still recognised once the agent passes the backlog', async () => {
    const plugin = new FreshCursorDeadPlugin();
    await postWhileDown(plugin, BACKLOG);
    const s = await track(session(plugin, { catchUpLimit: 2 }));

    expect(await catchUpAsAnAgentWould(s)).toEqual(BACKLOG);
    expect(rowFor(await liveStatus(s)).status).toBe('no-traffic');

    await plugin.post(T, PEER, 'after-arming');
    const page = (await call(s, 'parley_fetch_recent', { topic: TOPIC })) as Page;
    expect(page.messages.map((m) => m.content)).toEqual(['after-arming']);
    expect(rowFor(await liveStatus(s)).status).toBe('not-delivering');
  });
});

/**
 * Three shipped configurations in which the two counters cannot be compared. Each must REFUSE:
 * reporting `no-traffic` from them would certify a live path this bridge never observed.
 */
describe('a bridge that cannot decide says so, and never reports health instead', () => {
  const BLOCKED: Array<[name: string, cfg: Cfg, reason: string]> = [
    ['live push is disabled', { livePush: false }, 'push_disabled'],
    ['start catch-up is off', { onStart: false }, 'no_start_catchup'],
  ];

  for (const [name, cfg, reason] of BLOCKED) {
    it(`${name}: refuses, naming ${reason}`, async () => {
      const s = await track(session(new DeadListenerPlugin(), cfg));
      await s.plugin.post(T, PEER, 'traffic');
      await call(s, 'parley_fetch_recent', { topic: TOPIC });

      const report = await liveStatus(s);
      expect(report.decided).toBe(false);
      expect((report as { blockedBy: Array<{ reason: string }> }).blockedBy.map((b) => b.reason)).toContain(
        reason,
      );
    });
  }

  it('the remote HTTP root keeps no dedup window, and refuses', async () => {
    // The reactive root's own server, built from the deps `createRemoteHttpApp` derives: no `seen`
    // is passed there, because a stateless root shares one dependency bag across every chat client.
    const plugin = await connectedFake();
    const cfg = parseConfig({
      identity: { handle: String(ME) },
      topics: [TOPIC],
      live_push: { enabled: true },
    });
    const server = buildReactiveServer(toolDepsFor(plugin, cfg));
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' }, { capabilities: {} });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    try {
      const res = await client.callTool({ name: 'parley_live_status', arguments: {} });
      const report = JSON.parse((res.content as Array<{ text: string }>)[0]!.text) as LiveDeliveryReport;
      expect(report.decided).toBe(false);
      expect(
        (report as { blockedBy: Array<{ reason: string }> }).blockedBy.map((b) => b.reason),
      ).toContain('no_dedup_window');
    } finally {
      await server.close();
    }
  });
});
