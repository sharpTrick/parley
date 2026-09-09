import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../config.js';
import {
  asBackendMsgId,
  asCursor,
  asHandle,
  asTopic,
  type BackendMsgId,
  type Handle,
  type Message,
  type Topic,
} from '../message.js';
import type {
  BackendConfig,
  BackendIdentity,
  BackendPlugin,
  FetchRecentArgs,
  FetchRecentResult,
  MessageHandler,
} from '../seam.js';
import { FakePlugin } from '../test-support/fake-plugin.js';
import { unhandledDuring } from '../testing/failure-shapes.js';
import { buildBridge } from './stdio-bridge.js';

/**
 * A recording BackendPlugin for the lifecycle tests. It timestamps every seam call into a single
 * ordered `events` log, so a test can assert what a startup or a teardown actually did. Failure
 * injection is opt-in: `fetchThrows` makes on-start catch-up fail; `subscribeThrowsOn` makes the
 * push loop fail on a given topic. Nothing here is SQLite-specific — it exercises the core
 * lifecycle, not a backend.
 */
type Event =
  | { type: 'connect' }
  | { type: 'disconnect' }
  | { type: 'subscribe'; topic: string }
  | { type: 'post'; topic: string; content: string }
  | { type: 'fetchRecent'; topic: string };

class RecordingPlugin implements BackendPlugin {
  readonly events: Event[] = [];
  connectCount = 0;
  disconnectCount = 0;
  private seq = 0;

