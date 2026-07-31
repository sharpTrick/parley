import { readdirSync } from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { asCursor, asTopic, loadConfig } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { CONFIG_KEYS, createRedisClient, RedisPlugin } from '../src/index.js';
import { rejectedByKnob, rejectedRows } from './config-fixtures.js';
import {
  commandOf,
  DEFAULT_REPLIES,
  expectSafeError,
  respEndpoint,
  respError,
  SECRET,
  withArgs,
} from './resp-server.js';
import {
  activeHandles,
  endpointOf,
  FAST_MS as FAST,
  freeEndpoint,
  handleGrowth,
  isRedisUp,
} from './support.js';

// The failure surface the seam-conformance suite structurally cannot reach: it only ever runs
// against a reachable server, with cursors this backend just minted and a default retention.
// Everything here drives the REAL plugin (no `redis` mock) against a broken or hostile endpoint.
//
// Keep every case in this file server-INDEPENDENT: its unreachable endpoints are minted per row and
// its degraded servers are in-process, so nothing here may skip. The live half lives in
// `live-failure-modes.test.ts`, where a whole-file skip gate can see a missing server — a file that
// mixes the two reports a clean pass with half its cases deleted.

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
    ['closed port', async () => ({ url: await freeEndpoint(), close: () => undefined })],
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
    const closed = await freeEndpoint();
    const url = closed.replace('//', `//parley:${SECRET}@`);
    const plugin = new RedisPlugin();
    await expect(plugin.connect({ url, connect_timeout_ms: FAST })).rejects.toThrow(
      new RegExp(endpointOf(closed).replace(/\./g, '\\.')),
    );
    await expect(plugin.connect({ url, connect_timeout_ms: FAST })).rejects.not.toThrow(
      new RegExp(SECRET),
    );
    await plugin.disconnect().catch(() => undefined);
  });
});

// ---------------------------------------------------------------------------------------------
// CLASS: a backend_config value is accepted and then silently redirects the endpoint or the
// keyspace, or produces a silent no-op. Every knob lands somewhere destructive (a MINID threshold,
// an XREAD BLOCK argument, a deadline, the connection URL, the Redis key), so the matrix below is
// knob x value — a validator written for one knob does not pass for the others — and it is
// generated over EVERY declared key, so a knob added later without a validator fails the suite.
//
// No server: every row is REJECTED by validation, which runs before the connection is opened.
// ---------------------------------------------------------------------------------------------

/** Keys an operator reaches for that this backend does not declare — a typo, a case variant, junk. */
const unknownKeys: Array<[string, string, unknown]> = [
  ['a typo of a real key', 'retention_dayz', 30],
  ['a run-together variant', 'keyprefix', 'app:'],
  ['a case variant', 'Key_Prefix', 'app:'],
  ['a trailing-space variant', 'key_prefix ', 'app:'],
  ['a knob borrowed from another backend', 'poll_interval_ms', 250],
  ['junk', 'foo', 1],
];

describe('redis failure modes — backend_config validation', () => {
  it.each(rejectedRows)('connect() rejects %s = %s, naming the key', async (knob, _label, value) => {
    const plugin = new RedisPlugin();
    await expect(plugin.connect({ [knob]: value })).rejects.toThrow(
      new RegExp(`parley-redis: ${knob}`),
    );
    await plugin.disconnect().catch(() => undefined);
  });

  // Generated from the shipped key list rather than hand-listed, so a knob added later with no
  // validator has no rejection rows above and fails here instead of being silently accepted.
  it.each(CONFIG_KEYS)('%s is covered by a rejection row', (knob) => {
    expect(Object.keys(rejectedByKnob)).toContain(knob);
  });

  it.each(unknownKeys)(
    'connect() rejects %s (%s), naming the key and the accepted set',
    async (_label, key, value) => {
      const plugin = new RedisPlugin();
      const failure = await plugin.connect({ [key]: value }).then(
        () => undefined,
        (err: Error) => err,
      );
      expect(failure, `backend_config key '${key}' was accepted in silence`).toBeInstanceOf(Error);
      expect(failure?.message).toContain(`unknown backend_config key '${key}'`);
      for (const known of CONFIG_KEYS) expect(failure?.message).toContain(known);
      await plugin.disconnect().catch(() => undefined);
    },
  );
});

