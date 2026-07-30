import { asTopic } from '@sharptrick/parley-core';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { DiscordPlugin } from '../src/index.js';
import { FAKE_TOKEN, startFakeDiscord, type FakeDiscord } from './fake-discord.js';

// CLASS: a gateway frame the provider should never have sent, arriving on the ONE `ws` `message`
// listener. A throw inside an emitter callback is an uncaughtException, not a rejected promise: it
// kills the whole MCP server process, taking the REST half, every other topic and core's catch-up
// with it. So the axis is (opcode × the shape of `d`) rather than any one frame, every row drives a
// REAL `ws` socket — FakeWs.fire() re-throws into the test, which is a different failure and would
// hide this one — and every row asserts the same three things: the process saw no uncaught error,
// the plugin's REST half still answers, and the socket that carried the frame is accounted for.

const CHANNEL = '830000000000000001';
const TOPIC = asTopic(CHANNEL);
/** Long enough that no row's watchdog fires inside it; the rows end their sockets themselves. */
const WATCHDOG_MS = 60_000;
/** Well above any heartbeat a row could start, so a leaked interval is visible as a sent beat. */
const SANE_HEARTBEAT_MS = 60_000;
/** How long a row waits for the plugin to react before deciding the listener never came back. */
const REACTION_MS = 250;

const HELLO_OK = JSON.stringify({ op: 10, d: { heartbeat_interval: SANE_HEARTBEAT_MS } });

interface HostileGateway {
  url: string;
  /** Answer IDENTIFY with READY (and open with a well-formed HELLO) — off for pre-READY rows. */
  handshake: boolean;
  /** The socket the plugin has opened, waiting for the next one if it has not yet. */
  socket(): Promise<WebSocket>;
  /** Frames the client sent, oldest first (`op` only). */
  received(): number[];
  /** Resolve on the plugin's next frame or on its socket closing — whichever comes first. */
  reacted(): Promise<'frame' | 'close'>;
  send(raw: string): void;
  reset(): void;
  close(): Promise<void>;
}

/**
 * A gateway that says exactly what a row tells it to, byte for byte — the point is frames no
 * encoder in this package would produce, so it takes raw strings rather than objects.
 */
async function startHostileGateway(): Promise<HostileGateway> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', resolve));

  let current: WebSocket | undefined;
  let waitingForSocket: Array<(ws: WebSocket) => void> = [];
  let waitingForReaction: Array<(what: 'frame' | 'close') => void> = [];
  let ops: number[] = [];

  const wake = (what: 'frame' | 'close'): void => {
    for (const resolve of waitingForReaction.splice(0)) resolve(what);
  };

  const gateway: HostileGateway = {
    url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
    handshake: false,
    socket: () =>
      current !== undefined
        ? Promise.resolve(current)
        : new Promise<WebSocket>((resolve) => waitingForSocket.push(resolve)),
    received: () => [...ops],
    reacted: () =>
      Promise.race([
        new Promise<'frame' | 'close'>((resolve) => waitingForReaction.push(resolve)),
        delay(REACTION_MS, 'close' as const),
      ]),
    send: (raw) => current?.send(raw),
    reset: () => {
      current = undefined;
      waitingForSocket = [];
      waitingForReaction = [];
      ops = [];
    },
    close: async () => {
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };

  wss.on('connection', (ws) => {
    current = ws;
    ws.on('close', () => wake('close'));
    ws.on('message', (data) => {
      const frame = JSON.parse(String(data)) as { op?: number };
      ops.push(frame.op ?? -1);
      if (frame.op === 2 && gateway.handshake) {
        ws.send(JSON.stringify({ op: 0, t: 'READY', s: 1, d: { session_id: 'hostile' } }));
      }
      wake('frame');
    });
    if (gateway.handshake) ws.send(HELLO_OK);
    for (const resolve of waitingForSocket.splice(0)) resolve(ws);
  });

  return gateway;
}

