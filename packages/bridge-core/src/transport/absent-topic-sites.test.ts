import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { Allowlist } from '../allowlist.js';
import { catchUpAll, catchUpTopic } from '../engine/catchup.js';
import type { ReadStateStore } from '../engine/read-state.js';
import { SeenSet } from '../engine/seen-set.js';
import { asHandle, asTopic } from '../message.js';
import * as surface from '../index.js';
import { NoSuchTopicError } from '../no-such-topic.js';
import type { BackendPlugin } from '../seam.js';
import { FetchAbortedError } from '../engine/blocking-fetch.js';
import { FakePlugin } from '../testing/fake-plugin.js';
import { memoryReadState } from '../testing/nonconformant.js';
import { toolClient } from '../testing/tool-harness.js';
import { startPushLoop } from './push-loop.js';

/**
 * Every plugin depends on `@sharptrick/parley-core` as an ordinary dependency, so two installs in
 * one tree is a normal outcome — and then the absence sentinel a plugin throws is an instance of the
 * OTHER copy's class. Recognition therefore has to be by contract, at EVERY site: one site left on
 * `instanceof` reads "this chat channel does not exist yet" as a hard backend failure and bricks the
 * whole bridge on startup.
 *
 * Table the sites against the errors they must tell apart, and keep every other module in core out
 * of reach of the class binding a drift back to `instanceof` would need.
 */
const T = asTopic('ctx');

/** A second install of this package: identical contract, a different class object. */
class ForeignAbsence extends Error {
  constructor(readonly topic: string) {
    super(`no such topic: ${JSON.stringify(topic)}`);
    this.name = 'NoSuchTopicError';
  }
}

type Outcome = 'degraded' | 'propagated';

const ERRORS = {
  'the native sentinel': (): never => {
    throw new NoSuchTopicError('ctx');
  },
  'a foreign twin from a duplicate install': (): never => {
    throw new ForeignAbsence('ctx');
  },
  'a generic backend failure': (): never => {
    throw new Error('backend on fire');
  },
} as const;

const EXPECTED: Record<keyof typeof ERRORS, Outcome> = {
  'the native sentinel': 'degraded',
  'a foreign twin from a duplicate install': 'degraded',
  'a generic backend failure': 'propagated',
};

/** A plugin whose named seam method fails; everything else behaves. */
function failingOn(method: 'fetchRecent' | 'subscribe', fail: () => never): BackendPlugin {
  const plugin = new FakePlugin();
  plugin[method] = async (): Promise<never> => fail();
  return plugin;
}

async function settled(work: Promise<unknown>): Promise<Outcome> {
  return work.then(
    () => 'degraded' as Outcome,
    () => 'propagated' as Outcome,
  );
}

async function toolOutcome(tool: string, args: Record<string, unknown>, fail: () => never): Promise<Outcome> {
  const { client } = await toolClient({
    plugin: failingOn('fetchRecent', fail),
    topics: ['ctx'],
  });
  const res = (await client.callTool({ name: tool, arguments: args })) as { isError?: boolean };
  return res.isError === true ? 'propagated' : 'degraded';
}

const SITES: Array<[name: string, run: (fail: () => never) => Promise<Outcome>]> = [
  [
    'catchUpTopic',
    (fail) =>
      settled(
        catchUpTopic({
          plugin: failingOn('fetchRecent', fail),
          topic: T,
          limit: 10,
          readState: memoryReadState() as unknown as ReadStateStore,
          seen: new SeenSet(),
        }),
      ),
  ],
  [
    'catchUpTopic resuming from a stored cursor',
    (fail) => {
      const readState = memoryReadState();
      readState.set(T, '7' as never);
      return settled(
        catchUpTopic({
          plugin: failingOn('fetchRecent', fail),
          topic: T,
          limit: 10,
          readState: readState as unknown as ReadStateStore,
          seen: new SeenSet(),
        }),
      );
    },
  ],
  [
    'catchUpAll',
    (fail) =>
      settled(
        catchUpAll({
          plugin: failingOn('fetchRecent', fail),
          topics: [T, asTopic('ops')],
          limit: 10,
          readState: memoryReadState() as unknown as ReadStateStore,
          seen: new SeenSet(),
        }),
      ),
  ],
  [
    'startPushLoop',
    (fail) =>
      settled(
        startPushLoop(
          { server: { notification: async (): Promise<void> => {} } } as unknown as McpServer,
          failingOn('subscribe', fail),
          new Allowlist(['ctx']),
          new SeenSet(),
          { mentionFilter: false, identity: asHandle('alice') },
        ),
      ),
  ],
  ['parley_fetch_recent', (fail) => toolOutcome('parley_fetch_recent', { topic: 'ctx' }, fail)],
  [
    'parley_fetch_recent (long-poll)',
    (fail) => toolOutcome('parley_fetch_recent', { topic: 'ctx', since: '1', block_ms: 200 }, fail),
  ],
];

describe('every absent-topic site recognises the sentinel by contract, not by class identity', () => {
  it('the foreign twin really is foreign (otherwise every row below proves nothing)', () => {
    expect(new ForeignAbsence('ctx') instanceof NoSuchTopicError).toBe(false);
  });

  for (const [site, run] of SITES) {
    it.each(Object.keys(ERRORS) as Array<keyof typeof ERRORS>)(`${site} × %s`, async (kind) => {
      expect(await run(ERRORS[kind])).toBe(EXPECTED[kind]);
    });
  }
});

/**
 * Cancellation is the same problem in a different costume: `FetchAbortedError` crosses from the
 * long-poll wrapper to the tool handler, so a tree with two installs of this package hands the
 * handler a foreign twin — and an `instanceof` check then renders a client hanging up as a backend
 * failure. Table both copies against both call shapes.
 */
