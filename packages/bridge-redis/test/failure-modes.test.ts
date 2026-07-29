import net from 'node:net';
import { asHandle, asTopic, type Cursor, type Topic } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { createRedisClient, RedisPlugin } from '../src/index.js';

// The failure surface the seam-conformance suite structurally cannot reach: it only ever runs
// against a reachable server, with cursors this backend just minted and a default retention.
// Everything here drives the REAL plugin (no `redis` mock) against a broken or hostile endpoint.

const REDIS_URL = process.env.PARLEY_REDIS_URL ?? 'redis://127.0.0.1:6379';
const FAST = 800;

// Probe with the PLUGIN's own client builder, so the harness can never be configured more
// defensively than the code under test (a probe with private fail-fast options would hide exactly
// the hang this file exists to catch).
async function isRedisUp(url: string): Promise<boolean> {
  const c = createRedisClient(url, FAST);
  try {
    await c.connect();
    await c.ping();
    await c.disconnect();
    return true;
  } catch {
    await c.disconnect().catch(() => undefined);
    return false;
  }
}

const rand = (): string => Math.random().toString(36).slice(2, 8);
let seq = 0;
const freshTopic = (): Topic => asTopic(`fm-${++seq}-${rand()}`);

async function settlesWithin<T>(work: Promise<T>, ms: number): Promise<'resolved' | 'rejected'> {
  const timeout = Symbol('timeout');
  const outcome = await Promise.race([
    work.then(
      () => 'resolved' as const,
      () => 'rejected' as const,
    ),
    new Promise<typeof timeout>((r) => setTimeout(() => r(timeout), ms)),
  ]);
  if (outcome === timeout) throw new Error(`did not settle within ${ms}ms`);
  return outcome;
}

// ---------------------------------------------------------------------------------------------
// CLASS: startup must fail fast, never hang, on an unreachable or wrong endpoint.
// Every row is a different WAY to be unreachable; a fix that only handles ECONNREFUSED fails here.
// ---------------------------------------------------------------------------------------------

/** A TCP endpoint that completes the handshake and then never speaks a word of Redis. */
async function silentEndpoint(): Promise<{ url: string; close: () => void }> {
  const held: net.Socket[] = [];
  const server = net.createServer((s) => held.push(s));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `redis://127.0.0.1:${port}`,
    close: () => {
      for (const s of held) s.destroy();
      server.close();
    },
  };
}

describe('redis failure modes — connect() must fail fast, never hang', () => {
  const unreachable: Array<[string, () => Promise<{ url: string; close: () => void }>]> = [
    ['closed port', async () => ({ url: 'redis://127.0.0.1:6399', close: () => undefined })],
    ['blackholed ip', async () => ({ url: 'redis://10.255.255.1:6379', close: () => undefined })],
    [
      'unresolvable host',
      async () => ({ url: 'redis://parley-no-such-host.invalid:6379', close: () => undefined }),
    ],
    ['tcp accepts but never speaks redis', silentEndpoint],
  ];

  it.each(unreachable)('rejects with a labelled error: %s', async (_label, make) => {
    const endpoint = await make();
    const plugin = new RedisPlugin();
    try {
      // 4x the budget: generous enough that a slow DNS/RST is not flaky, tight enough that
      // "retries forever" (the defect) can never pass.
      await expect(
        Promise.race([
          plugin.connect({ url: endpoint.url, connect_timeout_ms: FAST }),
          new Promise((_r, reject) =>
            setTimeout(() => reject(new Error('connect() never settled')), FAST * 4),
          ),
        ]),
      ).rejects.toThrow(/parley-redis: cannot reach/);
    } finally {
      await plugin.disconnect().catch(() => undefined);
      endpoint.close();
    }
  });

  it('names the endpoint but never the password', async () => {
    const plugin = new RedisPlugin();
    await expect(
      plugin.connect({
        url: 'redis://parley:hunter2@127.0.0.1:6399',
        connect_timeout_ms: FAST,
      }),
    ).rejects.toThrow(/127\.0\.0\.1:6399/);
    await expect(
      plugin.connect({
        url: 'redis://parley:hunter2@127.0.0.1:6399',
        connect_timeout_ms: FAST,
      }),
    ).rejects.not.toThrow(/hunter2/);
    await plugin.disconnect().catch(() => undefined);
  });
});

