import { asCursor, asHandle, asTopic } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { RedisPlugin } from '../src/index.js';
import {
  commandOf,
  DEFAULT_REPLIES,
  expectSafeFromServer,
  respEndpoint,
  respError,
  SECRET,
} from './resp-server.js';
import { FAST_MS as FAST, freeEndpoint } from './support.js';

// CLASS: a string the SERVER wrote reaches an operator's log or an MCP tool result unchanged. A
// thrown seam error is rendered by core as an `isError` result — model context — and the live-push
// diagnostic is a line in the operator's terminal, so anything a hostile (or merely misconfigured)
// server puts in a RESP error has to be bounded, stripped of the characters that forge line
// structure, and swept of this connection's own credential before it lands in either.
//
// Three axes, because a fix applied at one site is not a fix:
//   * HOSTILE TEXT. Length, ANSI, C1 controls, NEL/LS line forgery, bidi reordering, and the
//     credential itself — including a credential AHEAD of an over-long body, so that truncation
//     cannot be what hides it.
//   * IMPERSONATION. The same, behind one of THIS PLUGIN's own diagnostic wordings at offset 0 of
//     the RESP line — the position a provenance test made of the message itself reads as "already
//     mine, pass it through". The credential and the over-long tail ride behind the impersonated
//     opening, so a guard that trusts what the server called itself hands back both.
//   * SURFACE. Every path that embeds server text: connect's refusal, `labelled()` on post, on both
//     fetchRecent windows and on the blocking long-poll, on subscribe, and the STOPPED stderr line.
//
// In-process RESP fakes, so nothing here needs a container and nothing here can skip.

const TOPIC = asTopic('hostile');

/** Prefixed to every hostile reply: if it does not survive, the row graded a swallowed error. */
const MARK = 'from-the-server';

/** One hostile RESP error line, as its `<code>` and the text that follows it. */
type Reply = (secret: string, code: string) => [code: string, text: string];

const body =
  (mint: (secret: string) => string): Reply =>
  (secret, code) => [code, `${MARK} ${mint(secret)}`];

const hostile: Array<[string, Reply]> = [
  ['an over-long body', body(() => 'A'.repeat(5000))],
  ['an ANSI colour escape', body(() => 'red\u001B[31m text')],
  ['a C1 control', body(() => 'csi\u009B31m text')],
  ['a NEL line break', body(() => 'forged\u0085parley-redis: all clear')],
  ['a line separator', body(() => 'forged\u2028parley-redis: all clear')],
  ['a paragraph separator', body(() => 'forged\u2029parley-redis: all clear')],
  ['a bidi override', body(() => 'flip\u202Ereversed')],
  ['a NUL byte', body(() => 'split\u0000here')],
  ['the credential', body((secret) => `your password is ${secret}`)],
  ['the credential ahead of an over-long body', body((secret) => `${secret} ${'A'.repeat(5000)}`)],
];

/**
 * The impersonated opening, followed by everything the plugin is supposed to strip. The RESP code
 * is the FIRST WORD of the diagnostic, so the plugin's own wording lands at offset 0 of the message
 * node-redis builds — the only position from which it can be mistaken for the plugin's own.
 */
const impersonating =
  (own: string): Reply =>
  (secret) => {
    const [code = '', ...rest] = own.split(' ');
    return [code, `${rest.join(' ')} ${MARK} password ${secret}\u2028${'A'.repeat(5000)}`];
  };

/**
 * This plugin's own diagnostic wordings, MINTED BY THE PLUGIN rather than restated here. A literal
 * copy stops impersonating anything the day a message is reworded — and goes on passing while it
 * does; driving the real code for them means a rename cannot quietly empty this axis.
 */
async function ownDiagnostics(): Promise<string[]> {
  const said = (work: Promise<unknown>): Promise<string> =>
    work.then(
      () => '',
      (err: Error) => err.message,
    );
  const endpoint = await respEndpoint((argv) => DEFAULT_REPLIES[commandOf(argv)] ?? '+OK\r\n');
  const reachable = new RedisPlugin();
  const unreachable = new RedisPlugin();
  try {
    await connect(reachable, endpoint.url);
    return [
      await said(new RedisPlugin().connect({ retention_days: 0 })),
      await said(unreachable.connect({ url: await freeEndpoint(), connect_timeout_ms: 1 })),
      await said(reachable.fetchRecent({ topic: TOPIC, since: asCursor('not-an-entry-id') })),
    ];
  } finally {
    await reachable.disconnect().catch(() => undefined);
    await unreachable.disconnect().catch(() => undefined);
    endpoint.close();
  }
}

interface Observed {
  /** What the plugin composed out of the server's text — every invariant applies. */
  text: string;
  /** An error's full stack, which `cli.ts` writes to stderr; only the credential invariant applies. */
  stack: string;
}

interface Surface {
  /** The command whose reply carries the hostile text. */
  refuses: string;
  /**
   * The RESP code the hostile text arrives under. Defaults to a PERMANENT one, which is what the
   * surfaces that only report a refusal need; a TRANSIENT code takes the other arm of connect's
   * report, where the plugin has no code to name and surfaces the server's sentence alone.
   */
  code?: string;
  /** Replies that get the plugin as far as that command, over {@link DEFAULT_REPLIES}. */
  replies?: Record<string, string>;
  /**
   * True when the RESP code is not the reply's to choose. `serverRefusal` admits only a PERMANENT
   * code onto this path, so a server cannot reach it with text of its own at offset 0 — which is
   * what the impersonation axis needs, and why that axis skips this surface rather than grading a
   * reply the code under test could never see.
   */
  fixedCode?: true;
  observe: (plugin: RedisPlugin, url: string) => Promise<Observed>;
}