// ---------------------------------------------------------------------------------------------
// CLASS: a shipped runnable config the README points operators at cannot load. This plugin rejects
// an UNDECLARED backend_config key outright, so a knob rename turns every example into a hard
// startup error — and a regex scan for `redis://` (which is all these files used to get) cannot see
// it. Generated over the directory, so an example added later is pulled in instead of escaping.
// ---------------------------------------------------------------------------------------------

const EXAMPLES = new URL('../../../examples/multi-session/redis/', import.meta.url);
const exampleFiles = readdirSync(EXAMPLES).filter((f) => /\.ya?ml$/.test(f));

/** Every validator message that means "this file cannot load", as opposed to "the server is away". */
const REJECTED_BY_VALIDATION = new RegExp(
  `parley-redis: (?:${CONFIG_KEYS.join('|')}) must|unknown backend_config key`,
);

const backendConfigOf = (file: string): Record<string, unknown> =>
  loadConfig(fileURLToPath(new URL(file, EXAMPLES))).backend_config;

describe('bridge-redis shipped example configs — every one still loads', () => {
  it('ships at least one example, so the rows below are not vacuous', () => {
    expect(exampleFiles).not.toEqual([]);
  });

  it.each(exampleFiles)('%s loads and declares only keys this backend accepts', (file) => {
    const declared = Object.keys(backendConfigOf(file));
    expect(declared, `${file} sets no backend_config key, so this row cannot fail`).not.toEqual([]);
    for (const key of declared) {
      expect(CONFIG_KEYS as readonly string[], `${file} sets '${key}'`).toContain(key);
    }
  });

  // The keys being declared is not enough: every VALUE has to survive the normalizers too. A value
  // that does not is rejected before any connection is attempted, so this needs no server — the
  // shipped examples point at `redis.internal`, which is unreachable from here by design.
  it.each(exampleFiles)('%s carries values the validators accept', async (file) => {
    const plugin = new RedisPlugin();
    const failure = await plugin
      .connect({ ...backendConfigOf(file), connect_timeout_ms: FAST })
      .then(
        () => undefined,
        (err: Error) => err,
      );
    expect(failure?.message ?? '', `${file} cannot load`).not.toMatch(REJECTED_BY_VALIDATION);
    await plugin.disconnect().catch(() => undefined);
  });
});

// ---------------------------------------------------------------------------------------------
// CLASS: connect() reports success against an endpoint that cannot serve the seam. Every row is
// REACHABLE — the handshake completes — so the fail-fast table above cannot see any of them.
//
// Three axes, because each one hides a different failure from a hand-listed table:
//   * CODE. `PERMANENT_SERVER_ERROR` lists seven refusal codes; a table that names four grades the
//     three it left out not at all. Generated from the shipped list, so a code added later has a
//     row before it has a bug.
//   * ARRIVAL. A refusal that lands on the HANDSHAKE survives only as an emitted `error` event
//     (node-redis reports the connect itself as the reconnect strategy's generic failure); one that
//     lands on the first COMMAND arrives as the thrown rejection. Those are two different reads.
//   * ECHO. A real Redis appends `, with args beginning with: '<arg>', …` to a refusal — so a
//     server that does not know `AUTH` hands this client its own password back inside the error the
//     plugin then composes and cli.ts writes to stderr. A fake that answers with a bare
//     `-ERR unknown command` cannot produce the failure mode that matters.
// ---------------------------------------------------------------------------------------------