// ---------------------------------------------------------------------------------------------
// CLASS: a numeric backend_config knob is accepted and then produces a silent no-op. Every knob
// lands somewhere destructive (a MINID threshold, an XREAD BLOCK argument, a deadline), so the
// matrix below is knob x value — a validator written for one knob does not pass for the others.
// ---------------------------------------------------------------------------------------------

/** Values no millisecond/day knob can mean, whatever it is wired to. */
const NEVER_A_KNOB: Array<[string, unknown]> = [
  ['zero', 0],
  ['negative', -1],
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['-Infinity', Number.NEGATIVE_INFINITY],
  ['numeric string', '7'],
  ['boolean', true],
  ['object', {}],
  ['array', [7]],
];

const rejectedByKnob: Record<string, Array<[string, unknown]>> = {
  retention_days: [
    ...NEVER_A_KNOB,
    ['past the epoch', 1e9],
    ['negative fraction', -0.5],
  ],
  block_ms: [
    ...NEVER_A_KNOB,
    ['sub-millisecond fraction', 0.5],
    ['fraction over one', 1.5],
    ['negative fraction', -0.5],
    ['beyond safe integer', 2 ** 53],
  ],
  connect_timeout_ms: [
    ...NEVER_A_KNOB,
    ['sub-millisecond fraction', 0.5],
    ['fraction over one', 1.5],
    ['negative fraction', -0.5],
    ['beyond safe integer', 2 ** 53],
  ],
};

const rejectedRows = Object.entries(rejectedByKnob).flatMap(([knob, values]) =>
  values.map(([label, value]) => [knob, label, value] as [string, string, unknown]),
);

describe('redis failure modes — numeric backend_config validation', () => {
  it.each(rejectedRows)('connect() rejects %s = %s, naming the key', async (knob, _label, value) => {
    const plugin = new RedisPlugin();
    await expect(plugin.connect({ url: REDIS_URL, [knob]: value })).rejects.toThrow(
      new RegExp(`parley-redis: ${knob}`),
    );
    await plugin.disconnect().catch(() => undefined);
  });
});

// ---------------------------------------------------------------------------------------------
// CLASS: connect() reports success against an endpoint that cannot serve the seam. Every row is
// REACHABLE — the handshake completes — so the fail-fast table above cannot see any of them.
// ---------------------------------------------------------------------------------------------

/** One RESP command, or `undefined` while `buf` still holds a partial one. */
function takeCommand(buf: string): { consumed: number; argv: string[] } | undefined {
  if (!buf.startsWith('*')) {
    const nl = buf.indexOf('\r\n');
    return nl === -1 ? undefined : { consumed: nl + 2, argv: [buf.slice(0, nl)] };
  }
  const head = buf.indexOf('\r\n');
  if (head === -1) return undefined;
  const argc = Number(buf.slice(1, head));
  let at = head + 2;
  const argv: string[] = [];
  for (let i = 0; i < argc; i++) {
    if (buf[at] !== '$') return undefined;
    const lenEnd = buf.indexOf('\r\n', at);
    if (lenEnd === -1) return undefined;
    const len = Number(buf.slice(at + 1, lenEnd));
    const start = lenEnd + 2;
    if (buf.length < start + len + 2) return undefined;
    argv.push(buf.slice(start, start + len));
    at = start + len + 2;
  }
  return { consumed: at, argv };
}

/**
 * A TCP endpoint that speaks enough RESP to complete node-redis' handshake and then answers each
 * command with whatever `reply` returns (`undefined` = stay silent). In-process, so the degraded
 * server rows below need no container and cannot skip themselves.
 */