const connect = (plugin: RedisPlugin, url: string): Promise<void> =>
  plugin.connect({ url, connect_timeout_ms: FAST, block_ms: 100 });

const thrownBy = async (work: Promise<unknown>): Promise<Observed> => {
  const err = await work.then(
    () => undefined,
    (e: Error) => e,
  );
  return { text: err?.message ?? '', stack: err?.stack ?? '' };
};

const after = async (
  plugin: RedisPlugin,
  url: string,
  work: (p: RedisPlugin) => Promise<unknown>,
): Promise<Observed> => {
  await connect(plugin, url);
  return thrownBy(work(plugin));
};

/** The STOPPED line the read loop writes, captured off stderr rather than off a return value. */
async function stoppedLine(plugin: RedisPlugin, url: string): Promise<Observed> {
  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
  try {
    await connect(plugin, url);
    await plugin.subscribe(TOPIC, () => undefined);
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !written.some((line) => line.includes('STOPPED'))) {
      await new Promise((r) => setTimeout(r, 20));
    }
  } finally {
    process.stderr.write = original;
  }
  const line = written.find((l) => l.includes('STOPPED')) ?? '';
  expect(line, 'the read loop never reported that live delivery stopped').not.toBe('');
  expect(line.endsWith('\n'), 'the STOPPED line is not newline-terminated').toBe(true);
  return { text: line.slice(0, -1), stack: '' };
}

const surfaces: Array<[string, Surface]> = [
  ['connect', { refuses: 'ping', observe: (plugin, url) => thrownBy(connect(plugin, url)) }],
  [
    'connect, refused with a code that is not permanent',
    { refuses: 'ping', code: 'LOADING', observe: (plugin, url) => thrownBy(connect(plugin, url)) },
  ],
  [
    'post',
    {
      refuses: 'xadd',
      observe: (plugin, url) => after(plugin, url, (p) => p.post(TOPIC, asHandle('w'), 'hi')),
    },
  ],
  [
    'fetchRecent — the recent window',
    {
      refuses: 'xrevrange',
      observe: (plugin, url) => after(plugin, url, (p) => p.fetchRecent({ topic: TOPIC })),
    },
  ],
  [
    'fetchRecent — since a cursor',
    {
      refuses: 'xrange',
      observe: (plugin, url) =>
        after(plugin, url, (p) => p.fetchRecent({ topic: TOPIC, since: asCursor('1-0') })),
    },
  ],
  [
    'fetchRecent — the blocking long-poll',
    {
      refuses: 'xread',
      // The cursor has to be LIVE (below the stream's last generated id) or the self-heal answers
      // before the long-poll is ever reached, and this row would grade the heal instead.
      replies: { exists: ':1\r\n' },
      fixedCode: true,
      observe: (plugin, url) =>
        after(plugin, url, (p) =>
          p.fetchRecent({ topic: TOPIC, since: asCursor('1-0'), blockMs: 500 }),
        ),
    },
  ],
  [
    'subscribe',
    {
      refuses: 'exists',
      observe: (plugin, url) => after(plugin, url, (p) => p.subscribe(TOPIC, () => undefined)),
    },
  ],
  ['the live-delivery STOPPED log line', { refuses: 'xread', fixedCode: true, observe: stoppedLine }],
];

const impersonations: Array<[string, Reply]> = (await ownDiagnostics()).map((own) => {
  expect(own, 'a wording this axis impersonates was never produced').toMatch(/^parley-redis: /);
  return [`this plugin's own '${own.slice(0, 44)}…' at offset 0`, impersonating(own)];
});

const rows = surfaces.flatMap(([surfaceLabel, surface]) =>
  [...hostile, ...(surface.fixedCode === true ? [] : impersonations)].map(
    ([textLabel, reply]) =>
      [`${surfaceLabel} answered with ${textLabel}`, surface, reply] as [string, Surface, Reply],
  ),
);

describe('redis failure modes — server-supplied text never lands raw in a log or a tool result', () => {
  it.each(rows)('%s', async (_label, surface, reply) => {
    const [code, text] = reply(SECRET, surface.code ?? 'WRONGTYPE');
    const endpoint = await respEndpoint((argv) => {
      const command = commandOf(argv);
      if (command === surface.refuses) return respError(code, text);
      return surface.replies?.[command] ?? DEFAULT_REPLIES[command] ?? '+OK\r\n';
    });
    const plugin = new RedisPlugin();
    try {
      const observed = await surface.observe(
        plugin,
        endpoint.url.replace('//', `//parley:${SECRET}@`),
      );
      expect(observed.text, 'the server text never reached the caller at all').toContain(MARK);
      expectSafeFromServer('the reported text', observed.text, SECRET);
      expect(observed.stack, "the error's stack carries the credential").not.toContain(SECRET);
    } finally {
      await plugin.disconnect().catch(() => undefined);
      endpoint.close();
    }
  });
});
