import { asCursor, asTopic } from '@sharptrick/parley-core';
import { MAX_ERROR_BODY } from '@sharptrick/parley-net-util';
import { describe, expect, it } from 'vitest';
import type { FakeTelegram } from './fake-telegram.js';
import { ObservedStore } from '../src/store.js';
import { captureStderr, connectFresh, SENDER, startFake, storePath } from './rig.js';

// CLASS: a string THIS PLUGIN DID NOT AUTHOR reaches an operator's log or an MCP tool result
// unchanged. A thrown seam error is rendered by core as an `isError` result — model context — and a
// diagnostic is a line in the operator's terminal, so anything that lands in either has to be
// bounded and stripped of the characters line structure, ANSI colour and bidi reordering are forged
// out of. `wire.ts` already defends the half of this a Telegram server supplies; the half a CALLER
// supplies arrives on a second route into the identical sinks, and reached five of them raw: a
// topic spelled `ctx-a\nparley-telegram: SECURITY: …` wrote a whole second diagnostic line under
// this plugin's own prefix, and a 200,000-character topic made a 200,131-character Error.
//
// A topic, a cursor and a `limit` are bare `z.string()`/`z.number()` fields from an MCP client
// (bridge-core/src/transport/tools.ts) — the model, or a remote chat peer in the OAuth deployment —
// and `chat_map`/`poll_timeout_s` are values this plugin echoes out of a config it was handed. The
// axes are crossed: every CHANNEL below is driven with every HOSTILE TEXT, so a shape added to one
// table is graded on every channel at once and a channel added to the other inherits every shape.

/** Prefixed to every payload: if it does not survive, the row graded a swallowed value. */
const ECHOED = 'echoed-back-verbatim';

/** Every control (`Cc`) and format (`Cf`) character, plus the separators that are neither. */
const FORGES_LINE_STRUCTURE = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

/** A surrogate with no partner: it survives every escape, and nothing downstream can decode it. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * The hostile text itself, apart from the channel it arrives on. `JSON.stringify` — the escape a
 * reader reaches for first — escapes only the C0 controls of this list; C1, DEL, the bidi override,
 * the joiner and U+2028 all pass through it unchanged, and none of these sinks quote through it at
 * all.
 */
const HOSTILE_TEXT: Array<[string, () => string]> = [
  ['an over-long body', () => 'A'.repeat(5000)],
  ['an ANSI colour escape', () => 'red\u001B[31m text'],
  ['a newline under this plugin own prefix', () => 'forged\nparley-telegram: SECURITY: all clear'],
  ['a carriage return', () => 'forged\rparley-telegram: all clear'],
  ['a C1 control', () => 'csi\u009B31m text'],
  ['a NEL line break', () => 'forged\u0085parley-telegram: all clear'],
  ['a line separator', () => 'forged\u2028parley-telegram: all clear'],
  ['a paragraph separator', () => 'forged\u2029parley-telegram: all clear'],
  ['a bidi override', () => 'flip\u202Ereversed'],
  ['a NUL byte', () => 'split\u0000here'],
  ['a DEL', () => 'del\u007Fhere'],
  ['a zero-width joiner', () => 'zwj\u200Dhere'],
  ['a lone surrogate', () => 'half\uD800here'],
];

interface Channel {
  /**
   * Drive the plugin with `hostile` where a caller controls it; return what the plugin composed.
   * `stderr` holds everything written since this observation started — a log sink no thrown error
   * covers, and the one an operator reads.
   */
  observe: (fake: FakeTelegram, hostile: string, stderr: string[]) => Promise<string>;
  /** The plugin still names the fault, so a row cannot pass on a message that says nothing. */
  names: RegExp;
}