describe('a malformed gateway frame never escapes the message listener', () => {
  let fake: FakeDiscord;
  let gateway: HostileGateway;
  let crashes: unknown[] = [];
  let diag: ReturnType<typeof vi.spyOn>;
  const record = (err: unknown): void => {
    crashes.push(err);
  };
  const written = (): string => diag.mock.calls.map((c) => String(c[0])).join('');

  beforeAll(async () => {
    fake = await startFakeDiscord();
    gateway = await startHostileGateway();
    fake.createChannel(CHANNEL);
    // Installed for the whole file: without a listener node PRINTS AND EXITS, so the very defect
    // this suite is about would take the runner down instead of failing a row.
    process.on('uncaughtException', record);
  });
  afterAll(async () => {
    process.off('uncaughtException', record);
    await gateway.close();
    await fake.close();
  });

  beforeEach(() => {
    crashes = [];
    gateway.reset();
    diag = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const connect = async (): Promise<DiscordPlugin> => {
    const plugin = new DiscordPlugin();
    await plugin.connect({
      token: FAKE_TOKEN,
      api_url: fake.apiUrl,
      gateway_url: gateway.url,
      handshake_timeout_ms: WATCHDOG_MS,
    });
    return plugin;
  };

  interface Survival {
    /** Contents the subscribed handler was given while the frame was in flight. */
    delivered: string[];
    /** Whether the plugin answered the frame (or the one after it) or ended the socket. */
    reaction: 'frame' | 'close';
    /** Opcodes the plugin sent AFTER the frame — `2` means the socket lived to IDENTIFY again. */
    answered: number[];
  }

  /**
   * Deliver `frame` on a live socket, wait for the plugin to react to it, and assert the process
   * and the plugin both survived. A row that reached READY first gets a subscribed channel, so the
   * dispatch branch runs with a registered handler rather than against an empty map.
   *
   * `followUp` appends a well-formed HELLO the plugin visibly answers, so a row waits on the
   * LISTENER rather than on the clock; rows whose frame is expected to END the socket switch it off
   * and wait on the close instead.
   */
  const survives = async (
    frame: string,
    phase: 'pre-ready' | 'ready',
    followUp = true,
  ): Promise<Survival> => {
    gateway.handshake = phase === 'ready';
    const plugin = await connect();
    const delivered: string[] = [];
    const subscribed = plugin
      .subscribe(TOPIC, (m) => delivered.push(m.content))
      .catch(() => undefined);
    if (phase === 'ready') await subscribed;
    await gateway.socket();

    try {
      const sentBefore = gateway.received().length;
      const settled = gateway.reacted();
      gateway.send(frame);
      if (followUp) gateway.send(HELLO_OK);
      const reaction = await settled;

      expect(crashes.map(String), 'a malformed frame reached the process as an uncaught error')
        .toEqual([]);
      const { messages } = await plugin.fetchRecent({ topic: TOPIC, limit: 10 });
      expect(messages, 'the REST half stopped answering after the malformed frame').toEqual([]);
      return { delivered, reaction, answered: gateway.received().slice(sentBefore) };
    } finally {
      await plugin.disconnect();
      await subscribed;
    }
  };

  // Every opcode the wire can carry, pinned by VALUE rather than read from the plugin's own OP map:
  // a frame the plugin does not recognize still lands in this listener, and the `default` branch is
  // exactly where a later opcode would be added.
  const OPCODES = [...Array(14).keys(), 42];
  const MISSING_D: Array<[string, string]> = [
    ['no d at all', ''],
    ['a null d', ',"d":null'],
  ];

  for (const op of OPCODES) {
    for (const [label, tail] of MISSING_D) {
      it(`op ${op} with ${label} is survivable`, async () => {
        await survives(`{"op":${op}${tail}}`, 'pre-ready');
      });
    }
  }

  // The two branches that actually DEREFERENCE `d`, crossed with the shapes JSON can put there.
  // The opcode table above cannot see these: `{}` and a wrong-typed field are both objects, so they
  // reach the field access instead of failing the null check on the way in.
  const HELLO_SHAPES = [
    '{}',
    '{"heartbeat_interval":null}',
    '{"heartbeat_interval":"41250"}',
    '{"heartbeat_interval":0}',
    '{"heartbeat_interval":-1}',
    '{"heartbeat_interval":{}}',
    '7',
    '"41250"',
    '[]',
  ];

  for (const d of HELLO_SHAPES) {
    it(`a HELLO whose d is ${d} ends the socket instead of IDENTIFYing`, async () => {
      const { reaction, answered } = await survives(`{"op":10,"d":${d}}`, 'pre-ready', false);
      // Not crashing is not enough: a period this HELLO never stated would either be `NaN`
      // (a heartbeat that never beats, so Discord zombie-closes) or `0` (a beat per millisecond
      // into Discord's rate limiter). Refusing the handshake is the only answer that costs neither.
      expect(reaction, 'the plugin kept a socket whose HELLO named no heartbeat period').toBe(
        'close',
      );
      expect(answered, 'the plugin IDENTIFYed on an unusable HELLO').not.toContain(2);
    });
  }

  const DISPATCH_SHAPES = [
    'null',
    '{}',
    '7',
    '"a message"',
    '[]',
    `{"channel_id":${CHANNEL}}`,
    `{"channel_id":"${CHANNEL}"}`,
    `{"id":"9"}`,
    `{"channel_id":"${CHANNEL}","id":9,"content":"hi"}`,
  ];

  for (const phase of ['pre-ready', 'ready'] as const) {
    for (const d of DISPATCH_SHAPES) {
      it(`a MESSAGE_CREATE whose d is ${d} costs one message, not the socket (${phase})`, async () => {
        const { delivered, answered } = await survives(
          `{"op":0,"t":"MESSAGE_CREATE","s":2,"d":${d}}`,
          phase,
        );
        // `id` becomes backendMsgId AND cursor, so a frame without one would put `undefined` into
        // core's dedup set and into the cursor it persists for this topic.
        expect(delivered, 'a frame with no usable id or channel was pushed at a subscriber')
          .toEqual([]);
        // One unusable dispatch is one dropped message. Ending the socket over it would spend a
        // reconnect out of Discord's per-token IDENTIFY quota for a frame nobody needed.
        expect(answered, 'one malformed dispatch cost the whole socket').toContain(2);
      });
    }
  }

  const OTHER_DISPATCH = [
    '{"op":0,"s":2,"d":null}',
    '{"op":0,"t":"READY","d":null}',
    '{"op":0,"t":"READY","s":"two","d":{}}',
    '{"op":0,"t":"GUILD_CREATE","d":null}',
    '{"op":0,"t":null,"s":null,"d":null}',
  ];

  for (const frame of OTHER_DISPATCH) {
    it(`the dispatch ${frame} is survivable`, async () => {
      await survives(frame, 'pre-ready');
    });
  }

  // Every row above is a frame SOMEBODY predicted, and the guards that answer them are pinned by
  // their own rows. The boundary around the whole switch is for the throw nobody predicted, so the
  // only way to measure it is to inject one — here into the one statement of the dispatch branch
  // that no inner handler wraps, the long-poll waiter fan-out. A future opcode branch that throws
  // lands in exactly the same place.
  it('a branch that throws costs the socket, not the process', async () => {
    gateway.handshake = true;
    const plugin = await connect();
    await plugin.subscribe(TOPIC, () => undefined);
    await gateway.socket();

    let raised = false;
    const waiters = (plugin as unknown as { waiters: Map<string, Set<() => void>> }).waiters;
    waiters.set(
      CHANNEL,
      new Set([
        () => {
          if (raised) return; // the close below fires every waiter again; raise exactly once
          raised = true;
          throw new Error('injected fault');
        },
      ]),
    );

    try {
      const settled = gateway.reacted();
      gateway.send(
        JSON.stringify({
          op: 0,
          t: 'MESSAGE_CREATE',
          s: 2,
          d: {
            id: '830000000000000007',
            channel_id: CHANNEL,
            content: 'hi',
            timestamp: '',
            author: { id: '1', username: 'u' },
          },
        }),
      );
      const reaction = await settled;

      expect(raised, 'the injected fault never ran, so this cell measures nothing').toBe(true);
      expect(crashes.map(String), 'an unforeseen throw reached the process').toEqual([]);
      expect(written(), 'the boundary swallowed the throw without naming it').toContain(
        'injected fault',
      );
      expect(reaction, 'a socket whose frame handling failed was left in place').toBe('close');
      const { messages } = await plugin.fetchRecent({ topic: TOPIC, limit: 10 });
      expect(messages, 'the REST half went down with the socket').toEqual([]);
    } finally {
      await plugin.disconnect();
    }
  });

  // Surviving the frame is only half of it: a socket the plugin gave up on has to be replaced by
  // the ladder, or "no crash" just means the live path died quietly instead of loudly.
  it('a malformed HELLO costs one socket, not the live path', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0); // the ladder's first rung, exactly
    gateway.handshake = false;
    const plugin = await connect();
    const delivered: string[] = [];
    const subscribed = plugin
      .subscribe(TOPIC, (m) => delivered.push(m.content))
      .catch(() => undefined);
    await gateway.socket();

    try {
      const reaction = gateway.reacted();
      gateway.send('{"op":10}');
      await reaction;
      expect(crashes.map(String)).toEqual([]);

      gateway.handshake = true; // the gateway starts behaving; the ladder must find it
      gateway.reset();
      const reconnected = await gateway.socket();
      await vi.waitFor(() => expect(gateway.received()).toContain(2), { timeout: 5000 });

      reconnected.send(
        JSON.stringify({
          op: 0,
          t: 'MESSAGE_CREATE',
          s: 2,
          d: {
            id: '830000000000000009',
            channel_id: CHANNEL,
            content: 'back-online',
            timestamp: '',
            author: { id: '1', username: 'u' },
          },
        }),
      );
      await vi.waitFor(() => expect(delivered).toEqual(['back-online']), { timeout: 5000 });
    } finally {
      await plugin.disconnect();
      await subscribed;
    }
  });
});
