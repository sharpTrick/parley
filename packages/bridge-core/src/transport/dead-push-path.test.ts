import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import type { LiveDeliveryReport, TopicLiveDelivery } from '../engine/live-delivery.js';
import { asHandle, asTopic } from '../message.js';
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

type Cfg = { livePush?: boolean; onStart?: boolean };

async function session(plugin: FakePlugin, opts: Cfg = {}): Promise<Session> {
  const cfg = parseConfig({
    identity: { handle: String(ME) },
    topics: [TOPIC],
    state_path: join(mkdtempSync(join(tmpdir(), 'parley-live-status-')), 'read-state.json'),
    catchup: { on_start: opts.onStart ?? true },
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
