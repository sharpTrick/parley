/**
 * CLASS: nothing a person or a model can read may contain a configured secret. A `connect()`
 * rejection is printed to stderr as `err.stack` by `src/cli.ts` and handed back by core as an
 * `isError` tool result — i.e. straight into model context — so a mistyped `api_key` (a bare number
 * in YAML, an accidentally-nested object) must be reported by SHAPE, never by value. The same
 * message must still name the offending key, or the operator cannot act on it.
 *
 * The key list is read from the source's own `ZulipBackendConfig`, so a `backend_config` secret added
 * later is graded the day it is declared rather than the day someone remembers this file exists.
 */
import { describe, expect, it, vi } from 'vitest';
import { ZulipPlugin } from '../src/index.js';
import { DECLARED_CONFIG_KEYS, DECLARED_CONFIG_TYPES } from './harness.js';

/**
 * The declared type of each key decides what a REJECTION may echo: a value of the declared type is
 * the diagnostic, and a value of any other type is a mis-paste whose type says everything useful —
 * echoing its content is how a credential pasted into the wrong key reaches stderr and model
 * context.
 */
const CONFIG_TYPES = DECLARED_CONFIG_TYPES;
const CONFIG_KEYS = DECLARED_CONFIG_KEYS;

/** A key whose value is a credential. Matched on the NAME so a future secret is covered on arrival. */
const SECRET_KEY = /key|secret|token|password|credential/i;

const SENTINEL = 'sup3r-s3cret-sentinel';
/** Digits, because a YAML `api_key: 1234567890` is the shape that reaches the value echo. */
const NUMERIC_SENTINEL = 987654321987;

/** Shapes `connect()` refuses; `leak` is the substring that must not survive into any message. */
const REJECTED_SHAPES: Array<{ name: string; value: unknown; leak?: string }> = [
  { name: 'a bare number', value: NUMERIC_SENTINEL, leak: String(NUMERIC_SENTINEL) },
  // A number every key rejects, so the ECHO half of the rule below is exercised and not merely
  // asserted absent: a `number` key must still print the number that is wrong.
  { name: 'a negative number', value: -NUMERIC_SENTINEL, leak: String(NUMERIC_SENTINEL) },
  { name: 'a nested object', value: { token: SENTINEL }, leak: SENTINEL },
  { name: 'an array', value: [SENTINEL], leak: SENTINEL },
  { name: 'null', value: null },
  { name: 'a boolean', value: true },
  { name: 'an empty string', value: '' },
  { name: 'whitespace only', value: '   ' },
];

interface Outcome {
  rejected: boolean;
  /** Everything the operator or the model could end up reading from this attempt. */
  readable: string;
}

async function attempt(key: string, value: unknown): Promise<Outcome> {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    await new ZulipPlugin().connect({ site_url: 'https://z.example.com', [key]: value });
    return { rejected: false, readable: logged(warn, error) };
  } catch (err) {
    const e = err as Error;
    return { rejected: true, readable: [e.message, e.stack, logged(warn, error)].join('\n') };
  } finally {
    vi.restoreAllMocks();
  }
}

const logged = (...spies: Array<{ mock: { calls: unknown[][] } }>): string =>
  spies.flatMap((s) => s.mock.calls.map((c) => String(c[0]))).join('\n');

describe('the config surface this test grades is the one the source declares', () => {
  it('every declared backend_config key and its type was parsed out of the source', () => {
    expect(CONFIG_TYPES).toEqual({
      site_url: 'string',
      email: 'string',
      api_key: 'string',
      stream: 'string',
      events_timeout_ms: 'number',
    });
  });

  it('at least one declared key is a credential, so the secret rows are not vacuous', () => {
    expect(CONFIG_KEYS.filter((k) => SECRET_KEY.test(k))).not.toEqual([]);
  });
});

describe('a rejected config value never discloses a secret', () => {
  for (const key of CONFIG_KEYS) {
    const secret = SECRET_KEY.test(key);
    const verdict = secret
      ? 'is reported by shape whatever its type'
      : `echoes a rejected ${CONFIG_TYPES[key]} and reports every other type by shape`;
    it(`${key} ${verdict}`, async () => {
      for (const shape of REJECTED_SHAPES) {
        const where = `${key} = ${shape.name}`;
        const outcome = await attempt(key, shape.value);
        if (outcome.rejected) expect(outcome.readable, where).toContain(key);
        if (shape.leak === undefined) continue;
        const echoes = !secret && typeof shape.value === CONFIG_TYPES[key];
        if (echoes && outcome.rejected) expect(outcome.readable, where).toContain(shape.leak);
        else expect(outcome.readable, where).not.toContain(shape.leak);
      }
    });
  }

  it('a credential key rejects every shape in the table, so the rows above all fire', async () => {
    for (const key of CONFIG_KEYS.filter((k) => SECRET_KEY.test(k))) {
      for (const shape of REJECTED_SHAPES) {
        expect((await attempt(key, shape.value)).rejected, `${key} = ${shape.name}`).toBe(true);
      }
    }
  });

  /**
   * Classification by key NAME cannot see a credential smuggled into a key it calls harmless, and a
   * URL carries three places one can ride along in. Every declared key meets every hiding place; the
   * sentinel must reach nothing readable whether the value is accepted or rejected. `site_url` — the
   * only key whose value is ECHOED when accepted — also declares what must still be said about it,
   * so a cell cannot pass by the plugin having gone silent.
   */
  const SENTINEL_URLS: Array<{ where: string; value: string; siteUrl: 'rejected' | 'warned' }> = [
    { where: 'URL userinfo', value: `http://bot:${SENTINEL}@zulip.example.com`, siteUrl: 'rejected' },
    { where: 'a query value', value: `http://zulip.example.com/?token=${SENTINEL}`, siteUrl: 'rejected' },
    { where: 'a fragment', value: `http://zulip.example.com/#${SENTINEL}`, siteUrl: 'rejected' },
    { where: 'an unparseable URL', value: `http://bot:${SENTINEL}@`, siteUrl: 'rejected' },
    { where: 'a path segment', value: `http://zulip.example.com/bot:${SENTINEL}/`, siteUrl: 'warned' },
  ];

  for (const hiding of SENTINEL_URLS) {
    it(`a secret hidden in ${hiding.where} of any key reaches nothing readable`, async () => {
      for (const key of CONFIG_KEYS) {
        const outcome = await attempt(key, hiding.value);
        expect(outcome.readable, `${key} = ${hiding.where}`).not.toContain(SENTINEL);
        if (key !== 'site_url') continue;
        expect(outcome.rejected, hiding.where).toBe(hiding.siteUrl === 'rejected');
        expect(outcome.readable, hiding.where).toContain(
          hiding.siteUrl === 'rejected' ? 'site_url' : 'plaintext http://',
        );
      }
    });
  }

  it('a rejected credential still reports enough to debug: its type and its length', async () => {
    const outcome = await attempt('api_key', NUMERIC_SENTINEL);
    expect(outcome.readable).toContain('a number');
    const string = await attempt('api_key', '   ');
    expect(string.readable).toContain('a 3-character string');
  });
});
