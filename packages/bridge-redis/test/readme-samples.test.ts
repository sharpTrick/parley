import { readFileSync } from 'node:fs';
import { asHandle, asTopic } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { RedisPlugin } from '../src/index.js';
import { commandOf, DEFAULT_REPLIES, respEndpoint, respError } from './resp-server.js';
import { endpointOf, FAST_MS as FAST, freeEndpoint } from './support.js';

// CLASS: a VERBATIM output sample in shipped prose that the code does not produce. The README is
// the only thing an operator has when they are grepping their logs or writing an alert regex, so a
// sample that differs from the format string by a pair of quotes matches nothing — and nothing was
// comparing the two: `readme.test.ts` grades the surrounding PROSE against a phrase, never the
// sample against a line the plugin really emits.
//
// The samples are EXTRACTED from the README rather than restated here, so a sample added or
// reworded later has no producer and fails loudly instead of shipping ungraded. Every line is
// produced by driving the real plugin against an in-process RESP fake, so nothing here can skip.

const text = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

/** The plugin's default `key_prefix`, which is what the README's key sample is written against. */
const TOPIC = asTopic('ctx-infra');

/** Whitespace is layout, not output: a sample the README wrapped across two lines is one line. */
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/**
 * Every backticked span in the README that quotes a line this plugin emits.
 *
 * Keep the fenced blocks out first, so that a ``` fence cannot shift the pairing of every inline
 * backtick after it and silently reduce this whole file to zero rows.
 */
