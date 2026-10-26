/**
 * CLASS: a wire shape restated in more than one test file is drift waiting to happen — correcting
 * the shape in one file leaves the other grading a body the server never produces, and both stay
 * green. The fault vocabulary therefore lives beside the fake that serves it ({@link FAULTS}), and
 * this lints every test file for an inline shape handed to a fault injector that another file also
 * spells out, so the check widens as fault shapes are added instead of pinning today's four.
 */
import { asTopic } from '@sharptrick/parley-core';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  type EventsFaultRow,
  type FakeZulip,
  FAULTS,
  PERSISTENT_EVENTS_FAULTS,
  TRANSIENT_EVENTS_FAULTS,
} from './fake-zulip.js';
import { HAZARD_FIELDS, HAZARDS, rand, useZulip } from './harness.js';

const TEST_DIR = fileURLToPath(new URL('./', import.meta.url));
const TEST_FILES = readdirSync(TEST_DIR).filter((f) => f.endsWith('.test.ts'));

/** Every fake entry point that takes a server fault; an argument literal to one is a wire shape. */
const INJECTORS = ['failRoute', 'hangRoute', 'rateLimit', 'holdResponse'] as const;

/** The argument text of each `injector(...)` call, quotes and nesting respected. */
function callArguments(source: string, injector: string): string[] {
  const out: string[] = [];
  const call = new RegExp(`\\b${injector}\\s*\\(`, 'g');
  for (let m = call.exec(source); m !== null; m = call.exec(source)) {
    let depth = 1;
    let quote = '';
    let i = m.index + m[0].length;
    for (; i < source.length && depth > 0; i++) {
      const ch = source[i] as string;
      if (quote !== '') {
        if (ch === '\\') i++;
        else if (ch === quote) quote = '';
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') quote = ch;
      else if (ch === '(' || ch === '{' || ch === '[') depth++;
      else if (ch === ')' || ch === '}' || ch === ']') depth--;
    }
    out.push(source.slice(m.index + m[0].length, i - 1));
  }
  return out;
}

/** Object literals inside one argument list, whitespace-normalized so formatting is not identity. */
function shapesIn(args: string): string[] {
  const shapes: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '{') continue;
    let depth = 0;
    let end = i;
    for (; end < args.length; end++) {
      if (args[end] === '{') depth++;
      else if (args[end] === '}' && --depth === 0) break;
    }
    shapes.push(args.slice(i, end + 1).replace(/\s+/g, ''));
    i = end;
  }
  return shapes;
}

/** shape → the files that spell it out inline. */
const INLINE_SHAPES = ((): Map<string, Set<string>> => {
  const found = new Map<string, Set<string>>();
  for (const file of TEST_FILES) {
    const source = readFileSync(`${TEST_DIR}${file}`, 'utf8');
    for (const injector of INJECTORS) {
      for (const args of callArguments(source, injector)) {
        for (const shape of shapesIn(args)) {
          found.set(shape, (found.get(shape) ?? new Set()).add(file));
        }
      }
    }
  }
  return found;
})();

describe('zulip test fixtures are shared, not restated', () => {
  it('finds the fault injections it lints, across more than one file', () => {
    const files = new Set([...INLINE_SHAPES.values()].flatMap((f) => [...f]));
    expect(INLINE_SHAPES.size).toBeGreaterThan(0);
    expect(files.size).toBeGreaterThan(1);
  });

  it('no fault shape is spelled out inline in two test files', () => {
    const restated = [...INLINE_SHAPES]
      .filter(([, files]) => files.size > 1)
      .map(([shape, files]) => `${[...files].join(' + ')}: ${shape}`);
    expect(restated).toEqual([]);
  });

  it('the shared vocabulary is the one the fake serves, and every entry is used', () => {
    const named = new Set(
      TEST_FILES.flatMap((file) => {
        const source = readFileSync(`${TEST_DIR}${file}`, 'utf8');
        return [...source.matchAll(/FAULTS\.(\w+)/g)].map((m) => m[1] as string);
      }),
    );
    const graded = new Set<string>(
      [...TRANSIENT_EVENTS_FAULTS, ...PERSISTENT_EVENTS_FAULTS].map((r) => r.key),
    );
    expect(Object.keys(FAULTS).filter((name) => !named.has(name) && !graded.has(name))).toEqual([]);
  });
});