  constructor(
    private readonly opts: {
      fetchThrows?: boolean;
      subscribeThrowsOn?: string;
      connectThrows?: boolean;
      subscribeParks?: () => Promise<void>;
    } = {},
  ) {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async connect(_config: BackendConfig): Promise<void> {
    if (this.opts.connectThrows === true) throw new Error('connect boom');
    this.connectCount++;
    this.events.push({ type: 'connect' });
  }

  async disconnect(): Promise<void> {
    this.disconnectCount++;
    this.events.push({ type: 'disconnect' });
  }

  async subscribe(topic: Topic, _handler: MessageHandler): Promise<void> {
    this.events.push({ type: 'subscribe', topic });
    if (this.opts.subscribeParks !== undefined) await this.opts.subscribeParks();
    if (this.opts.subscribeThrowsOn === topic) {
      throw new Error(`subscribe boom on ${topic}`);
    }
  }

  async post(
    topic: Topic,
    _identity: Handle,
    content: string,
    _opts?: { inReplyTo?: BackendMsgId },
  ): Promise<BackendMsgId> {
    this.events.push({ type: 'post', topic, content });
    return asBackendMsgId(String(++this.seq));
  }

  async fetchRecent(args: FetchRecentArgs): Promise<FetchRecentResult> {
    this.events.push({ type: 'fetchRecent', topic: args.topic });
    if (this.opts.fetchThrows) throw new Error('catch-up boom');
    return { messages: [] as Message[], nextCursor: args.since ?? asCursor('0') };
  }

  async resolveIdentity(handle: Handle): Promise<BackendIdentity> {
    return { handle, backendRef: handle };
  }
}

/** What `attach` accepts — the SDK's transport interface, as the bridge declares it. */
type AnyTransport = Parameters<Awaited<ReturnType<typeof buildBridge>>['attach']>[0];

/**
 * Every case here builds a real bridge, and a config with no `state_path` resolves to
 * `$XDG_STATE_HOME/parley/<instance>/read-state.json` — the DEVELOPER'S OWN state directory. Redirect
 * it for the whole file rather than adding `state_path` to each config literal, so that the next
 * case written without one still cannot read a cursor left behind by a real session (which is how a
 * lifecycle case here came to assert a round-trip count that depended on what was in ~/.local/state).
 */
const XDG = mkdtempSync(join(tmpdir(), 'parley-bridge-xdg-'));
const REAL_XDG = process.env.XDG_STATE_HOME;
beforeAll(() => {
  process.env.XDG_STATE_HOME = XDG;
});
afterAll(() => {
  if (REAL_XDG === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = REAL_XDG;
  rmSync(XDG, { recursive: true, force: true });
});

/** Wall-clock ceiling a teardown must settle inside, whatever the backend does. */
const TEARDOWN_BUDGET_MS = 3_500;

async function within<T>(budget: number, work: Promise<T>): Promise<T | 'TIMED OUT'> {
  return Promise.race<T | 'TIMED OUT'>([
    work,
    new Promise<'TIMED OUT'>((r) => setTimeout(() => r('TIMED OUT'), budget).unref?.()),
  ]);
}

describe('buildBridge lifecycle: catch-up failure rollback', () => {
  it('disconnects the plugin exactly once when on-start catch-up throws, then rejects', async () => {
    const plugin = new RecordingPlugin({ fetchThrows: true });
    const cfg = parseConfig({
      identity: { handle: 'agent' },
      topics: ['ctx'],
      // catchup.on_start defaults true
    });
    await expect(buildBridge(plugin, cfg)).rejects.toThrow(/catch-up boom/);
    // The connected plugin (and its background timers) must not be orphaned: disconnect ran once.
    expect(plugin.connectCount).toBe(1);
    expect(plugin.disconnectCount).toBe(1);
    // Ordering sanity: connect happened, catch-up was attempted, then disconnect — no leak.
    expect(plugin.events.map((e) => e.type)).toEqual(['connect', 'fetchRecent', 'disconnect']);
  });
});

describe('bridge attach ordering + rollback', () => {
  /**
   * Rollback must cover EVERY awaited call in the startup sequence, not the one that was reported —
   * including the transport handshake, which is not a seam call and so is easy to leave outside the
   * rollback window while the table still reads as exhaustive. Same post-conditions in every row:
   * the call rejects and the connection is released exactly once. `connect` is the one row where
   * there is nothing to release — it never got a connection.
   */
  describe('every startup failure point rolls back identically', () => {
    const cfgWith = (over: Record<string, unknown> = {}) =>
      parseConfig({
        identity: { handle: 'agent' },
        topics: ['ctx', 'ops'],
        live_push: { enabled: true },
        ...over,
      });

    const liveTransport = (): AnyTransport => InMemoryTransport.createLinkedPair()[1];
    const failingTransport = (): AnyTransport => {
      const [, t] = InMemoryTransport.createLinkedPair();
      t.start = (): Promise<void> => Promise.reject(new Error('transport boom'));
      return t;
    };

    it.each([
      ['connect', { connectThrows: true }, /connect boom/, 0, liveTransport],
      ['on-start catch-up', { fetchThrows: true }, /catch-up boom/, 1, liveTransport],
      ['the transport handshake', {}, /transport boom/, 1, failingTransport],
      ['subscribe of the FIRST topic', { subscribeThrowsOn: 'ctx' }, /subscribe boom/, 1, liveTransport],
      ['subscribe of a LATER topic', { subscribeThrowsOn: 'ops' }, /subscribe boom/, 1, liveTransport],
    ])(
      'a failure in %s rejects and releases the connection',
      async (_name, inject, message, expectedDisconnects, transport) => {
        const plugin = new RecordingPlugin(inject);
        const cfg = cfgWith();

        const failed = await (async () => {
          const bridge = await buildBridge(plugin, cfg).catch((e: Error) => e);
          if (bridge instanceof Error) return bridge;
          return bridge.attach(transport()).then(
            () => new Error('startup unexpectedly succeeded'),
            (e: Error) => e,
          );
        })();

        expect(failed.message).toMatch(message);
        expect(plugin.disconnectCount).toBe(expectedDisconnects);
      },
    );
  });

  /**
   * `shutdown()` racing `attach()`. Every await inside attach is a point where the latch can already
   * be set by the time it resolves, and the steps AFTER it must not run — a step that starts past
   * teardown outlives the shutdown that was supposed to release it. Park each await in turn, land a full shutdown() while it is parked, then release:
   * one row per await point, so an await added to attach without a matching latch recheck fails its
   * own row rather than riding along on a neighbour's.
   *
   * The release is deliberately UNLATCHED and therefore runs TWICE here — the parked step finishes
   * AFTER shutdown released everything, re-acquiring what it was in the middle of (a transport
   * handshake that completes after `server.close()`; a subscription registered after
   * `plugin.disconnect()`), so the rollback has to release it again. The rows pin that: both the
   * repeat count and the post-conditions it exists to produce.
   */
  describe('shutdown() landing mid-attach', () => {
    /** A latch a parked step waits on, plus a signal that the step has reached it. */
    function gate(): { park: () => Promise<void>; arrived: Promise<void>; open: () => void } {
      let open!: () => void;
      const opened = new Promise<void>((r) => {
        open = r;
      });
      let reached!: () => void;
      const arrived = new Promise<void>((r) => {
        reached = r;
      });
      return {
        park: async () => {
          reached();
          await opened;
        },
        arrived,
        open,
      };
    }

    type Gate = ReturnType<typeof gate>;
    type Armed = { plugin: RecordingPlugin; transport: AnyTransport };

    const PARK_POINTS: Array<[name: string, arm: (g: Gate) => Armed]> = [
      [
        'the transport handshake (server.connect)',
        (g) => {
          const [, transport] = InMemoryTransport.createLinkedPair();
          const start = transport.start.bind(transport);
          transport.start = async (): Promise<void> => {
            await g.park();
            return start();
          };
          return { plugin: new RecordingPlugin(), transport };
        },
      ],
      [
        'the push loop (plugin.subscribe)',
        (g) => ({
          plugin: new RecordingPlugin({ subscribeParks: g.park }),
          transport: InMemoryTransport.createLinkedPair()[1],
        }),
      ],
    ];

    // A seam whose `disconnect` is NOT idempotent is the case the double release exposes: the second
    // call must stay absorbed, never escaping as an unhandled rejection or a different attach error.
    const DISCONNECTS = ['resolves every time', 'rejects on the second call'] as const;

    it.each(
      PARK_POINTS.flatMap(([name, arm]) =>
        DISCONNECTS.map((d) => [name, d, arm] as [string, (typeof DISCONNECTS)[number], (g: Gate) => Armed]),
      ),
    )('parked in %s, with a disconnect that %s', async (_name, disconnects, arm) => {
      const g = gate();
      const { plugin, transport } = arm(g);
      if (disconnects !== 'resolves every time') {
        const real = plugin.disconnect.bind(plugin);
        plugin.disconnect = async (): Promise<void> => {
          await real();
          if (plugin.disconnectCount > 1) throw new Error('disconnect boom (not idempotent)');
        };
      }
      // ONE topic, so the parked step is the whole of its stage: `startPushLoop` iterates topics
      // with no latch of its own, and a second topic would subscribe after teardown no matter which
      // recheck is in place — hiding the recheck this row exists to witness.
      const cfg = parseConfig({
        identity: { handle: 'agent' },
        topics: ['ctx'],
        live_push: { enabled: true },
      });
      const bridge = await buildBridge(plugin, cfg);
      const closeSpy = vi.spyOn(bridge.server, 'close');

      const escaped = await unhandledDuring(async () => {
        const attaching = bridge.attach(transport).then(
          () => 'resolved',
          (e: Error) => e.message,
        );
        await g.arrived;
        expect(await within(TEARDOWN_BUDGET_MS, bridge.shutdown())).not.toBe('TIMED OUT');
        g.open();
        expect(await within(TEARDOWN_BUDGET_MS, attaching)).toMatch(/bridge shut down while attaching/);
      });

      expect(escaped).toEqual([]);
      // The step that resumes after teardown must start nothing further: once the bridge has
      // disconnected, the only seam call left to make is the rollback's own second disconnect. This
      // is what makes EVERY recheck falsifiable — the one guarding a later await would otherwise
      // cover for a missing one guarding an earlier await, and the row would stay green.
      const released = plugin.events.findIndex((e) => e.type === 'disconnect');
      expect(plugin.events.slice(released + 1).filter((e) => e.type !== 'disconnect')).toEqual([]);
      // Released TWICE, on purpose: the parked step finished after shutdown had already released
      // everything, so a subscription it registered on a disconnected plugin is only reclaimed by
      // the rollback's own second release. Latching that away leaves it dangling.
      expect(plugin.disconnectCount).toBe(2);
      expect(closeSpy).toHaveBeenCalledTimes(2);
    });
  });

  /**
   * Teardown must be bounded and release exactly once, through BOTH entry points on this root — an
   * explicit shutdown, and the rollback inside a failed attach.
   */
  describe('teardown is bounded and releases exactly once', () => {
    it('shutdown() completes inside its budget and disconnects once', async () => {
      const plugin = new RecordingPlugin();
      const cfg = parseConfig({
        identity: { handle: 'agent' },
        topics: ['ctx'],
        live_push: { enabled: false },
      });
      const escaped = await unhandledDuring(async () => {
        const bridge = await buildBridge(plugin, cfg);
        const [, serverT] = InMemoryTransport.createLinkedPair();
        await bridge.attach(serverT);
        expect(await within(TEARDOWN_BUDGET_MS, bridge.shutdown())).not.toBe('TIMED OUT');
      });
      expect(plugin.disconnectCount).toBe(1);
      expect(escaped).toEqual([]);
    });

    it('a failed attach rolls back, and a later shutdown() does not release again', async () => {
      const plugin = new RecordingPlugin({ subscribeThrowsOn: 'ops' });
      const cfg = parseConfig({
        identity: { handle: 'agent' },
        topics: ['ctx', 'ops'],
        live_push: { enabled: true },
      });
      const bridge = await buildBridge(plugin, cfg);
      const [, serverT] = InMemoryTransport.createLinkedPair();
      const outcome = await within(
        TEARDOWN_BUDGET_MS,
        bridge.attach(serverT).then(
          () => 'resolved',
          (e: Error) => e.message,
        ),
      );
      expect(outcome).toMatch(/subscribe boom/);
      expect(plugin.disconnectCount).toBe(1);
      // shutdown() after a rolled-back attach must not disconnect a second time.
      await bridge.shutdown();
      expect(plugin.disconnectCount).toBe(1);
    });

    /**
     * A teardown step that REJECTS is its own case. Latching the "already torn down" flag and then
     * short-circuiting on the first rejection skipped `server.close()` forever and made every retry
     * a silent no-op — on the stdio root that leaves stdin resumed, so an operator's
     * signal handler awaiting shutdown() never returns. Cross the failing step with both teardown
     * entry points and require, in every cell, that the OTHER steps still ran exactly once.
     */
    describe('a rejecting teardown step never cancels the others', () => {
      const STEPS = ['plugin.disconnect', 'server.close', 'both'] as const;
      const ENTRIES = ['shutdown()', 'the rollback inside a failed attach'] as const;

      it.each(STEPS.flatMap((step) => ENTRIES.map((entry) => [step, entry] as const)))(
        '%s rejects, torn down via %s',
        async (step, entry) => {
          const failingAttach = entry !== 'shutdown()';
          const plugin = new RecordingPlugin(failingAttach ? { subscribeThrowsOn: 'ops' } : {});
          if (step !== 'server.close') {
            plugin.disconnect = (): Promise<void> => {
              plugin.disconnectCount++;
              return Promise.reject(new Error('disconnect boom'));
            };
          }
          const cfg = parseConfig({
            identity: { handle: 'agent' },
            topics: ['ctx', 'ops'],
            live_push: { enabled: failingAttach },
          });
          const bridge = await buildBridge(plugin, cfg);
          const closeSpy = vi.spyOn(bridge.server, 'close');
          if (step !== 'plugin.disconnect') closeSpy.mockRejectedValue(new Error('close boom'));

          const [, serverT] = InMemoryTransport.createLinkedPair();
          const first = failingAttach
            ? await within(TEARDOWN_BUDGET_MS, bridge.attach(serverT).catch((e: Error) => e.message))
            : await (async () => {
                await bridge.attach(serverT);
                return within(TEARDOWN_BUDGET_MS, bridge.shutdown().then(() => 'resolved', (e: Error) => e.message));
              })();

          expect(first).not.toBe('TIMED OUT');
          // Every step ran exactly once, whichever one of them rejected.
          expect(plugin.disconnectCount).toBe(1);
          expect(closeSpy).toHaveBeenCalledTimes(1);

          // A retry is a no-op rather than a second release — and never hangs.
          expect(
            await within(TEARDOWN_BUDGET_MS, bridge.shutdown().then(() => 'resolved', () => 'rejected')),
          ).not.toBe('TIMED OUT');
          expect(plugin.disconnectCount).toBe(1);
          expect(closeSpy).toHaveBeenCalledTimes(1);
        },
      );
    });
  });
});

/**
 * CLASS: the catch-up-on-start convention, run end to end through the composition root the way
 * `docs/CONVENTIONS.md` tells a session to run it. The promise the whole lossy-push contract rests
 * on is "what push leaves out, the next `parley_fetch_recent` returns", and it was TRUE at the seam
 * and FALSE through this procedure on every backend: the on-start driver paged over the backlog and
 * advanced the persisted position without emitting, and the tool had no access to that position, so
 * a since-less call answered with the backend's newest window. Measured on five certified backends,
 * a session down while 250 messages arrived saw 100 and missed 150 — in session two, and in every
 * session after it.
 *
 * Graded through `buildBridge` rather than through `catchUpTopic` and `registerTools` separately:
 * each half is conformant on its own, and it is the composition that lost the messages.
 */
describe('a session that was down catches up through the documented procedure', () => {
  /** Well past one page, so the newest page is not the whole backlog. */
  const MISSED = 12;
  const PAGE = 5;

  const bridgeOn = async (
    plugin: BackendPlugin,
    statePath: string,
  ): Promise<{ client: Client; shutdown: () => Promise<void> }> => {
    const cfg = parseConfig({
      identity: { handle: 'agent' },
      topics: ['ctx'],
      state_path: statePath,
      live_push: { enabled: false },
    });
    const bridge = await buildBridge(plugin, cfg);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'session', version: '0' }, { capabilities: {} });
    await Promise.all([bridge.server.connect(serverT), client.connect(clientT)]);
    return {
      client,
      shutdown: async () => {
        await client.close();
        await bridge.shutdown();
      },
    };
  };

  /** The procedure verbatim: no cursor first, then the one handed back, until it stops advancing. */
  const catchUp = async (client: Client): Promise<string[]> => {
    const got: string[] = [];
    let since: string | undefined;
    for (let page = 0; page <= MISSED; page++) {
      const args: Record<string, unknown> = { topic: 'ctx', limit: PAGE };
      if (since !== undefined) args.since = since;
      const out = JSON.parse(
        ((await client.callTool({ name: 'parley_fetch_recent', arguments: args })) as {
          content: { text: string }[];
        }).content[0]!.text,
      ) as { messages: { content: string }[]; nextCursor?: string };
      got.push(...out.messages.map((m) => m.content));
      if (out.nextCursor === undefined || out.nextCursor === since) return got;
      since = out.nextCursor;
    }
    return got;
  };

  it('reaches every message that arrived while it was gone, oldest first', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parley-bridge-catchup-'));
    const statePath = join(dir, 'read-state.json');
    const store = new FakePlugin();
    const T = asTopic('ctx');
    const peer = asHandle('bob');
    try {
      await store.connect({});
      await store.post(T, peer, 'read-in-session-one');

      const first = await bridgeOn(store, statePath);
      expect(await catchUp(first.client)).toEqual(['read-in-session-one']);
      await first.shutdown();

      // …down, while more arrives than one page holds.
      await store.connect({});
      const missed = Array.from({ length: MISSED }, (_unused, i) => `missed-${i}`);
      for (const content of missed) await store.post(T, peer, content);

      const second = await bridgeOn(store, statePath);
      expect(
        await catchUp(second.client),
        'on-start catch-up consumed the backlog and the tool answered from the far side of it: ' +
          'the session ran the documented procedure and the older half is now unreachable, ' +
          'because every later call asks from further on still',
      ).toEqual(missed);
      await second.shutdown();

      // A third session starts, catches up, and is handed nothing it has already read.
      await store.connect({});
      const third = await bridgeOn(store, statePath);
      expect(await catchUp(third.client)).toEqual([]);
      await third.shutdown();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

/**
 * On-start catch-up became a WRITER when it grew a warm marker, and a write on the boot path is a
 * new way for a deployment to fail to start. Driven against the real `parley-sqlite` bin with the
 * state directory at 0500: the process died with a bare EACCES naming a process-unique temp path
 * that no longer existed, and never answered `initialize` — where the same deployment before the
 * marker booted and served every tool call, surfacing the write failure as ONE recoverable
 * `isError` when the tool tried to advance the read position.
 *
 * The marker is a CACHE: derivable, disposable, holding no read position and no message. So the
 * invariant is boot survival, graded through `buildBridge` — `read-state.test.ts` grades the store
 * in isolation and cannot see a boot at all, which is why this shipped.
 */
describe('a state file this process cannot write does not stop the bridge starting', () => {
  const T = asTopic('ctx');
  const peer = asHandle('bob');
  const WARNING = 'could not record catch-up progress';

  /**
   * Each row breaks the state files a different way and declares whether the breakage reaches the
   * MARKER write. Declaring it is what keeps a row from going hollow: a permission row run as a
   * user who can write anyway blocks nothing, and would otherwise pass while grading nothing.
   */
  const BREAKAGES: ReadonlyArray<
    readonly [name: string, apply: (statePath: string) => void, blocksTheMarker: boolean]
  > = [
    ['the state directory is read-only', (p) => chmodSync(join(p, '..'), 0o500), true],
    ['the warm marker path is a directory', (p) => mkdirSync(`${p}.warmed`), true],
    [
      'the state file is read-only',
      (p) => {
        writeFileSync(p, '{}\n');
        chmodSync(p, 0o400);
      },
      false,
    ],
    [
      'the warm marker is unreadable',
      (p) => {
        writeFileSync(`${p}.warmed`, '{}\n');
        chmodSync(`${p}.warmed`, 0o000);
      },
      false,
    ],
  ];

  const ROWS = BREAKAGES.flatMap(([name, apply, blocksTheMarker]) =>
    [true, false].map(
      (onStart) => [`${name}, catchup.on_start=${onStart}`, apply, blocksTheMarker, onStart] as const,
    ),
  );

  it.each(ROWS)('reaches initialize and serves: %s', async (_name, apply, blocksTheMarker, onStart) => {
    const dir = mkdtempSync(join(tmpdir(), 'parley-boot-state-'));
    const stateDir = join(dir, 'state');
    mkdirSync(stateDir);
    const statePath = join(stateDir, 'read-state.json');
    const store = new FakePlugin();
    const warnings = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await store.connect({});
      await store.post(T, peer, 'already-here');
      apply(statePath);

      const cfg = parseConfig({
        identity: { handle: 'agent' },
        topics: ['ctx'],
        state_path: statePath,
        catchup: { on_start: onStart, limit: 100 },
        live_push: { enabled: false },
      });
      // Settled rather than awaited, so a boot that DIES is graded by an assertion here instead of
      // escaping this case as the raw errno the deployment saw.
      const started = await buildBridge(store, cfg).then(
        (bridge) => ({ ok: true as const, bridge }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      if (!started.ok) {
        expect.fail(
          'the bridge died before it could answer initialize. A state file it cannot write is an ' +
            'operator problem the deployment booted through until catch-up started writing, ' +
            'surfacing as ONE recoverable tool error; the warm marker is a cache, and a cache ' +
            'write must not be able to abort startup: ' +
            (started.error instanceof Error ? started.error.message : String(started.error)),
        );
      }
      const { bridge } = started;
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'session', version: '0' }, { capabilities: {} });
      await Promise.all([bridge.server.connect(serverT), client.connect(clientT)]);

      expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([
        'parley_fetch_recent',
        'parley_post',
        'parley_reply',
      ]);

      const answer = (await client.callTool({
        name: 'parley_fetch_recent',
        arguments: { topic: 'ctx', limit: 10, from: 'recent' },
      })) as { content: { text: string }[]; isError?: boolean };
      expect(answer.isError ?? false, answer.content[0]!.text).toBe(false);
      expect(
        (JSON.parse(answer.content[0]!.text) as { messages: { content: string }[] }).messages.map(
          (m) => m.content,
        ),
        'the bridge started but could not answer a read — it is up without being usable',
      ).toEqual(['already-here']);

      const warned = warnings.mock.calls.some((c) => String(c[0]).includes(WARNING));
      expect(
        warned,
        blocksTheMarker && onStart
          ? 'the marker write was blocked and nothing said so: an operator gets a silently ' +
            're-paging boot with no way to find out why'
          : 'a marker write that was never blocked reported a failure, so the rows that ARE ' +
            'blocked cannot be told apart from the ones that are not',
      ).toBe(blocksTheMarker && onStart);

      await client.close();
      await bridge.shutdown();
    } finally {
      warnings.mockRestore();
      chmodSync(stateDir, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

/**
 * Round 4 shipped a SECOND state file beside the read position, and the two have OPPOSITE
 * consequences when they are discarded: losing the agent's read position puts every topic back on
 * the backend's recent window and makes anything older unreachable, while losing the driver's warm
 * marker costs one re-paged boot and reaches strictly MORE. They shared one diagnostic, so an
 * operator whose marker went bad was told their backlog was gone.
 *
 * The FILE is the axis that makes that visible, so it is parameterised: every content shape is
 * driven against both files, through a real boot, and each cell asserts what the operator is told
 * as well as what the agent can still reach.
 */
describe('a corrupt state file says which file, and what it actually costs', () => {
  const T = asTopic('ctx');
  const peer = asHandle('bob');
  const ALL = ['m0', 'm1', 'm2', 'm3', 'm4', 'm5'];
  /** The read position both files start from: the agent has been handed m0 and nothing since. */
  const HEALTHY = JSON.stringify({ ctx: '1' });
  const FOREIGN_CURSOR = JSON.stringify({ ctx: '1785300194045-0' });

  /**
   * A backend that REFUSES a cursor it did not mint, which is what postgres, redis and matrix all
   * do. A fake that silently answers an unparseable cursor with an empty page cannot reach the
   * branch where a cursor read off disk takes the boot down.
   */
  class StrictCursorPlugin extends FakePlugin {
    override async fetchRecent(args: FetchRecentArgs): Promise<FetchRecentResult> {
      if (args.since !== undefined && !/^\d+$/.test(String(args.since))) {
        throw new Error(`invalid input syntax for type bigint: "${String(args.since)}"`);
      }
      return super.fetchRecent(args);
    }
  }

  const FILES = ['read-state', 'warm marker'] as const;
  type StateFile = (typeof FILES)[number];

  /**
   * `speaks` names the files this shape must produce a diagnostic ABOUT. Without it the claims below
   * about what the operator was told are vacuous on every silent shape — and a shape that stops
   * speaking reads as a pass.
   */
  const SHAPES: ReadonlyArray<
    readonly [name: string, apply: (path: string) => void, speaks: readonly StateFile[]]
  > = [
    ['absent', (p) => rmSync(p, { force: true }), []],
    ['empty', (p) => writeFileSync(p, ''), FILES],
    ['truncated', (p) => writeFileSync(p, '{"ctx": "1'), FILES],
    ['non-JSON', (p) => writeFileSync(p, 'not json at all'), FILES],
    ['an array', (p) => writeFileSync(p, '[]'), FILES],
    ['null', (p) => writeFileSync(p, 'null'), FILES],
    ['a numeric cursor', (p) => writeFileSync(p, '{"ctx": 7}'), []],
    ['a foreign topic key', (p) => writeFileSync(p, '{"other": "3"}'), []],
    ['a cursor past the head', (p) => writeFileSync(p, '{"ctx": "9999"}'), []],
    [
      'unreadable',
      (p) => {
        writeFileSync(p, HEALTHY);
        chmodSync(p, 0o000);
      },
      [],
    ],
    [
      // Only the marker speaks here: a read-state path that is a directory fails on the tool's
      // WRITE, which is a recoverable tool error rather than something the boot logs.
      'a directory',
      (p) => {
        rmSync(p, { force: true });
        mkdirSync(p);
      },
      ['warm marker'],
    ],
    // In the read position this one never reaches the diagnostic block: the boot dies, and the
    // message it dies with is asserted above.
    ["another backend's cursor", (p) => writeFileSync(p, FOREIGN_CURSOR), ['warm marker']],
  ];

  const CELLS = SHAPES.flatMap(([shape, apply, speaks]) =>
    FILES.map((file) => [shape, file, apply, speaks.includes(file)] as const),
  );

  it.each(CELLS)('%s in the %s file', async (shape, file, apply, mustSpeak) => {
    const dir = mkdtempSync(join(tmpdir(), 'parley-state-shape-'));
    const statePath = join(dir, 'read-state.json');
    const warmPath = `${statePath}.warmed`;
    const store = new StrictCursorPlugin();
    const said: string[] = [];
    const stderr = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      said.push(a.map(String).join(' '));
    });
    try {
      await store.connect({});
      for (const content of ALL) await store.post(T, peer, content);

      writeFileSync(statePath, HEALTHY);
      // The marker SHADOWS the read position, so a case about the position has to be the one the
      // driver resumes from or it grades the marker twice.
      if (file === 'warm marker') writeFileSync(warmPath, HEALTHY);
      apply(file === 'read-state' ? statePath : warmPath);

      const cfg = parseConfig({
        identity: { handle: 'agent' },
        topics: ['ctx'],
        state_path: statePath,
        live_push: { enabled: false },
      });
      const started = await buildBridge(store, cfg).then(
        (bridge) => ({ ok: true as const, bridge }),
        (error: unknown) => ({ ok: false as const, error }),
      );

      // A cursor minted by ANOTHER backend is the one shape where the two files must part company.
      // In the read position it is the agent's own record of what it has been handed, so guessing
      // past it loses messages and the boot stops, hinted. In the marker it is a cache miss.
      const mustDie = shape === "another backend's cursor" && file === 'read-state';
      if (mustDie) {
        expect(
          started.ok,
          'a cursor this backend cannot parse, sitting in the AGENT’s read position, was papered ' +
            'over — the position is the record of what the agent has been handed, and a boot that ' +
            'guesses past it loses whatever sits between',
        ).toBe(false);
        const message = started.ok ? '' : String((started.error as Error).message);
        expect(message).toContain(statePath);
        expect(message).toContain('1785300194045-0');
        return;
      }
      if (!started.ok) {
        expect.fail(
          `the bridge died at boot over the ${file} file, which is not a file it may die over: ` +
            (started.error instanceof Error ? started.error.message : String(started.error)),
        );
      }

      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'session', version: '0' }, { capabilities: {} });
      await Promise.all([started.bridge.server.connect(serverT), client.connect(clientT)]);

      const reachable: string[] = [];
      let refused = false;
      let since: string | undefined;
      for (let page = 0; page <= ALL.length; page++) {
        const args: Record<string, unknown> = { topic: 'ctx', limit: 2 };
        if (since !== undefined) args.since = since;
        const answer = (await client.callTool({ name: 'parley_fetch_recent', arguments: args })) as {
          content: { text: string }[];
          isError?: boolean;
        };
        // A read-state file the tool cannot WRITE surfaces as a recoverable tool error, which is
        // the pre-marker behaviour and is not silent loss. It is still a refusal, so the marker
        // rows below hold it to zero.
        if (answer.isError === true) {
          refused = true;
          break;
        }
        const out = JSON.parse(answer.content[0]!.text) as {
          messages: { content: string }[];
          nextCursor?: string;
        };
        reachable.push(...out.messages.map((m) => m.content));
        if (out.nextCursor === undefined || out.nextCursor === since) break;
        since = out.nextCursor;
      }

      if (file === 'warm marker') {
        expect(
          refused,
          'breaking the warm marker made a READ fail. The marker is the driver’s own record and ' +
            'no tool call depends on it',
        ).toBe(false);
        expect(
          reachable,
          'breaking the warm marker changed what the AGENT can reach. The marker records what the ' +
            'DRIVER has paged over and nothing else; losing it may cost round trips, never messages',
        ).toEqual(ALL.slice(1));
      } else {
        expect(
          ALL.slice(ALL.length - reachable.length),
          'the agent was handed something other than a contiguous suffix of the topic',
        ).toEqual(reachable);
      }

      const named = said.filter((line) => line.includes(statePath));
      expect(
        named.length > 0,
        `nothing was said about the ${file} file, so every claim below about what the operator ` +
          'was told is vacuous',
      ).toBe(mustSpeak);
      for (const line of named) {
        expect(
          line.includes(warmPath),
          `a diagnostic raised over the ${file} file named the other one: ${line}`,
        ).toBe(file === 'warm marker');
        // The whole of what differs between the two files. Discarding the read position really does
        // strand the backlog; discarding the marker reaches strictly MORE. One sentence serving both
        // is how an operator comes to believe messages are gone, and to delete the wrong file.
        expect(
          line.includes('unreachable'),
          file === 'warm marker'
            ? `a diagnostic about the warm marker claimed messages are unreachable: ${line}`
            : `a diagnostic about the read POSITION did not say what discarding it costs: ${line}`,
        ).toBe(file === 'read-state');
      }

      await client.close();
      await started.bridge.shutdown();
    } finally {
      stderr.mockRestore();
      for (const p of [statePath, warmPath]) {
        try {
          chmodSync(p, 0o600);
        } catch {
          // absent, or a directory this row created — rmSync below handles both
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
