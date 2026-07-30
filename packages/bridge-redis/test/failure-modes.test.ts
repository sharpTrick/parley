import { readdirSync } from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { CONFIG_KEYS, RedisPlugin } from '../src/index.js';
import { rejectedByKnob, rejectedRows } from './config-fixtures.js';
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
    const url = closed.replace('//', '//parley:hunter2@');
    const plugin = new RedisPlugin();
    await expect(plugin.connect({ url, connect_timeout_ms: FAST })).rejects.toThrow(
      new RegExp(endpointOf(closed).replace(/\./g, '\\.')),
    );
    await expect(plugin.connect({ url, connect_timeout_ms: FAST })).rejects.not.toThrow(/hunter2/);
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