async function respEndpoint(
  reply: (argv: string[]) => string | undefined,
): Promise<{ url: string; close: () => void }> {
  const held: net.Socket[] = [];
  const server = net.createServer((sock) => {
    held.push(sock);
    let buf = '';
    sock.on('error', () => undefined);
    sock.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      for (;;) {
        const cmd = takeCommand(buf);
        if (cmd === undefined) break;
        buf = buf.slice(cmd.consumed);
        const out = reply(cmd.argv);
        if (out !== undefined) sock.write(out);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `redis://127.0.0.1:${port}`,
    close: () => {
      for (const s of held) s.destroy();
      server.close();
    },
  };
}

const isPing = (argv: string[]): boolean => /^ping$/i.test(argv[0] ?? '');

/** A server whose handshake succeeds and which then answers the first real command with `error`. */
const refusesCommands =
  (error: string) =>
  (argv: string[]): string =>
    isPing(argv) ? error : '+OK\r\n';

describe('redis failure modes — a reachable server that cannot serve the seam', () => {
  interface Degraded {
    reply: (argv: string[]) => string | undefined;
    /** Whether the URL carries a password — a handshake-time refusal needs one to be sent. */
    password: boolean;
    expected: RegExp;
  }

  const degraded: Array<[string, Degraded]> = [
    [
      'password-protected, no password in the URL',
      {
        // A real `--requirepass` server answers CLIENT SETINFO with NOAUTH too, and node-redis
        // SWALLOWS that — which is exactly why the handshake alone proves nothing.
        reply: () => '-NOAUTH Authentication required.\r\n',
        password: false,
        expected: /refused a command: NOAUTH/,
      },
    ],
    [
      'password-protected, wrong password',
      {
        reply: () => '-WRONGPASS invalid username-password pair or user is disabled.\r\n',
        password: true,
        expected: /refused a command: WRONGPASS/,
      },
    ],
    [
      'authenticated, but the ACL forbids the commands the seam needs',
      {
        reply: refusesCommands('-NOPERM this user has no permissions to run the ping command\r\n'),
        password: true,
        expected: /refused a command: NOPERM/,
      },
    ],
    [
      'a non-Redis TCP speaker that answers the handshake',
      {
        reply: refusesCommands('-ERR unknown command\r\n'),
        password: true,
        expected: /refused a command: ERR/,
      },
    ],
    [
      'answers the handshake then never answers a command',
      {
        reply: (argv) => (isPing(argv) ? undefined : '+OK\r\n'),
        password: true,
        expected: /did not answer PING/,
      },
    ],
  ];

  it.each(degraded)('connect() rejects: %s', async (_label, row) => {
    const endpoint = await respEndpoint(row.reply);
    const url = row.password ? endpoint.url.replace('//', '//:hunter2@') : endpoint.url;
    const plugin = new RedisPlugin();
    try {
      const failure = await plugin.connect({ url, connect_timeout_ms: FAST }).then(
        () => undefined,
        (err: Error) => err,
      );
      expect(
        failure,
        'connect() resolved against a server that cannot serve the seam',
      ).toBeInstanceOf(Error);
      expect(failure?.message).toMatch(row.expected);
      expect(failure?.message).toContain(endpointOf(endpoint.url));
      expect(failure?.message).not.toContain('hunter2');
      // A refusal must not be reported as a network problem, or the operator debugs the wrong layer.
      if (!/did not answer/.test(failure?.message ?? '')) {
        expect(failure?.message).not.toMatch(/cannot reach/);
      }
    } finally {
      await plugin.disconnect().catch(() => undefined);
      endpoint.close();
    }
  });
});

function endpointOf(url: string): string {
  const u = new URL(url);
  return `${u.hostname}:${u.port}`;
}

// A server-dependent block must be REGISTERED and reported as skipped, never left unregistered:
// a runtime `if` around describe() turns a missing server into a green file with fewer tests, which
// no whole-file skip gate can see.
const redisUp = await isRedisUp(REDIS_URL);

describe.skipIf(!redisUp)('redis failure modes — retention_days keeps history when unset', () => {
  const accepted: Array<[string, number | null | undefined]> = [
    ['omitted', undefined],
    ['null (DESIGN §11 "unset")', null],
    ['a real window', 7],
  ];

  it.each(accepted)('%s keeps every posted message', async (_label, value) => {
    const prefix = `parleytest:${rand()}:`;
    const plugin = new RedisPlugin();
    await plugin.connect({ url: REDIS_URL, key_prefix: prefix, retention_days: value });
    const t = freshTopic();
    try {
      for (let i = 0; i < 40; i++) await plugin.post(t, asHandle('w'), `m${i}`);
      await new Promise((r) => setTimeout(r, 250)); // any wall-clock-threshold trim would bite here
      for (let i = 40; i < 45; i++) await plugin.post(t, asHandle('w'), `m${i}`);
      const page = await plugin.fetchRecent({ topic: t, limit: 10_000 });
      expect(page.messages).toHaveLength(45);
      expect(page.messages[0]?.content).toBe('m0');
    } finally {
      await plugin.disconnect();
      await wipe(prefix);
    }
  });
});

// -------------------------------------------------------------------------------------------
// The inverse half of the knob class, and the half that actually catches a silent no-op: a value
// connect() ACCEPTS must leave every seam path working. Rejecting bad values is not enough — a
// knob that merely fails to be rejected can still disable live push with nothing to see.
// -------------------------------------------------------------------------------------------

describe.skipIf(!redisUp)('redis failure modes — an accepted config still delivers', () => {
  const accepted: Array<[string, Record<string, unknown>]> = [
    ['every knob omitted', {}],
    ['block_ms at its documented default', { block_ms: 2000 }],
    ['a block_ms shorter than delivery', { block_ms: 20 }],
    ['a block_ms far longer than the test window', { block_ms: 120_000 }],
    ['connect_timeout_ms set', { connect_timeout_ms: 10_000 }],
    ['retention_days set', { retention_days: 7 }],
    ['retention_days null', { retention_days: null }],
    ['a fractional retention window', { retention_days: 0.5 }],
    ['every knob at once', { block_ms: 250, connect_timeout_ms: 3000, retention_days: 30 }],
  ];

  it.each(accepted)('live push and catch-up both work with %s', async (_label, knobs) => {
    const prefix = `parleytest:${rand()}:`;
    const plugin = new RedisPlugin();
    await plugin.connect({ url: REDIS_URL, key_prefix: prefix, ...knobs });
    const t = freshTopic();
    const live: string[] = [];
    try {
      await plugin.subscribe(t, (m) => live.push(m.content));
      const id = await plugin.post(t, asHandle('w'), 'pushed');
      await expect.poll(() => live, { timeout: 5000, interval: 50 }).toEqual(['pushed']);
      const page = await plugin.fetchRecent({ topic: t, limit: 10 });
      expect(page.messages.map((m) => m.backendMsgId)).toEqual([id]);
    } finally {
      await plugin.disconnect();
      await wipe(prefix);
    }
  });
});

// -------------------------------------------------------------------------------------------
// CLASS: a record this plugin did not write still has to normalize into a valid Message. Streams
// are shared across sessions, plugin versions and anyone holding a redis-cli, so `sender`/`ts`
// are not guaranteed to be there — and DESIGN §5 promises an ISO timestamp and a sender either way.
// -------------------------------------------------------------------------------------------

describe.skipIf(!redisUp)('redis failure modes — entries written by a foreign writer', () => {
  const foreignEntries: Array<[string, Record<string, string>]> = [
    ['no recognised field at all', { unrelated: '1' }],
    ['content only (a human via redis-cli)', { content: 'hi from redis-cli' }],
    ['sender only', { sender: 'alice' }],
    ['an empty sender', { sender: '', content: 'anon' }],
    ['an empty ts', { sender: 'alice', content: 'hi', ts: '' }],
    ['a ts that is not a date', { sender: 'alice', content: 'hi', ts: 'not-a-date' }],
    ['a numeric epoch ts', { sender: 'alice', content: 'hi', ts: '1700000000000' }],
    ['extra unknown fields', { sender: 'alice', content: 'hi', shape: 'm.text', edited: '1' }],
    ['binary-ish content', { sender: 'alice', content: '\u00ff\u00fe\u0001bin' }],
  ];

  it.each(foreignEntries)('normalizes an entry with %s', async (_label, fields) => {
    const prefix = `parleytest:${rand()}:`;
    const plugin = new RedisPlugin();
    const writer = createRedisClient(REDIS_URL, FAST);
    await plugin.connect({ url: REDIS_URL, key_prefix: prefix });
    const t = freshTopic();
    try {
      await writer.connect();
      const id = await writer.xAdd(`${prefix}${t}`, '*', fields);
      const page = await plugin.fetchRecent({ topic: t, limit: 10 });
      const [m] = page.messages;
      expect(m, 'the foreign entry did not come back at all').toBeDefined();
      expect(m?.topic).toBe(t);
      expect(m?.backendMsgId).toBe(id);
      expect(m?.cursor).toBe(id);
      expect(m?.content).toBe(fields.content ?? '');
      expect(m?.senderHandle, 'an empty handle collides with every other empty handle').not.toBe('');
      expect(
        Number.isNaN(Date.parse(m?.timestamp ?? '')),
        `timestamp ${JSON.stringify(m?.timestamp)} is not ISO 8601 (DESIGN §5)`,
      ).toBe(false);
    } finally {
      await writer.disconnect().catch(() => undefined);
      await plugin.disconnect();
      await wipe(prefix);
    }
  });

  it('normalizes a foreign entry arriving over the LIVE path too', async () => {
    const prefix = `parleytest:${rand()}:`;
    const plugin = new RedisPlugin();
    const writer = createRedisClient(REDIS_URL, FAST);
    await plugin.connect({ url: REDIS_URL, key_prefix: prefix });
    const t = freshTopic();
    const live: Array<{ senderHandle: string; timestamp: string }> = [];
    try {
      await writer.connect();
      await plugin.subscribe(t, (m) => live.push(m));
      await writer.xAdd(`${prefix}${t}`, '*', { content: 'from redis-cli' });
      await expect.poll(() => live.length, { timeout: 5000, interval: 50 }).toBe(1);
      expect(live[0]?.senderHandle).not.toBe('');
      expect(Number.isNaN(Date.parse(live[0]?.timestamp ?? ''))).toBe(false);
    } finally {
      await writer.disconnect().catch(() => undefined);
      await plugin.disconnect();
      await wipe(prefix);
    }
  });
});

// -------------------------------------------------------------------------------------------
// CLASS: a cursor's PROVENANCE decides the outcome — mine works, foreign throws labelled,
// beyond-high-water self-heals. The wedge invariant below catches the whole class at once.
// -------------------------------------------------------------------------------------------

describe.skipIf(!redisUp)('redis failure modes — cursor provenance', () => {
  const foreign = [
    ['a matrix-style token', 's123_456'],
    ['a plain word', 'abc'],
    ['the empty string', ''],
    ['the XREAD tail sigil', '$'],
    ['a three-part id', '0-0-0'],
    ['a non-numeric sequence', '12-a'],
    ['a negative id', '-1'],
    ['a float', '12.5'],
    ['an id with whitespace', ' 12-0'],
  ] as const;

  it.each(foreign)('throws a labelled error for %s', async (_label, since) => {
    const prefix = `parleytest:${rand()}:`;
    const plugin = new RedisPlugin();
    await plugin.connect({ url: REDIS_URL, key_prefix: prefix });
    const t = freshTopic();
    try {
      await plugin.post(t, asHandle('w'), 'one');
      await expect(
        plugin.fetchRecent({ topic: t, since: since as unknown as Cursor }),
      ).rejects.toThrow(new RegExp(`parley-redis: malformed cursor .* for topic ${t}`));
    } finally {
      await plugin.disconnect();
      await wipe(prefix);
    }
  });

  const stale: Array<[string, () => string]> = [
    ['an hour past the high-water mark', () => `${Date.now() + 3_600_000}-0`],
    ['a day past it', () => `${Date.now() + 86_400_000}-5`],
    ['a bare-ms id past it', () => `${Date.now() + 3_600_000}`],
  ];

  it.each(stale)('self-heals a cursor %s instead of wedging', async (_label, mint) => {
    const prefix = `parleytest:${rand()}:`;
    const plugin = new RedisPlugin();
    await plugin.connect({ url: REDIS_URL, key_prefix: prefix });
    const t = freshTopic();
    try {
      await plugin.post(t, asHandle('w'), 'one');
      await plugin.post(t, asHandle('w'), 'two');
      const since = mint() as Cursor;

      const page = await plugin.fetchRecent({ topic: t, since });
      // The invariant that catches the whole wedge class: a non-empty topic must never answer a
      // catch-up with BOTH an empty page and the same cursor back — that pair is a dead end.
      expect(page.messages.length > 0 || page.nextCursor !== since).toBe(true);
      expect(page.messages.map((m) => m.content)).toEqual(['one', 'two']);
      expect(page.nextCursor).not.toBe(since);

      // …and the healed cursor is live: it advances over the next post.
      await plugin.post(t, asHandle('w'), 'three');
      const next = await plugin.fetchRecent({ topic: t, since: page.nextCursor });
      expect(next.messages.map((m) => m.content)).toEqual(['three']);

      // A stale cursor must not burn a long-poll budget waiting for entries that can never come.
      const started = Date.now();
      const blocked = await plugin.fetchRecent({ topic: t, since, blockMs: 3000 });
      expect(Date.now() - started).toBeLessThan(1500);
      expect(blocked.messages.length).toBeGreaterThan(0);
    } finally {
      await plugin.disconnect();
      await wipe(prefix);
    }
  });

  it('a cursor this backend minted still works, and the tail still returns a stable page', async () => {
    const prefix = `parleytest:${rand()}:`;
    const plugin = new RedisPlugin();
    await plugin.connect({ url: REDIS_URL, key_prefix: prefix });
    const t = freshTopic();
    try {
      await plugin.post(t, asHandle('w'), 'one');
      const tail = (await plugin.fetchRecent({ topic: t })).nextCursor;
      await plugin.post(t, asHandle('w'), 'two');
      const after = await plugin.fetchRecent({ topic: t, since: tail });
      expect(after.messages.map((m) => m.content)).toEqual(['two']);
      // At the tail: empty page, cursor unchanged — the ONE case where echoing `since` is right.
      const drained = await plugin.fetchRecent({ topic: t, since: after.nextCursor });
      expect(drained.messages).toEqual([]);
      expect(drained.nextCursor).toBe(after.nextCursor);
    } finally {
      await plugin.disconnect();
      await wipe(prefix);
    }
  });
});

// -------------------------------------------------------------------------------------------
// CLASS: every seam call must SETTLE within a bounded deadline while the backend is down, and
// the plugin must recover when it comes back.
// -------------------------------------------------------------------------------------------

describe.skipIf(!redisUp)('redis failure modes — backend down mid-session', () => {
  it.each([
    ['post', (p: RedisPlugin, t: Topic) => p.post(t, asHandle('w'), 'during')],
    ['fetchRecent', (p: RedisPlugin, t: Topic) => p.fetchRecent({ topic: t })],
    [
      'fetchRecent since',
      (p: RedisPlugin, t: Topic) => p.fetchRecent({ topic: t, since: asCursorish('1-0') }),
    ],
    [
      'fetchRecent blocking',
      (p: RedisPlugin, t: Topic) =>
        p.fetchRecent({ topic: t, since: asCursorish('1-0'), blockMs: 5000 }),
    ],
    ['resolveIdentity', (p: RedisPlugin) => p.resolveIdentity(asHandle('w'))],
    ['subscribe', (p: RedisPlugin, t: Topic) => p.subscribe(t, () => undefined)],
  ] as Array<[string, (p: RedisPlugin, t: Topic) => Promise<unknown>]>)(
    '%s settles instead of queueing for the whole outage',
    async (_label, call) => {
      const proxy = await startProxy();
      const prefix = `parleytest:${rand()}:`;
      const plugin = new RedisPlugin();
      await plugin.connect({ url: proxy.url, key_prefix: prefix, connect_timeout_ms: FAST });
      const t = freshTopic();
      try {
        await plugin.post(t, asHandle('w'), 'before');
        proxy.kill();
        await settledOutage(plugin, t);
        // Generous vs. the 5s blocking budget above, brutal vs. "queued for the whole outage".
        await expect(settlesWithin(call(plugin, t), 3000)).resolves.toMatch(
          /resolved|rejected/,
        );
      } finally {
        await plugin.disconnect().catch(() => undefined);
        proxy.close();
        await wipe(prefix);
      }
    },
  );

  it('recovers once the backend comes back', async () => {
    const proxy = await startProxy();
    const prefix = `parleytest:${rand()}:`;
    const plugin = new RedisPlugin();
    await plugin.connect({ url: proxy.url, key_prefix: prefix, connect_timeout_ms: FAST });
    const t = freshTopic();
    try {
      await plugin.post(t, asHandle('w'), 'before');
      proxy.kill();
      await settledOutage(plugin, t);
      await expect(settlesWithin(plugin.post(t, asHandle('w'), 'during'), 3000)).resolves.toBe(
        'rejected',
      );
      await proxy.revive();
      await expect
        .poll(
          async () => {
            try {
              await plugin.post(t, asHandle('w'), 'after');
              return true;
            } catch {
              return false;
            }
          },
          { timeout: 10_000, interval: 200 },
        )
        .toBe(true);
      const page = await plugin.fetchRecent({ topic: t, limit: 100 });
      expect(page.messages.map((m) => m.content)).toContain('after');
    } finally {
      await plugin.disconnect().catch(() => undefined);
      proxy.close();
      await wipe(prefix);
    }
  });
});

// -------------------------------------------------------------------------------------------
// CLASS: repeated lifecycle calls must not leak backend resources. Counted on the proxy, which
// is an EXTERNAL observation of live sockets — the in-process `readers` array stays clean even
// when connections are orphaned.
// -------------------------------------------------------------------------------------------

describe.skipIf(!redisUp)('redis failure modes — lifecycle must not leak connections', () => {
  const sequences: Array<[string, (p: RedisPlugin, url: string, t: Topic) => Promise<void>]> = [
    [
      'connect·connect·disconnect',
      async (p, url) => {
        await p.connect({ url });
        await p.connect({ url });
        await p.disconnect();
      },
    ],
    [
      'connect·subscribe·connect·disconnect',
      async (p, url, t) => {
        await p.connect({ url });
        await p.subscribe(t, () => undefined);
        await p.connect({ url });
        await p.disconnect();
      },
    ],
    [
      'connect·disconnect·disconnect',
      async (p, url) => {
        await p.connect({ url });
        await p.disconnect();
        await p.disconnect();
      },
    ],
    [
      'connect·subscribe·disconnect·connect·subscribe·disconnect',
      async (p, url, t) => {
        await p.connect({ url });
        await p.subscribe(t, () => undefined);
        await p.disconnect();
        await p.connect({ url });
        await p.subscribe(t, () => undefined);
        await p.disconnect();
      },
    ],
    [
      'connect·fetchRecent(blocking)·connect·disconnect',
      async (p, url, t) => {
        await p.connect({ url, block_ms: 200 });
        await p.fetchRecent({ topic: t, since: asCursorish('1-0'), blockMs: 200 });
        await p.connect({ url });
        await p.disconnect();
      },
    ],
  ];

  // OVERLAPPING lifecycle calls, which every sequence above misses by construction: each one reads
  // plugin state before the other has written it, so a client can end up referenced by nothing and
  // closeable by nobody. The final disconnect() is the assertion point — after it, zero sockets.
  const overlapping: Array<[string, (p: RedisPlugin, url: string, t: Topic) => Promise<void>]> = [
    [
      'connect ∥ connect',
      async (p, url) => {
        await Promise.allSettled([p.connect({ url }), p.connect({ url })]);
      },
    ],
    [
      'connect ∥ connect ∥ connect',
      async (p, url) => {
        await Promise.allSettled([p.connect({ url }), p.connect({ url }), p.connect({ url })]);
      },
    ],
    [
      'connect ∥ disconnect',
      async (p, url) => {
        await Promise.allSettled([p.connect({ url }), p.disconnect()]);
      },
    ],
    [
      'connect ∥ subscribe',
      async (p, url, t) => {
        await Promise.allSettled([p.connect({ url }), p.subscribe(t, () => undefined)]);
      },
    ],
    [
      'connect·(disconnect ∥ subscribe)',
      async (p, url, t) => {
        await p.connect({ url });
        await Promise.allSettled([p.disconnect(), p.subscribe(t, () => undefined)]);
      },
    ],
    [
      'connect·(connect ∥ fetchRecent(blocking))',
      async (p, url, t) => {
        await p.connect({ url, block_ms: 200 });
        await Promise.allSettled([
          p.connect({ url }),
          p.fetchRecent({ topic: t, since: asCursorish('1-0'), blockMs: 500 }),
        ]);
      },
    ],
  ];

  it.each([...sequences, ...overlapping])('%s returns every socket', async (_label, run) => {
    const proxy = await startProxy();
    const plugin = new RedisPlugin();
    const t = freshTopic();
    try {
      await run(plugin, proxy.url, t);
      await plugin.disconnect();
      await expect.poll(() => proxy.live(), { timeout: 5000, interval: 50 }).toBe(0);
    } finally {
      await plugin.disconnect().catch(() => undefined);
      proxy.close();
    }
  });
});

function asCursorish(s: string): Cursor {
  return s as unknown as Cursor;
}

/**
 * Wait out the socket-close error and the first reconnect attempts, so the measured call is issued
 * into a client that has SETTLED into "disconnected" — the state where an offline queue swallows
 * commands for the whole outage. Only the commands in flight when the socket dies are rejected by
 * the close itself, so measuring the very first call after a kill proves nothing.
 */
async function settledOutage(plugin: RedisPlugin, topic: Topic): Promise<void> {
  await settlesWithin(plugin.post(topic, asHandle('w'), 'flush').catch(() => undefined), 3000);
  await new Promise((r) => setTimeout(r, 300));
}

async function wipe(prefix: string): Promise<void> {
  const admin = createRedisClient(REDIS_URL, FAST);
  try {
    await admin.connect();
    const keys = await admin.keys(`${prefix}*`);
    if (keys.length > 0) await admin.del(keys);
  } catch {
    /* the test already failed for a better reason than cleanup */
  } finally {
    await admin.disconnect().catch(() => undefined);
  }
}

interface Proxy {
  url: string;
  /** Live client sockets currently proxied — the externally observable resource count. */
  live: () => number;
  /** Drop the endpoint the way a crashed server does: stop listening, destroy every socket. */
  kill: () => void;
  revive: () => Promise<void>;
  close: () => void;
}

/**
 * A TCP pass-through in front of the real Redis, so an outage can be simulated per test WITHOUT
 * shutting down a server other suites (and other agents) are using.
 */
async function startProxy(): Promise<Proxy> {
  const target = new URL(REDIS_URL);
  const host = target.hostname;
  const port = target.port === '' ? 6379 : Number(target.port);
  const sockets = new Set<net.Socket>();
  let server: net.Server;
  let listenPort = 0;

  const build = (): net.Server =>
    net.createServer((client) => {
      const upstream = net.connect(port, host);
      sockets.add(client);
      const teardown = (): void => {
        sockets.delete(client);
        client.destroy();
        upstream.destroy();
      };
      client.on('error', teardown).on('close', teardown);
      upstream.on('error', teardown).on('close', teardown);
      client.pipe(upstream);
      upstream.pipe(client);
    });

  server = build();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  listenPort = (server.address() as net.AddressInfo).port;

  const killSockets = (): void => {
    for (const s of sockets) s.destroy();
    sockets.clear();
  };

  return {
    url: `redis://127.0.0.1:${listenPort}`,
    live: () => sockets.size,
    kill: () => {
      server.close();
      killSockets();
    },
    revive: async () => {
      server = build();
      await new Promise<void>((r) => server.listen(listenPort, '127.0.0.1', r));
    },
    close: () => {
      server.close();
      killSockets();
    },
  };
}
