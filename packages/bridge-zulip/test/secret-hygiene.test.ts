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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { ZulipPlugin } from '../src/index.js';

const SOURCE = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8');

const CONFIG_KEYS = ((): string[] => {
  const body = /export interface ZulipBackendConfig \{([\s\S]*?)\n\}/.exec(SOURCE)?.[1] ?? '';
  return [...body.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1] as string);
})();

/** A key whose value is a credential. Matched on the NAME so a future secret is covered on arrival. */
const SECRET_KEY = /key|secret|token|password|credential/i;

const SENTINEL = 'sup3r-s3cret-sentinel';
/** Digits, because a YAML `api_key: 1234567890` is the shape that reaches the value echo. */
const NUMERIC_SENTINEL = 987654321987;

/** Shapes `connect()` refuses; `leak` is the substring that must not survive into any message. */
const REJECTED_SHAPES: Array<{ name: string; value: unknown; leak?: string }> = [
  { name: 'a bare number', value: NUMERIC_SENTINEL, leak: String(NUMERIC_SENTINEL) },
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
  it('every declared backend_config key was parsed out of the source', () => {
    expect(CONFIG_KEYS).toEqual(['site_url', 'email', 'api_key', 'stream', 'events_timeout_ms']);
  });

  it('at least one declared key is a credential, so the secret rows are not vacuous', () => {
    expect(CONFIG_KEYS.filter((k) => SECRET_KEY.test(k))).not.toEqual([]);
  });
});

describe('a rejected config value never discloses a secret', () => {
  for (const key of CONFIG_KEYS) {
    const secret = SECRET_KEY.test(key);
    it(`${key} is ${secret ? 'reported by shape' : 'echoed as the diagnostic'}`, async () => {
      for (const shape of REJECTED_SHAPES) {
        const where = `${key} = ${shape.name}`;
        const outcome = await attempt(key, shape.value);
        if (outcome.rejected) expect(outcome.readable, where).toContain(key);
        if (shape.leak === undefined) continue;
        if (secret) expect(outcome.readable, where).not.toContain(shape.leak);
        else if (outcome.rejected) expect(outcome.readable, where).toContain(shape.leak);
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

  it('a rejected credential still reports enough to debug: its type and its length', async () => {
    const outcome = await attempt('api_key', NUMERIC_SENTINEL);
    expect(outcome.readable).toContain('a number');
    const string = await attempt('api_key', '   ');
    expect(string.readable).toContain('a 3-character string');
  });
});
