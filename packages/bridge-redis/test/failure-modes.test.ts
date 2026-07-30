import { readdirSync } from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { CONFIG_KEYS, RedisPlugin } from '../src/index.js';
import { rejectedByKnob, rejectedRows } from './config-fixtures.js';
import {
  commandOf,
  expectSafeError,
  respEndpoint,
  respError,
  SECRET,
  withArgs,
} from './resp-server.js';
import { endpointOf, FAST_MS as FAST, freeEndpoint } from './support.js';

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
  const activeTcpHandles = (): number =>
    process.getActiveResourcesInfo().filter((r) => r === 'TCPSocketWrap').length;

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
