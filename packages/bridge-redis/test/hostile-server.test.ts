import { asCursor, asHandle, asTopic } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { MAX_ERROR_BODY } from '@sharptrick/parley-net-util';
import {
  reportLiveDeliveryDegraded,
  reportLiveDeliveryResumed,
  reportLiveDeliveryStopped,
} from '../src/diagnostics.js';
import { CONFIG_KEYS, DEFAULT_URL, RedisPlugin } from '../src/index.js';
import {
  commandOf,
  DEFAULT_REPLIES,
  expectSafeFromServer,
  expectSafeText,
  respEndpoint,
  respError,
  SECRET,
} from './resp-server.js';
import { FAST_MS as FAST, freeEndpoint } from './support.js';

// CLASS: a string THIS PLUGIN DID NOT AUTHOR reaches an operator's log or an MCP tool result
// unchanged. A thrown seam error is rendered by core as an `isError` result — model context — and
// the live-push diagnostic is a line in the operator's terminal, so anything that lands in either
// has to be bounded, stripped of the characters that forge line structure, and — where the plugin
// itself holds the secret — swept of it.
//
// The text arrives on more than one CHANNEL, and a fix applied to one is not a fix. The server's
// RESP reply is graded by the first describe below; the caller's topic and cursor (bare
// `z.string()` from an MCP client — the model, or a remote chat peer in the OAuth deployment) and a
// rejected `backend_config` value are graded by the second, against the same hostile-text table.
//
// The server half has three axes:
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

/**
 * The hostile text itself, apart from the channel it arrives on. Shared, so that a channel added
 * below inherits every shape at once rather than the subset its author thought of.
 */
const hostileText: Array<[string, (secret: string) => string]> = [
  ['an over-long body', () => 'A'.repeat(5000)],
  ['an ANSI colour escape', () => 'red\u001B[31m text'],
  ['a C1 control', () => 'csi\u009B31m text'],
  ['a NEL line break', () => 'forged\u0085parley-redis: all clear'],
  ['a line separator', () => 'forged\u2028parley-redis: all clear'],
  ['a paragraph separator', () => 'forged\u2029parley-redis: all clear'],
  ['a bidi override', () => 'flip\u202Ereversed'],
  ['a NUL byte', () => 'split\u0000here'],
  ['a DEL', () => 'del\u007Fhere'],
  ['a zero-width joiner', () => 'zwj\u200Dhere'],
  ['the credential', (secret) => `your password is ${secret}`],
  ['the credential ahead of an over-long body', (secret) => `${secret} ${'A'.repeat(5000)}`],
];

const hostile: Array<[string, Reply]> = hostileText.map(([label, mint]) => [label, body(mint)]);

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
/**
 * Everything `work` writes to stderr. Keep the restore in a `finally`, so that a row which throws
 * cannot leave the hijack in place and silence every later row's diagnostics.
 */
async function capturingStderr(work: (written: string[]) => Promise<void> | void): Promise<string[]> {
  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
  try {
    await work(written);
  } finally {
    process.stderr.write = original;
  }
  return written;
}

async function stoppedLine(plugin: RedisPlugin, url: string, topic = TOPIC): Promise<Observed> {
  const written = await capturingStderr(async (lines) => {
    await connect(plugin, url);
    await plugin.subscribe(topic, () => undefined);
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !lines.some((line) => line.includes('STOPPED'))) {
      await new Promise((r) => setTimeout(r, 20));
    }
  });
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