describe('a cancelled long-poll is recognised by contract, not by class identity', () => {
  class ForeignCancellation extends Error {
    constructor() {
      super('fetch_recent cancelled before any page was read');
      this.name = 'FetchAbortedError';
    }
  }

  const CANCELLATIONS = {
    'the native cancellation': (): never => {
      throw new FetchAbortedError();
    },
    'a foreign twin from a duplicate install': (): never => {
      throw new ForeignCancellation();
    },
  } as const;

  it('the foreign twin really is foreign (otherwise every row below proves nothing)', () => {
    expect(new ForeignCancellation() instanceof FetchAbortedError).toBe(false);
  });

  const SHAPES: Array<[name: string, args: Record<string, unknown>]> = [
    ['a plain read', { topic: 'ctx' }],
    ['a long-poll', { topic: 'ctx', block_ms: 200 }],
    ['a long-poll resuming from a cursor', { topic: 'ctx', since: '1', block_ms: 200 }],
  ];

  for (const [shape, args] of SHAPES) {
    it.each(Object.keys(CANCELLATIONS) as Array<keyof typeof CANCELLATIONS>)(
      `${shape} × %s answers with an empty window`,
      async (kind) => {
        expect(await toolOutcome('parley_fetch_recent', args, CANCELLATIONS[kind])).toBe('degraded');
      },
    );
  }
});

describe('no production site in bridge-core recognises a sentinel by class identity', () => {
  const SRC = new URL('..', import.meta.url).pathname;

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return sources(full);
      return full.endsWith('.ts') && !full.includes('.test.') ? [full] : [];
    });
  }

  const rel = (f: string): string => f.slice(SRC.length);

  /**
   * Every error class this package declares, as [sentinel, the module that declares it]. DERIVED
   * from the source, so the rule survives that module being renamed or moved, and so a sentinel
   * added later becomes a row rather than a rule nobody applied. An UNEXPORTED one counts too — it
   * cannot reach the surface check below, which is the point.
   */
  const SENTINELS = sources(SRC).flatMap((f) =>
    [...readFileSync(f, 'utf8').matchAll(/^\s*(?:export )?class (\w+) extends \w*Error\b/gm)].map(
      (m) => [m[1]!, rel(f)] as [string, string],
    ),
  );

  const errorsOnSurface = Object.entries(surface as Record<string, unknown>)
    .filter(([, v]) => typeof v === 'function' && Error.isPrototypeOf(v as object))
    .map(([name]) => name)
    .sort();

  /**
   * An error a consumer is told to distinguish is useless if the symbol never leaves the package:
   * `package.json` publishes only `.`, so a class missing from index.ts is uncatchable no matter
   * what its own JSDoc promises. Comparing the walk against the LOADED surface grades both
   * directions at once — a class that never reached index.ts, and a walk that has gone blind and is
   * therefore grading nothing below.
   */
  it('the source walk finds exactly the error classes this package exports', () => {
    expect(SENTINELS.map(([sentinel]) => sentinel).sort()).toEqual(errorsOnSurface);
  });

  const hasRecogniser = (sentinel: string): boolean =>
    typeof (surface as Record<string, unknown>)[`is${sentinel}`] === 'function';

  /**
   * Sentinels core RAISES. None of them ever arrives from a plugin, so no second install of this
   * package can hand core a twin to miss: `ConsentError` — the one that IS compared by class, in
   * auth/remote.ts — is compared against the binding the module it is constructed in exports, and
   * the other two are only thrown. A sentinel a PLUGIN can raise across the seam never belongs
   * here; it needs an `is…` recogniser on the public surface, and the rows below then keep its class
   * binding out of every module but its own.
   */
  const RAISED_BY_CORE_ONLY = ['ConsentError', 'TopicNotAllowedError', 'UnsafePatternError'];

  it('every sentinel has a by-contract recogniser, or is named as one core only raises', () => {
    expect(
      SENTINELS.map(([sentinel]) => sentinel)
        .filter((sentinel) => !hasRecogniser(sentinel))
        .sort(),
    ).toEqual(RAISED_BY_CORE_ONLY);
  });

  /**
   * `instanceof` needs the class BINDING, and a module reaches a binding only by importing it — so
   * banning the import bans the comparison whatever the operator (`instanceof`, `.constructor ===`)
   * and whatever the local alias. A type-only import erases before runtime and can reach no
   * operator, so it is not one. What recognition must DO is graded by the foreign-twin table above;
   * this keeps the shortcut out of reach.
   */
  function importsClassBinding(src: string, sentinel: string): boolean {
    for (const stmt of src.matchAll(/import\s+(type\s+)?(?:\*\s+as\s+(\w+)|\{([^}]*)\})\s*from/g)) {
      if (stmt[1] !== undefined) continue;
      if (stmt[2] !== undefined) {
        if (new RegExp(`\\b${stmt[2]}\\.${sentinel}\\b`).test(src)) return true;
        continue;
      }
      for (const spec of stmt[3]!.split(',')) {
        const imported = spec.trim();
        if (imported === '' || imported.startsWith('type ')) continue;
        if (imported.split(/\s+as\s+/)[0]!.trim() === sentinel) return true;
      }
    }
    return false;
  }

  it.each(SENTINELS.filter(([sentinel]) => hasRecogniser(sentinel)))(
    '%s is imported as a class binding only by %s',
    (sentinel, owner) => {
      const importers = sources(SRC)
        .filter((f) => rel(f) !== owner && importsClassBinding(readFileSync(f, 'utf8'), sentinel))
        .map(rel);
      expect(importers).toEqual([]);
    },
  );
});