describe('telegram caller-supplied text never lands raw in a log or a tool result', () => {
  const BENIGN_TOPIC = asTopic('-1009555001');

  /** What a rejected call said, or '' — a row that resolves has graded nothing and says so. */
  const said = (work: Promise<unknown>): Promise<string> =>
    work.then(
      () => '',
      (err: Error) => err.message,
    );

  const CHANNELS: Array<[string, Channel]> = [
    [
      "the caller's topic, refusing to resolve it",
      {
        observe: async (fake, hostile) =>
          said((await connectFresh(fake)).fetchRecent({ topic: asTopic(hostile) })),
        names: /is not a Telegram chat id/,
      },
    ],
    [
      "the caller's topic, in the unresolved-topic diagnostic",
      {
        observe: async (fake, hostile, stderr) => {
          await said((await connectFresh(fake)).fetchRecent({ topic: asTopic(hostile) }));
          const line = stderr.find((l) => l.includes('resolves to no Telegram chat')) ?? '';
          expect(line, 'nothing was written to stderr at all').not.toBe('');
          expect(line.endsWith('\n'), 'the diagnostic line is not newline-terminated').toBe(true);
          return line.slice(0, -1);
        },
        names: /resolves to no Telegram chat/,
      },
    ],
    [
      "the caller's topic, rejecting a cursor",
      {
        observe: async (fake, hostile) =>
          said(
            (await connectFresh(fake)).fetchRecent({
              topic: asTopic(hostile),
              since: asCursor('not-a-cursor'),
            }),
          ),
        names: /malformed cursor/,
      },
    ],
    [
      "the caller's cursor",
      {
        observe: async (fake, hostile) =>
          said(
            (await connectFresh(fake)).fetchRecent({
              topic: BENIGN_TOPIC,
              since: asCursor(hostile),
            }),
          ),
        names: /malformed cursor/,
      },
    ],
    [
      "the caller's topic, rejecting a cursor that carries no store identity",
      {
        // A well-formed cursor, so the refusal reaches the wording that names BOTH of them — the
        // arms a malformed cursor never gets to, and the ones an operator is asked to act on.
        observe: async (fake, hostile) =>
          said(
            (await connectFresh(fake)).fetchRecent({
              topic: asTopic(hostile),
              since: asCursor('5'),
            }),
          ),
        names: /carries no store identity/,
      },
    ],
    [
      "the caller's topic, rejecting a cursor from another store",
      {
        observe: async (fake, hostile) =>
          said(
            (await connectFresh(fake)).fetchRecent({
              topic: asTopic(hostile),
              since: asCursor(`${'b'.repeat(16)}.5`),
            }),
          ),
        names: /was issued by a different/,
      },
    ],
    [
      "the caller's fetchRecent limit",
      {
        observe: async (fake, hostile) =>
          said(
            (await connectFresh(fake)).fetchRecent({
              topic: BENIGN_TOPIC,
              limit: hostile as unknown as number,
            }),
          ),
        names: /limit must be a finite number/,
      },
    ],
    [
      'a chat_map spelling, refused at connect',
      {
        observe: (fake, hostile) => said(connectFresh(fake, { chat_map: { mapped: hostile } })),
        names: /is not a Telegram chat id/,
      },
    ],
    [
      "the caller's topic, when Telegram files the post in another chat",
      {
        observe: async (fake, hostile) => {
          const plugin = await connectFresh(fake, { chat_map: { [hostile]: '-1009555002' } });
          // The one path that names the topic AFTER it resolved, so the topic has to be a mapped
          // spelling rather than a chat id: an upstream that files the message somewhere else.
          fake.spellChatId((id) => id + 1);
          return said(plugin.post(asTopic(hostile), SENDER, 'hi'));
        },
        names: /Telegram put the message in chat/,
      },
    ],
    [
      'a rejected observed-store retention bound',
      {
        observe: async (_fake, hostile) =>
          said(
            (async () => new ObservedStore(storePath(), hostile as unknown as number))(),
          ),
        names: /maxPerChat must be a positive integer/,
      },
    ],
    [
      'a rejected backend_config.poll_timeout_s',
      {
        observe: (fake, hostile) =>
          said(connectFresh(fake, { poll_timeout_s: hostile as unknown as number })),
        names: /poll_timeout_s must be an integer/,
      },
    ],
  ];

  const rows = CHANNELS.flatMap(([channel, spec]) =>
    HOSTILE_TEXT.map(
      ([text, mint]) => [`${channel}, carrying ${text}`, spec, mint] as [string, Channel, () => string],
    ),
  );

  it.each(rows)('%s', async (_label, channel, mint) => {
    const stderr = captureStderr();
    const fake = await startFake();
    const payload = `${ECHOED} ${mint()}`;
    /** One observation, against only the diagnostics THIS observation wrote. */
    const composed = (hostile: string): Promise<string> => {
      stderr.length = 0;
      return channel.observe(fake, hostile, stderr);
    };
    const plain = await composed(payload);

    expect(plain, 'the plugin did not name the fault at all').toMatch(channel.names);
    expect(plain, 'the caller text never reached the message at all').toContain(ECHOED);
    expect(
      FORGES_LINE_STRUCTURE.test(plain),
      'the reported text carries a control or format character',
    ).toBe(false);
    expect(LONE_SURROGATE.test(plain), 'the reported text carries a lone surrogate').toBe(false);
    expect(plain, 'the reported text carries the bot token').not.toContain(fake.token);

    // Boundedness as GROWTH-INVARIANCE rather than against a ceiling: a message legitimately
    // embeds more than one bounded field (a cursor AND the topic it was named for), so a ceiling
    // written for one would have to be loosened for those and would then stop grading the rest.
    // Both probes are padded past the cap, so equal lengths mean CLAMPED and not merely equal.
    const padded = (times: number): string => `${payload}${'A'.repeat(MAX_ERROR_BODY * times)}`;
    const small = await composed(padded(2));
    const large = await composed(padded(20));
    expect(
      FORGES_LINE_STRUCTURE.test(small),
      'the padded text carries a control or format character',
    ).toBe(false);
    expect(large.length, 'the message grows with the length of the caller-supplied text').toBe(
      small.length,
    );
  });
});