/**
 * CLASS: a fault shape graded on only ONE axis ships as covered while its mirror property goes
 * unmeasured. A table that always injects `times: 1` grades survival-and-recovery and can never see
 * a hot spin; a table that always injects persistently grades pacing and can never see a loop that
 * fails to recover. The shapes are enumerated once and crossed with both axes, so this checks the
 * crossing rather than today's row list — a shape excluded from one axis fails here by name.
 */
describe('every zulip fault shape is graded on both axes', () => {
  const keysOf = (rows: EventsFaultRow[]): Set<string> => new Set(rows.map((r) => r.key));

  it('covers the whole vocabulary transiently and persistently', () => {
    const missing = (rows: EventsFaultRow[]): string[] =>
      Object.keys(FAULTS).filter((name) => !keysOf(rows).has(name));
    expect({
      transient: missing(TRANSIENT_EVENTS_FAULTS),
      persistent: missing(PERSISTENT_EVENTS_FAULTS),
    }).toEqual({ transient: [], persistent: [] });
  });

  it('the axes differ in persistence, not only in name', () => {
    expect({
      transientForever: TRANSIENT_EVENTS_FAULTS.filter((r) => r.failure.times === undefined).map(
        (r) => r.key,
      ),
      persistentOnce: PERSISTENT_EVENTS_FAULTS.filter((r) => r.failure.times !== undefined).map(
        (r) => r.key,
      ),
    }).toEqual({ transientForever: [], persistentOnce: [] });
  });
});

/**
 * CLASS: a fixture that SWALLOWS the hazard it injects grades its own filter, not the plugin. Every
 * cell of the hazard table is a PRECONDITION — {@link FakeZulip.injectRaw} promises the record
 * reaches the narrowed history read AND a queue narrowed to the topic, so one injection grades both
 * the catch-up and the push path — and a precondition has to fail HERE, by name, rather than
 * turning every plugin row that injects that shape into an assertion about a record the server
 * never sent.
 *
 * The count comes from the RAW HTTP bodies, never from the plugin's output: the plugin DROPS an
 * unusable record by design, so reading its output could not tell "the guard refused it" from "the
 * fixture withheld it" — which is exactly how a filter comparing an anchor against a non-numeric
 * `id` hid six of these shapes while sixteen rows reported them covered.
 */
describe('every hazard the fake injects is a record the fake serves', () => {
  const boot = useZulip();
  const AUTH = `Basic ${Buffer.from('parley-bot@localhost:parley-api-key').toString('base64')}`;

  const get = async (fake: FakeZulip, path: string, query: Record<string, string>): Promise<
    Record<string, unknown>
  > => {
    const res = await fetch(`${fake.url}${path}?${new URLSearchParams(query)}`, {
      headers: { Authorization: AUTH },
    });
    return (await res.json()) as Record<string, unknown>;
  };

  const register = async (fake: FakeZulip, topic: string): Promise<string> => {
    const res = await fetch(`${fake.url}/api/v1/register`, {
      method: 'POST',
      headers: { Authorization: AUTH, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        narrow: JSON.stringify([
          ['stream', 'parley'],
          ['topic', topic],
        ]),
        apply_markdown: 'false',
      }),
    });
    return String(((await res.json()) as { queue_id?: string }).queue_id);
  };

  it('serves every field × shape on the narrowed read and on the event queue', async () => {
    const { fake } = await boot();
    const missing: string[] = [];
    for (const field of HAZARD_FIELDS) {
      for (const hazard of HAZARDS) {
        const topic = `fidelity-${rand()}`;
        const queueId = await register(fake, topic);
        fake.injectRaw({ topic: asTopic(topic), fields: { [field]: hazard.value } });

        const read = await get(fake, '/api/v1/messages', {
          narrow: JSON.stringify([
            { operator: 'stream', operand: 'parley' },
            { operator: 'topic', operand: topic },
          ]),
          anchor: 'newest',
          include_anchor: 'true',
          num_before: '10',
          num_after: '0',
          apply_markdown: 'false',
        });
        const polled = await get(fake, '/api/v1/events', {
          queue_id: queueId,
          last_event_id: '-1',
          dont_block: 'true',
        });
        const served = (read.messages as unknown[] | undefined)?.length ?? 0;
        const pushed = (polled.events as Array<{ type?: string }> | undefined)?.filter(
          (e) => e.type === 'message',
        ).length;
        if (served !== 1) missing.push(`read: ${field} = ${hazard.name} (served ${served})`);
        if (pushed !== 1) missing.push(`queue: ${field} = ${hazard.name} (served ${String(pushed)})`);
      }
    }
    expect(missing).toEqual([]);
  }, 60_000);
});