function quotedSamples(md: string): string[] {
  return [...md.replace(/```[\s\S]*?```/g, '').matchAll(/`([^`]+)`/g)]
    .map((m) => oneLine(m[1] ?? ''))
    .filter((sample) => sample.startsWith('parley-redis:'));
}

const samples = quotedSamples(text);

/** A line the plugin really emitted, plus what the README's placeholders stood for in it. */
interface Produced {
  line: string;
  placeholders: Record<string, string>;
}

interface Producer {
  /** Which extracted sample this produces — every sample must match exactly one. */
  matches: RegExp;
  produce: () => Promise<Produced>;
}

const thrownBy = async (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => '',
    (err: Error) => err.message,
  );

/** Drive `body` with stderr captured, and hand back the first line matching `wanted`. */
async function stderrLine(wanted: RegExp, body: () => Promise<void>): Promise<string> {
  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
  try {
    await body();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !written.some((l) => wanted.test(l))) {
      await new Promise((r) => setTimeout(r, 20));
    }
  } finally {
    process.stderr.write = original;
  }
  const line = written.find((l) => wanted.test(l)) ?? '';
  expect(line, `the plugin never wrote a line matching ${String(wanted)}`).not.toBe('');
  return oneLine(line);
}

/** A connected plugin against a RESP fake answering `reply`, torn down however `body` ends. */
async function withFake<T>(
  reply: (argv: string[]) => string | undefined,
  body: (plugin: RedisPlugin, url: string) => Promise<T>,
): Promise<T> {
  const endpoint = await respEndpoint(
    (argv) => reply(argv) ?? DEFAULT_REPLIES[commandOf(argv)] ?? '+OK\r\n',
  );
  const plugin = new RedisPlugin();
  try {
    return await body(plugin, endpoint.url);
  } finally {
    await plugin.disconnect().catch(() => undefined);
    endpoint.close();
  }
}

/** A whole RESP error line (`<CODE> <text>`) as the fake must answer it. */
const respErrorOf = (full: string): string => {
  const [code = '', ...rest] = full.split(' ');
  return respError(code, rest.join(' '));
};

const REFUSAL = 'NOAUTH Authentication required.';
const WRONGTYPE = 'WRONGTYPE Operation against a key holding the wrong kind of value';
const NOPERM = 'NOPERM this user has no permissions to run the xread command';
const LOADING = 'LOADING Redis is loading the dataset in memory';

const producers: Producer[] = [
  {
    matches: /^parley-redis: cannot reach/,
    produce: async () => {
      const url = await freeEndpoint();
      const plugin = new RedisPlugin();
      const line = await thrownBy(plugin.connect({ url, connect_timeout_ms: FAST }));
      await plugin.disconnect().catch(() => undefined);
      return { line, placeholders: { '<host>:<port>': endpointOf(url) } };
    },
  },
  {
    matches: /^parley-redis: connected to .* refused a command/,
    produce: () =>
      withFake(
        (argv) => (commandOf(argv) === 'ping' ? respErrorOf(REFUSAL) : undefined),
        async (plugin, url) => ({
          line: await thrownBy(plugin.connect({ url, connect_timeout_ms: FAST })),
          placeholders: { '<host>:<port>': endpointOf(url), '<RESP error>': REFUSAL },
        }),
      ),
  },
  {
    matches: /^parley-redis: WRONGTYPE/,
    produce: () =>
      withFake(
        (argv) =>
          commandOf(argv) === 'xadd' ? respErrorOf(WRONGTYPE) : undefined,
        async (plugin, url) => {
          await plugin.connect({ url, connect_timeout_ms: FAST });
          return {
            line: await thrownBy(plugin.post(TOPIC, asHandle('w'), 'hi')),
            placeholders: {},
          };
        },
      ),
  },
  {
    matches: /^parley-redis: live delivery STOPPED/,
    produce: () =>
      withFake(
        (argv) => (commandOf(argv) === 'xread' ? respErrorOf(NOPERM) : undefined),
        async (plugin, url) => ({
          line: await stderrLine(/STOPPED/, async () => {
            await plugin.connect({ url, connect_timeout_ms: FAST, block_ms: 50 });
            await plugin.subscribe(TOPIC, () => undefined);
          }),
          placeholders: { '<topic>': TOPIC },
        }),
      ),
  },
  {
    matches: /^parley-redis: live delivery DEGRADED/,
    produce: () =>
      withFake(
        (argv) => (commandOf(argv) === 'xread' ? respErrorOf(LOADING) : undefined),
        async (plugin, url) => ({
          line: await stderrLine(/DEGRADED/, async () => {
            await plugin.connect({ url, connect_timeout_ms: FAST, block_ms: 50 });
            await plugin.subscribe(TOPIC, () => undefined);
          }),
          placeholders: { '<topic>': TOPIC },
        }),
      ),
  },
];

/**
 * The sample as a pattern: its placeholders filled in with what the run really used, its `…`
 * standing for the words the README elided, everything else matched literally. Anchored at the
 * start only — a sample is a quotable PREFIX of the line, never the whole of it.
 */
function patternFor(sample: string, placeholders: Record<string, string>): RegExp {
  let filled = sample;
  for (const [token, value] of Object.entries(placeholders)) filled = filled.split(token).join(value);
  const escaped = filled.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.split('…').join('.*')}`);
}

describe('bridge-redis README — every quoted output sample is a line the code produces', () => {
  it('quotes at least one sample, so the rows below are not vacuous', () => {
    expect(samples.length).toBeGreaterThan(0);
  });

  it.each(samples)('%s has exactly one producer', (sample) => {
    const owning = producers.filter((p) => p.matches.test(sample));
    expect(
      owning.length,
      `the README quotes a line no case here produces — register a producer for it, or the ` +
        `sample ships unchecked against the code that emits it`,
    ).toBe(1);
  });

  it.each(producers.map((p): [string, Producer] => [String(p.matches), p]))(
    'the sample it owns is still in the README: %s',
    (_label, producer) => {
      expect(
        samples.filter((s) => producer.matches.test(s)),
        'this producer owns no README sample, so it grades nothing',
      ).toHaveLength(1);
    },
  );

  it.each(producers.map((p): [string, Producer] => [String(p.matches), p]))(
    'the code emits it verbatim: %s',
    async (_label, producer) => {
      const sample = samples.find((s) => producer.matches.test(s)) ?? '';
      const produced = await producer.produce();
      expect(
        produced.line,
        `the README ships '${sample}', which nothing in the plugin's output matches — an operator ` +
          `grepping their logs for it, or writing an alert regex from it, finds nothing`,
      ).toMatch(patternFor(sample, produced.placeholders));
    },
  );
});