// ---------------------------------------------------------------------------------------------
// The CALLER's half of the same class. `topic` and `since` reach this plugin as bare `z.string()`
// (bridge-core/src/transport/tools.ts), and a `backend_config` value can carry the operator's own
// password — so all three are untrusted text on a second route into the identical sinks. Every
// channel below is crossed with the same `hostileText` table the server half uses, so a shape added
// there is graded on every channel at once.
//
// Boundedness is graded as GROWTH-INVARIANCE rather than against a fixed ceiling: `labelled()`
// legitimately embeds three bounded fields (the server's text, the caller's topic, and the key
// derived from it — 6,216 characters against a 50KB topic and a 40KB reply, measured), so a ceiling
// written for one field would have to be loosened for it and would then stop grading the others,
// and a ceiling written for three would cement how many fields a message happens to carry. Padding
// both probes past the cap makes the check bite on every row, not just the long ones.
// ---------------------------------------------------------------------------------------------

/** Prefixed to every caller-supplied payload; if it does not survive, the row graded nothing. */
const ECHOED = 'echoed-back-verbatim';

interface CallerChannel {
  /** Drive the plugin with `hostile` where a caller controls it; return what the plugin composed. */
  observe: (hostile: string) => Promise<string>;
  /** The plugin still names the fault, so a row cannot pass on a message that says nothing. */
  names: RegExp;
  /**
   * False where the channel must echo NOTHING of the value — a rejected `url`, which can carry a
   * password, and any value a CONTAINER holds. The row then asserts {@link ECHOED} is ABSENT, so
   * that a channel cannot pass by quietly having started to echo it.
   */
  echoes?: false;
}

const said = (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => '',
    (err: Error) => err.message,
  );

/** A refusal the plugin has to label, so the caller's topic and key reach `labelled()`'s message. */
async function refusedFetch(topic: string): Promise<string> {
  const endpoint = await respEndpoint((argv) =>
    commandOf(argv) === 'xrevrange'
      ? respError('WRONGTYPE', 'Operation against a key holding the wrong kind of value')
      : (DEFAULT_REPLIES[commandOf(argv)] ?? '+OK\r\n'),
  );
  const plugin = new RedisPlugin();
  try {
    await connect(plugin, endpoint.url);
    return await said(plugin.fetchRecent({ topic: asTopic(topic) }));
  } finally {
    await plugin.disconnect().catch(() => undefined);
    endpoint.close();
  }
}

/** The STOPPED stderr line for a hostile topic — the log sink, which no thrown error covers. */
async function stoppedLineFor(topic: string): Promise<string> {
  const endpoint = await respEndpoint((argv) =>
    commandOf(argv) === 'xread'
      ? respError('WRONGTYPE', 'Operation against a key holding the wrong kind of value')
      : (DEFAULT_REPLIES[commandOf(argv)] ?? '+OK\r\n'),
  );
  const plugin = new RedisPlugin();
  try {
    const observed = await stoppedLine(plugin, endpoint.url, asTopic(topic));
    return observed.text;
  } finally {
    await plugin.disconnect().catch(() => undefined);
    endpoint.close();
  }
}

/** One diagnostic line, captured off stderr with its terminator checked and then stripped. */
async function loggedLine(write: () => void): Promise<string> {
  const line = (await capturingStderr(() => write())).join('');
  expect(line, 'nothing was written to stderr at all').not.toBe('');
  expect(line.endsWith('\n'), 'the diagnostic line is not newline-terminated').toBe(true);
  return line.slice(0, -1);
}

/** The plugin's own default endpoint — nothing here connects to it; the log lines only name it. */
const BENIGN_URL = DEFAULT_URL;

