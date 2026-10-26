import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { xml } from '@xmpp/client';
import { MAX_ERROR_BODY } from '@sharptrick/parley-net-util';
import { FORBIDDEN_IN_RENDER, UNSAFE_TEXT } from '@sharptrick/parley-net-util/testing';
import { describe, expect, it } from 'vitest';
import {
  asError,
  codepointLabel,
  conditionOf,
  describeError,
  type El,
  JoinError,
  stanzaError,
} from '../src/stanzas.js';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

const sourceFiles = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(path, out);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(path);
  }
  return out;
};

/** Every name `stanzas.ts` exports — the vocabulary a diagnostic can be built out of. */
const stanzaExports = (): string[] => [
  ...new Set(
    [
      ...readFileSync(join(SRC, 'stanzas.ts'), 'utf8').matchAll(/export (?:const|function) (\w+)/g),
    ].map(([, name]) => name as string),
  ),
];

/**
 * Every place this plugin interpolates one of those exports into a message. Discovered rather than
 * listed: the version of this file that shipped carried four hand-written carriers, and both of the
 * paths that were actually leaking — the stream-error line and the re-join line — were among the
 * ones nobody had written down.
 */
function sinksInSource(): { site: string; helper: string }[] {
  const names = stanzaExports();
  const found: { site: string; helper: string }[] = [];
  for (const file of sourceFiles(SRC)) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        for (const name of names) {
          if (new RegExp(`\\$\\{[^}]*\\b${name}\\s*\\(`).test(line)) {
            found.push({ site: `${file.slice(SRC.length)}:${index + 1}`, helper: name });
          }
        }
      });
  }
  return found;
}

const errorStanza = (text: string, condition = 'forbidden'): El =>
  xml(
    'message',
    { type: 'error' },
    xml(
      'error',
      { type: 'auth' },
      xml(condition, { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' }),
      xml('text', { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' }, text),
    ),
  ) as unknown as El;

/**
 * How each discovered helper is driven with SERVER-written text. The sanitisation lives in the
 * helper rather than at the sites, so a helper that is clean makes every site behind it clean —
 * which is why the set of HELPERS, not the set of sites, is the thing that has to be exhaustive.
 */
const DRIVERS: Record<string, (text: string) => string> = {
  stanzaError: (text) => {
    const { condition, text: detail } = stanzaError(errorStanza(text));
    return `${condition} ${detail}`;
  },
  describeError: (text) => describeError(stanzaError(errorStanza(text))),
  asError: (text) => asError(new Error(text)).message,
  conditionOf: (text) => conditionOf(new Error(text)),
  codepointLabel: (text) => codepointLabel(text.codePointAt(0) ?? 0),
};

/**
 * CLASS: text the SERVER wrote reaching a thrown Error and an operator's stderr. A MUC states its
 * refusal in `<error><text>`, a stream teardown states it in `<stream:error><text>`, and nothing
 * about either is ours: it is echoed into a `post` rejection, a join failure, the stream-error line
 * and the re-join line — one of which core renders into model context. Unbounded and unflattened,
 * it can forge line structure in a log, hide a line behind a bidi override, or run to whatever
 * length the server chose.
 */
describe('server-supplied stanza text reaches nothing as one unbounded line', () => {
  it('drives every helper this plugin builds a message out of', () => {
    const sinks = sinksInSource();
    expect(
      sinks.length,
      'no interpolation was found at all — this scan grades nothing',
    ).toBeGreaterThan(3);
    expect(
      sinks.filter(({ helper }) => DRIVERS[helper] === undefined),
      'a message is built out of a helper no row below drives with server-written text',
    ).toEqual([]);
  });

  it('drives no helper this plugin no longer has', () => {
    const source = sourceFiles(SRC)
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    expect(
      Object.keys(DRIVERS).filter((helper) => !new RegExp(`\\b${helper}\\b`).test(source)),
      'this row grades a helper nothing in src/ has left',
    ).toEqual([]);
  });

  for (const [helper, drive] of Object.entries(DRIVERS)) {
    it.each(UNSAFE_TEXT)(`${helper} strips %s`, (_label, text) => {
      const line = drive(text);
      expect(line).not.toMatch(FORBIDDEN_IN_RENDER);
      expect(line).not.toMatch(/[\n\r]/);
      expect(line.length).toBeLessThan(MAX_ERROR_BODY + 256);
    });
  }

  it.each(UNSAFE_TEXT)('a join failure built from a server refusal strips %s', (_label, text) => {
    const { condition, text: detail } = stanzaError(errorStanza(text));
    const line = new JoinError(condition, 'room@conference.example', detail).message;
    expect(line).not.toMatch(FORBIDDEN_IN_RENDER);
    expect(line).not.toMatch(/[\n\r]/);
    expect(line.length).toBeLessThan(MAX_ERROR_BODY + 256);
  });

  it('still carries the words the server wrote, so the rows above are not asserting silence', () => {
    expect(describeError(stanzaError(errorStanza('you are banned')))).toContain('you are banned');
    expect(describeError(stanzaError(errorStanza('x', 'forbidden')))).toContain('forbidden');
    expect(asError(new Error('the stream is closing')).message).toBe('the stream is closing');
  });

  it('bounds a hostile CONDITION too, which is an element name the server chose', () => {
    const condition = 'x'.repeat(8192);
    const { condition: seen } = stanzaError(errorStanza('why', condition));
    expect(seen.length).toBeLessThanOrEqual(MAX_ERROR_BODY + 16);
  });

  /**
   * The join ladder retries on `err instanceof JoinError` (rooms.ts), so sanitising at the boundary
   * may not cost the class: a replacement Error would silently turn a retryable condition into an
   * unretryable one, and no assertion about a message could see it.
   */
  it('keeps a JoinError a JoinError, condition and all, after the boundary', () => {
    const long = new JoinError('conflict', 'room@conference.example', 'x'.repeat(8192));
    const seen = asError(long);
    expect(seen).toBeInstanceOf(JoinError);
    expect((seen as JoinError).condition).toBe('conflict');
    expect(seen.message.length).toBeLessThanOrEqual(MAX_ERROR_BODY + 16);
  });
});