describe('redis failure modes — a reachable server that cannot serve the seam', () => {
  /** Every code `PERMANENT_SERVER_ERROR` treats as "only an operator can clear this". */
  const refusals: Array<[string, string]> = [
    ['ERR', "unknown command 'PING'"],
    ['NOAUTH', 'Authentication required.'],
    ['WRONGPASS', 'invalid username-password pair or user is disabled.'],
    ['NOPERM', "this user has no permissions to run the 'ping' command"],
    ['WRONGTYPE', 'Operation against a key holding the wrong kind of value'],
    ['NOPROTO', 'unsupported protocol version'],
    ['EXECABORT', 'Transaction discarded because of previous errors.'],
  ];

  /** Where the refusal lands — which decides which of the two reads has to find it. */
  const arrivals: Array<[string, (argv: string[]) => boolean]> = [
    ['on the handshake', () => true],
    ['on the first command', (argv) => commandOf(argv) === 'ping'],
  ];

  const echoes: Array<[string, boolean]> = [
    ['a bare refusal', false],
    ['a refusal quoting its arguments', true],
  ];

  const rows = refusals.flatMap(([code, text]) =>
    arrivals.flatMap(([arrival, refuses]) =>
      echoes.map(
        ([echo, echoesArgs]) =>
          [`${code} ${arrival}, ${echo}`, code, refuses, echoesArgs] as const,
      ),
    ),
  );

  it.each(rows)('connect() rejects: %s', async (_label, code, refuses, echoesArgs) => {
    const text = refusals.find(([c]) => c === code)?.[1] ?? '';
    const endpoint = await respEndpoint((argv) =>
      refuses(argv) ? respError(code, echoesArgs ? text + withArgs(argv) : text) : '+OK\r\n',
    );
    const url = endpoint.url.replace('//', `//parley:${SECRET}@`);
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
      expect(failure?.message).toMatch(new RegExp(`refused a command: ${code}\\b`));
      expect(failure?.message).toContain(endpointOf(endpoint.url));
      expectSafeError('connect()', failure, SECRET);
      // A refusal must not be reported as a network problem, or the operator debugs the wrong layer.
      expect(failure?.message).not.toMatch(/cannot reach/);
    } finally {
      await plugin.disconnect().catch(() => undefined);
      endpoint.close();
    }
  });

  it('rejects a server that answers the handshake and then never answers a command', async () => {
    const endpoint = await respEndpoint((argv) =>
      commandOf(argv) === 'ping' ? undefined : '+OK\r\n',
    );
    const plugin = new RedisPlugin();
    try {
      const failure = await plugin
        .connect({ url: endpoint.url.replace('//', `//parley:${SECRET}@`), connect_timeout_ms: FAST })
        .then(
          () => undefined,
          (err: Error) => err,
        );
      expect(failure?.message).toMatch(/did not answer PING/);
      expect(failure?.message).toContain(endpointOf(endpoint.url));
      expectSafeError('connect()', failure, SECRET);
    } finally {
      await plugin.disconnect().catch(() => undefined);
      endpoint.close();
    }
  });

  // A password has TWO spellings and a server can echo either: the DECODED one the client puts on
  // the wire (which comes back in `with args beginning with:`), and the PERCENT-ENCODED one the URL
  // carries (which comes back when anything quotes the connection string). A sweep that knows one
  // misses the other, so the fake below echoes both and every row asserts neither survives — and
  // asserts first that the fake really received the wire form, so a row cannot pass by never
  // exercising the echo at all.
  const passwords: Array<[string, string]> = [
    ['a plain password', SECRET],
    ['a password with URL-unsafe characters', 'p@ss:w0rd/2'],
    ['a password with a percent sign', '50%off'],
    ['a non-ASCII password', 'pässwörd'],
  ];

  // -------------------------------------------------------------------------------------------
  // CLASS: a lifecycle call that FAILS must return every socket it opened. The reader half of this
  // is graded live — `live-failure-modes.test.ts` counts sockets on a stalling proxy — but every
  // row there starts from a connect() that SUCCEEDED, so the COMMAND client's own failure paths are
  // graded by nothing: there the handshake is still in flight when the deadline fires, and once
  // connect() has thrown, nothing retains the client for a later disconnect() to reclaim.
  //
  // Generated over WHERE the failure lands, because each arrival leaves node-redis holding a
  // different amount of connection, and over REPEATS, because one orphan per attempt is what
  // exhausts an operator's file descriptors while a single-attempt row stays green.
  // -------------------------------------------------------------------------------------------

  const brokenServers: Array<[string, (argv: string[]) => string | undefined]> = [
    ['never speaks RESP', () => undefined],
    [
      'answers the handshake and never PING',
      (argv) => (commandOf(argv) === 'ping' ? undefined : '+OK\r\n'),
    ],
    ['refuses the handshake', () => respError('NOAUTH', 'Authentication required.')],
    [
      'refuses PING',
      (argv) =>
        commandOf(argv) === 'ping'
          ? respError('NOPERM', "this user has no permissions to run the 'ping' command")
          : '+OK\r\n',
    ],
  ];

  /** TCP client sockets this process is holding open — the half no remote server can observe. */
  const activeTcpHandles = (): number => activeHandles().TCPSocketWrap ?? 0;

  const leakRows = brokenServers.flatMap(([label, reply]) =>
    [1, 3].map(
      (attempts) =>
        [`${label}, ${attempts}x`, reply, attempts] as [
          string,
          (argv: string[]) => string | undefined,
          number,
        ],
    ),
  );

  it.each(leakRows)('a connect() that fails returns every socket: %s', async (
    _label,
    reply,
    attempts,
  ) => {
    const endpoint = await respEndpoint(reply);
    const plugin = new RedisPlugin();
    const before = activeTcpHandles();
    try {
      for (let i = 0; i < attempts; i++) {
        await expect(
          plugin.connect({ url: endpoint.url, connect_timeout_ms: FAST }),
        ).rejects.toThrow(/^parley-redis:/);
      }
      expect(
        endpoint.accepted(),
        'no connection was opened at all, so this row grades nothing',
      ).toBeGreaterThanOrEqual(attempts);
      await expect
        .poll(() => endpoint.live(), { timeout: 5000, interval: 50 })
        .toBe(0);
      await expect
        .poll(() => activeTcpHandles(), { timeout: 5000, interval: 50 })
        .toBeLessThanOrEqual(before);
    } finally {
      await plugin.disconnect().catch(() => undefined);
      endpoint.close();
    }
  });

  it.each(passwords)('a server echoing AUTH never gets %s back', async (_label, password) => {
    const inTheUrl = encodeURIComponent(password);
    const seen: string[] = [];
    const endpoint = await respEndpoint((argv) => {
      if (commandOf(argv) === 'auth') seen.push(...argv.slice(1));
      return respError(
        'ERR',
        `unknown command '${argv[0] ?? ''}'${withArgs(argv)} (userinfo '${inTheUrl}')`,
      );
    });
    const plugin = new RedisPlugin();
    try {
      const url = endpoint.url.replace('//', `//:${inTheUrl}@`);
      const failure = await plugin.connect({ url, connect_timeout_ms: FAST }).then(
        () => undefined,
        (err: Error) => err,
      );
      expect(seen, 'the fake never received the credential, so this row grades nothing').toContain(
        password,
      );
      expect(failure?.message, 'nothing was redacted, so this row grades nothing').toContain(
        '<redacted>',
      );
      for (const spelling of new Set([password, inTheUrl])) {
        expectSafeError('connect()', failure, spelling);
      }
    } finally {
      await plugin.disconnect().catch(() => undefined);
      endpoint.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// CLASS: a bare `connect()` on the EXPORTED client builder SETTLES — it never retries forever.
// `createRedisClient` is this package's public builder, and `support.ts` calls it with no deadline
// of its own (`isRedisUp`, `withWriter`, `wipe`), so the pre-handshake `Error` return in its
// reconnect strategy is the only thing between a direct consumer and a promise that never settles.
// Every `connect() must fail fast` row above enters through `RedisPlugin.connect()`, which is
// separately bounded by `withDeadline` and therefore passes with the strategy deleted.
//
// Two axes — the endpoint shape (each fails at a different layer) and the entry point — plus the
// POST-handshake arm, so that a "fix" returning an `Error` unconditionally, which would stop a live
// connection riding out a restart, fails here instead of passing.
// ---------------------------------------------------------------------------------------------

describe('redis failure modes — the exported client builder never retries forever', () => {
  const endpoints: Array<[string, () => Promise<{ url: string; close: () => void }>]> = [
    ['a closed port (RST)', async () => ({ url: await freeEndpoint(), close: () => undefined })],
    [
      'a blackholed ip (SYN dropped)',
      async () => ({ url: 'redis://10.255.255.1:6379', close: () => undefined }),
    ],
    [
      'an unresolvable host',
      async () => ({ url: 'redis://parley-no-such-host.invalid:6379', close: () => undefined }),
    ],
  ];

  const entries: Array<[string, (url: string) => Promise<unknown>]> = [
    [
      'createRedisClient(...).connect() with no deadline',
      async (url) => {
        const client = createRedisClient(url, FAST);
        try {
          await client.connect();
        } finally {
          await client.disconnect().catch(() => undefined);
        }
      },
    ],
    ['isRedisUp()', (url) => isRedisUp(url)],
  ];

  const rows = endpoints.flatMap(([shape, make]) =>
    entries.map(
      ([entry, run]) =>
        [`${entry} against ${shape}`, make, run] as [
          string,
          () => Promise<{ url: string; close: () => void }>,
          (url: string) => Promise<unknown>,
        ],
    ),
  );

  it.each(rows)('settles within its own connect budget: %s', async (_label, make, run) => {
    const endpoint = await make();
    try {
      // 4x the budget: generous enough that a slow RST/DNS is not flaky, tight enough that
      // "retries forever" (the defect) can never pass.
      const outcome = await Promise.race([
        run(endpoint.url).then(
          () => 'settled',
          () => 'settled',
        ),
        new Promise<string>((r) => setTimeout(() => r('hung'), FAST * 4)),
      ]);
      expect(
        outcome,
        'the builder retried past its own connect_timeout_ms instead of failing',
      ).toBe('settled');
    } finally {
      endpoint.close();
    }
  });

  // The boundary those rows stop at, pinned so the builder's guarantee cannot be over-claimed:
  // node-redis' `connectTimeout` covers socket ESTABLISHMENT only, so an endpoint that accepts TCP
  // and then never speaks RESP never reaches the reconnect strategy at all and the bare builder
  // waits forever. `withDeadline` inside `RedisPlugin.connect()` is what bounds that shape — which
  // is why the fail-fast row for it above passes — and this is the case that says so.
  it('does not bound a handshake that never completes — withDeadline does', async () => {
    const endpoint = await silentEndpoint();
    const client = createRedisClient(endpoint.url, FAST);
    const connecting = client.connect().catch(() => undefined);
    try {
      const outcome = await Promise.race([
        connecting.then(() => 'settled'),
        new Promise<string>((r) => setTimeout(() => r('still waiting'), FAST * 4)),
      ]);
      expect(
        outcome,
        'the builder now bounds a stalled handshake, so withDeadline is dead weight — delete one ' +
          'of the two rather than leaving the plugin bounded twice',
      ).toBe('still waiting');
    } finally {
      endpoint.close();
      await connecting;
      await client.disconnect().catch(() => undefined);
    }
  });

  // The inverse arm, and the one an over-eager fix breaks: once the handshake has completed the
  // same strategy must switch to bounded backoff, so a connection that was live rides out a
  // restart instead of dying on the first dropped socket.
  it('a connection that completed its handshake is NOT fail-fast', async () => {
    const endpoint = await respEndpoint((argv) => DEFAULT_REPLIES[commandOf(argv)] ?? '+OK\r\n');
    const client = createRedisClient(endpoint.url, FAST);
    try {
      await client.connect();
      expect(client.isOpen, 'the handshake never completed, so this row grades nothing').toBe(true);
      endpoint.close(); // every socket destroyed, the way a server restart does it
      await new Promise((r) => setTimeout(r, FAST));
      expect(
        client.isOpen,
        'a connection that was live gave up on the first dropped socket instead of reconnecting',
      ).toBe(true);
    } finally {
      await client.disconnect().catch(() => undefined);
      endpoint.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// CLASS: a bounded operation releases every handle it ARMED — on success as well as on failure.
// The leak rows above count `TCPSocketWrap` alone and every one of them exercises a connect that
// FAILED, where the deadline timer has already fired; so `withDeadline`'s `clearTimeout` — one
// timer per `connect()`, per `subscribe` and per long-poll — is graded by nothing at all, and
// deleting it arms a live timer for the whole `connect_timeout_ms` past the work it was guarding.
//
// The histogram is the whole handle table, not a socket filter, and the budget on the rows whose
// connect SETTLES is deliberately long, so a timer that was armed and not cleared is still there
// when the table is read. Repeated, so one leak per call clears the runner's own timer noise.
// ---------------------------------------------------------------------------------------------

describe('redis failure modes — every handle a bounded operation arms is released', () => {
  const HANDLE_TOPIC = asTopic('handles');
  /** Enough repeats that one leak per call cannot be mistaken for the runner's own timers. */
  const REPEATS = 4;
  /** Long enough that a timer armed and never cleared is still live when the table is read. */
  const PATIENT_MS = 30_000;

  interface Outcome {
    reply: (argv: string[]) => string | undefined;
    budget: number;
    connects: boolean;
  }

  const outcomes: Array<[string, Outcome]> = [
    [
      'connect ok',
      {
        // `exists` answers 1, so a blocking fetchRecent reaches XREAD instead of the stale-cursor
        // heal, and `subscribe` reaches its read loop.
        reply: (argv) =>
          commandOf(argv) === 'exists' ? ':1\r\n' : (DEFAULT_REPLIES[commandOf(argv)] ?? '+OK\r\n'),
        budget: PATIENT_MS,
        connects: true,
      },
    ],
    [
      'connect refused',
      {
        reply: (argv) =>
          commandOf(argv) === 'ping'
            ? respError('NOAUTH', 'Authentication required.')
            : '+OK\r\n',
        budget: PATIENT_MS,
        connects: false,
      },
    ],
    ['connect times out', { reply: () => undefined, budget: FAST, connects: false }],
  ];

  const operations: Array<[string, (p: RedisPlugin) => Promise<unknown>]> = [
    ['nothing further', () => Promise.resolve()],
    ['subscribe', (p) => p.subscribe(HANDLE_TOPIC, () => undefined)],
    [
      'blocking fetchRecent',
      (p) => p.fetchRecent({ topic: HANDLE_TOPIC, since: asCursor('1-0'), blockMs: 200 }),
    ],
    ['plain fetchRecent', (p) => p.fetchRecent({ topic: HANDLE_TOPIC })],
  ];

  const rows = outcomes.flatMap(([outcomeLabel, outcome]) =>
    operations.map(
      ([opLabel, run]) =>
        [`${outcomeLabel}, then ${opLabel}`, outcome, run] as [
          string,
          Outcome,
          (p: RedisPlugin) => Promise<unknown>,
        ],
    ),
  );

  it.each(rows)('the handle table returns to where it started: %s', async (_label, outcome, run) => {
    const endpoint = await respEndpoint(outcome.reply);
    const before = activeHandles();
    const plugin = new RedisPlugin();
    try {
      for (let i = 0; i < REPEATS; i++) {
        const connected = await plugin
          .connect({ url: endpoint.url, connect_timeout_ms: outcome.budget })
          .then(
            () => true,
            () => false,
          );
        expect(
          connected,
          `connect() did not ${outcome.connects ? 'succeed' : 'fail'}, so this row grades nothing`,
        ).toBe(outcome.connects);
        await run(plugin).catch(() => undefined);
      }
      await plugin.disconnect();
      await expect
        .poll(() => handleGrowth(before, 'TCPSocketWrap'), { timeout: 5000, interval: 50 })
        .toBeLessThan(REPEATS);
      // Read ONCE rather than polled: `expect.poll` retries until the assertion passes, which on a
      // timer would wait out the very budget the leaked timer was armed for and call it clean.
      expect(
        handleGrowth(before, 'Timeout'),
        `${REPEATS} operations left ${handleGrowth(before, 'Timeout')} timers armed, each holding ` +
          `the event loop open for connect_timeout_ms past the work it was guarding`,
      ).toBeLessThan(REPEATS);
    } finally {
      await plugin.disconnect().catch(() => undefined);
      endpoint.close();
    }
  });
});