const callerChannels: Array<[string, CallerChannel]> = [
  [
    "the caller's cursor",
    {
      observe: (hostile) =>
        said(new RedisPlugin().fetchRecent({ topic: TOPIC, since: asCursor(hostile) })),
      names: /parley-redis: malformed cursor/,
    },
  ],
  [
    "the caller's topic, rejecting a cursor",
    {
      observe: (hostile) =>
        said(
          new RedisPlugin().fetchRecent({
            topic: asTopic(hostile),
            since: asCursor('not-an-entry-id'),
          }),
        ),
      names: /parley-redis: malformed cursor/,
    },
  ],
  [
    "the caller's topic, labelling a server refusal",
    { observe: refusedFetch, names: /parley-redis: WRONGTYPE/ },
  ],
  [
    "the caller's topic, in the live-delivery STOPPED line",
    { observe: stoppedLineFor, names: /live delivery STOPPED/ },
  ],
  [
    "the caller's topic, in the STOPPED line as composed",
    {
      observe: (hostile) =>
        loggedLine(() => reportLiveDeliveryStopped(BENIGN_URL, asTopic(hostile), 'ERR nope')),
      names: /live delivery STOPPED/,
    },
  ],
  [
    "the caller's topic, in the DEGRADED line",
    {
      observe: (hostile) =>
        loggedLine(() => reportLiveDeliveryDegraded(BENIGN_URL, asTopic(hostile), 3, 'socket gone')),
      names: /live delivery DEGRADED/,
    },
  ],
  [
    "the caller's topic, in the RESUMED line",
    {
      observe: (hostile) =>
        loggedLine(() => reportLiveDeliveryResumed(BENIGN_URL, asTopic(hostile), 3)),
      names: /live delivery RESUMED/,
    },
  ],
  // Two families per knob, because the two halves of the disclosure rule pull opposite ways.
  // A value the operator WROTE is echoed back bounded and flattened, so a typo is diagnosable. A
  // value a CONTAINER holds is never echoed at all: the branch that reaches the renderer is "not a
  // non-empty string", which admits every container a password can be nested inside, and enumerating
  // one puts that password in the log. `url` is on the silent side under both, since it is the one
  // value that carries a credential as a plain string.
  ...CONFIG_KEYS.map(
    (knob): [string, CallerChannel] => [
      `a rejected backend_config.${knob} wrapped in an array`,
      {
        observe: (hostile) => said(new RedisPlugin().connect({ [knob]: [hostile] })),
        names: new RegExp(`parley-redis: ${knob} must`),
        echoes: false as const,
      },
    ],
  ),
  // `key_prefix` is absent: any non-empty string is a legal prefix, so there is no refusal to grade.
  ...(['url', 'block_ms', 'connect_timeout_ms', 'retention_days'] as const).map(
    (knob): [string, CallerChannel] => [
      `a rejected backend_config.${knob} written as a string`,
      {
        observe: (hostile) => said(new RedisPlugin().connect({ [knob]: hostile })),
        names: new RegExp(`parley-redis: ${knob} must`),
        ...(knob === 'url' ? { echoes: false as const } : {}),
      },
    ],
  ),
];

const callerRows = callerChannels.flatMap(([channelLabel, channel]) =>
  hostileText.map(
    ([textLabel, mint]) =>
      [`${channelLabel} carrying ${textLabel}`, channel, mint] as [
        string,
        CallerChannel,
        (secret: string) => string,
      ],
  ),
);

describe('redis failure modes — caller-supplied text never lands raw in a log or a tool result', () => {
  it.each(callerRows)('%s', async (_label, channel, mint) => {
    const payload = `${ECHOED} ${mint(SECRET)}`;
    const plain = await channel.observe(payload);
    expect(plain, 'the plugin did not name the fault at all').toMatch(channel.names);
    if (channel.echoes === false) {
      expect(plain, 'a value that must never be echoed was echoed').not.toContain(ECHOED);
    } else {
      expect(plain, 'the caller text never reached the message at all').toContain(ECHOED);
    }
    expectSafeText('the reported text', plain);

    // Both probes are padded past the cap, so equal lengths mean CLAMPED rather than merely equal.
    const padded = (times: number): string => `${payload}${'A'.repeat(MAX_ERROR_BODY * times)}`;
    const small = await channel.observe(padded(2));
    const large = await channel.observe(padded(20));
    expectSafeText('the reported text, padded', small);
    expect(large.length, 'the message grows with the length of the caller-supplied text').toBe(
      small.length,
    );
  });
});
