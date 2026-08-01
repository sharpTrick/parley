import { asHandle, type Topic } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { CONFIG_KEYS, DEFAULT_URL, RedisPlugin } from '../src/index.js';
import { label, rejectedByKnob } from './config-fixtures.js';
import {
  endpointOf,
  freshPrefix,
  freshTopic as mintTopic,
  isRedisUp,
  REDIS_URL,
  wipe,
  withPlugin,
  withWriter,
  type Writer,
} from './support.js';

const freshTopic = (): Topic => mintTopic('live-config');

const redisUp = await isRedisUp(REDIS_URL);

// The inverse half of the validation class (the rejection matrix lives in failure-modes.test.ts): a
// value the docs call "unset" must still be accepted, or the validators have merely traded a silent
// misconfiguration for a config file that cannot load at all.

/**
 * What `null` must mean, per declared knob. Every knob but `url` is graded against the endpoint under
 * test; `url: null` selects the plugin's OWN default endpoint, which is NOT the one `PARLEY_REDIS_URL`
 * names — the override the README documents, and which the README's `--requirepass` guidance forces
 * you to use — so it is graded on clearing validation and falling back to that default instead.
 */
const nullOutcome: Record<string, 'connects' | 'falls back to the default endpoint'> = {
  url: 'falls back to the default endpoint',
  key_prefix: 'connects',
  block_ms: 'connects',
  connect_timeout_ms: 'connects',
  retention_days: 'connects',
};

describe.skipIf(!redisUp)('redis failure modes — an omitted-as-null knob still connects', () => {
  it.each(CONFIG_KEYS)('connect() accepts %s set to null', async (knob) => {
    const outcome = nullOutcome[knob];
    expect(outcome, `no null outcome is declared for '${knob}'`).toBeDefined();
    const plugin = new RedisPlugin();
    try {
      const failure = await plugin
        .connect({ ...(knob === 'url' ? {} : { url: REDIS_URL }), [knob]: null })
        .then(
          () => undefined,
          (err: Error) => err,
        );
      expect(failure?.message ?? '', `${knob}: null was rejected by validation`).not.toMatch(
        new RegExp(`parley-redis: ${knob} must|unknown backend_config key`),
      );
      if (outcome === 'connects') expect(failure).toBeUndefined();
      else if (failure !== undefined) expect(failure.message).toContain(endpointOf(DEFAULT_URL));
    } finally {
      await plugin.disconnect().catch(() => undefined);
    }
  });
});

// -------------------------------------------------------------------------------------------
// CLASS: a config knob whose only observable effect is on BACKEND STATE, graded solely by its
// negative direction. Every retention row used to assert history was KEPT — which a plugin that
// never sends the trim at all satisfies perfectly, so `retention_days` could be made a complete
// no-op with nothing red. Both directions are generated from one table below.
//
// The old entries are written at EXPLICIT ids by an independent writer, so "older than the window"
// is a property of the data rather than of how long the test slept, and the trim is triggered by
// one `post` through the plugin — the only thing that ever trims.
// -------------------------------------------------------------------------------------------

interface Retention {
  days: number | null | undefined;
  /** How far in the past the seeded entries' ids sit. */
  ageDays: number;
  /** Seeded entries, as a function of the server's stream node size — `~` trims whole nodes. */
  seeded: (nodeMax: number) => number;
  effect: 'trimmed' | 'kept';
}

/**
 * The server's `stream-node-max-entries`. `MINID ~` trims whole listpack nodes, so how many old
 * entries must be seeded before ANY of them can go is the server's setting, not a number this file
 * may assume.
 */
async function streamNodeMaxEntries(client: Writer): Promise<number> {
  const reported = Number((await client.configGet('stream-node-max-entries'))[
    'stream-node-max-entries'
  ]);
  expect(
    Number.isSafeInteger(reported) && reported > 1,
    `the server reported stream-node-max-entries=${reported}, so the rows below prove nothing`,
  ).toBe(true);
  return reported;
}

describe.skipIf(!redisUp)('redis failure modes — retention_days trims, and only what it must', () => {
  const rows: Array<[string, Retention]> = [
    [
      'a window shorter than the history trims it away',
      { days: 1, ageDays: 30, seeded: (n) => 2 * n, effect: 'trimmed' },
    ],
    [
      'a window that is not a whole number of milliseconds still trims',
      { days: 30 / 7, ageDays: 30, seeded: (n) => 2 * n, effect: 'trimmed' },
    ],
    [
      'a window longer than the history keeps every entry',
      { days: 30, ageDays: 1, seeded: (n) => 2 * n, effect: 'kept' },
    ],
    [
      'less than one node of expired entries is kept — the trim is approximate',
      { days: 1, ageDays: 30, seeded: (n) => n - 1, effect: 'kept' },
    ],
    [
      'omitted keeps every entry forever',
      { days: undefined, ageDays: 30, seeded: (n) => 2 * n, effect: 'kept' },
    ],
    [
      'null (DESIGN §11 "unset") keeps every entry forever',
      { days: null, ageDays: 30, seeded: (n) => 2 * n, effect: 'kept' },
    ],
  ];

  it.each(rows)('%s', async (_label, row) =>
    withPlugin({ retention_days: row.days }, ({ plugin, prefix }) =>
      withWriter(async (writer) => {
        const t = freshTopic();
        const key = `${prefix}${t}`;
        const seeded = row.seeded(await streamNodeMaxEntries(writer));
        const base = Date.now() - row.ageDays * 86_400_000;
        for (let i = 0; i < seeded; i++) {
          await writer.xAdd(key, `${base + i}-0`, { sender: 'w', content: `old${i}` });
        }
        await plugin.post(t, asHandle('w'), 'fresh');

        const remaining = await writer.xLen(key);
        const page = await plugin.fetchRecent({ topic: t, limit: 10_000 });
        if (row.effect === 'trimmed') {
          expect(
            remaining,
            `${seeded} entries ${row.ageDays} days old survived a ${row.days}-day window, so ` +
              `retention_days did nothing at all`,
          ).toBe(1);
          expect(page.messages.map((m) => m.content)).toEqual(['fresh']);
        } else {
          expect(
            remaining,
            `entries the ${String(row.days)}-day window covers were trimmed anyway`,
          ).toBe(seeded + 1);
          expect(page.messages).toHaveLength(seeded + 1);
          expect(page.messages[0]?.content).toBe('old0');
          expect(page.messages.at(-1)?.content).toBe('fresh');
        }
      }),
    ),
  );
});

// -------------------------------------------------------------------------------------------
// The inverse half of the knob class, and the half that actually catches a silent no-op: a value
// connect() ACCEPTS must leave every seam path working. Rejecting bad values is not enough — a knob
// that merely fails to be rejected can still make EVERY write fail behind a connect() that resolved,
// or disable live push, with nothing to see at load time.
//
// GENERATED per knob, not hand-picked: `retention_days` reaches XADD as `days * 86_400_000`, so
// whether a value works depends on its BINARY REPRESENTATION rather than its magnitude, and a fixed
// row can only ever sample the values that happen to land on a whole millisecond. One wide row per
// knob, so a failure names the offending value instead of hiding among green siblings.
// -------------------------------------------------------------------------------------------

/** Deterministic LCG, so a value that breaks the seam is reproducible on a re-run, not once in 50. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** Retention windows the validator accepts: small rationals (rarely whole ms) plus random floats. */
function retentionWindows(): number[] {
  const out: number[] = [0.5, 7, 30];
  for (let denom = 2; denom <= 13; denom++) {
    for (const numer of [1, denom + 1, 30]) out.push(numer / denom);
  }
  const rnd = seeded(0x5eed);
  for (let i = 0; i < 40; i++) out.push(0.001 + rnd() * 60);
  return out;
}

/** Whole-millisecond budgets in [lo, hi) — the only shape either millisecond knob accepts. */
function millisBudgets(seed: number, lo: number, hi: number): number[] {
  const rnd = seeded(seed);
  return Array.from({ length: 20 }, () => lo + Math.floor(rnd() * (hi - lo)));
}

/**
 * Values `connect()` accepts, per declared knob. Driven from CONFIG_KEYS below, so a knob added later
 * with no accepted-value set fails here instead of shipping a value nobody ever round-tripped.
 * `connect_timeout_ms` starts at 500, so that a budget shorter than a real handshake — a LOUD
 * rejection the operator asked for, not the silent breakage this class is about — stays out.
 */
const acceptedByKnob: Record<string, unknown[]> = {
  url: [REDIS_URL],
  key_prefix: ['plain:', 'no-trailing-colon', 'with spaces:', 'unicode-\u00fc:', 'glob*chars?:'].map(
    (flavour) => `${freshPrefix()}${flavour}`,
  ),
  retention_days: [null, ...retentionWindows()],
  block_ms: [1, 2000, 120_000, ...millisBudgets(0xb10c, 1, 600_000)],
  connect_timeout_ms: [5000, ...millisBudgets(0xc0de, 500, 30_000)],
};

describe.skipIf(!redisUp)('redis failure modes — an accepted config still delivers', () => {
  it.each(CONFIG_KEYS)('every accepted %s round-trips post → fetchRecent', async (knob) => {
    const values = acceptedByKnob[knob] ?? [];
    expect(values.length, `no accepted values are declared for '${knob}'`).toBeGreaterThan(0);
    const plugin = new RedisPlugin();
    const prefixes = new Set<string>();
    const broken: string[] = [];
    try {
      for (const value of values) {
        const config: Record<string, unknown> = {
          url: REDIS_URL,
          key_prefix: freshPrefix(),
          [knob]: value,
        };
        prefixes.add(String(config.key_prefix));
        const t = freshTopic();
        const failure = await (async () => {
          await plugin.connect(config);
          const id = await plugin.post(t, asHandle('w'), 'round-trip');
          const page = await plugin.fetchRecent({ topic: t, limit: 10 });
          if (page.messages.map((m) => m.backendMsgId).join() !== id) {
            throw new Error(`fetchRecent returned ${JSON.stringify(page.messages)}`);
          }
        })().then(
          () => undefined,
          (err: Error) => err,
        );
        if (failure !== undefined) broken.push(`${label(value)} → ${failure.message}`);
      }
      expect(broken, `connect() accepted these ${knob} values and then broke the seam`).toEqual([]);
    } finally {
      await plugin.disconnect().catch(() => undefined);
      for (const prefix of prefixes) await wipe(prefix);
    }
  });

  // The one path the round-trip above cannot see: a knob accepted at connect() that then silently
  // kills LIVE push. `30 / 7` is deliberate — a window that is not a whole number of milliseconds.
  it('live push still works with every knob set at once', async () =>
    withPlugin(
      { block_ms: 250, connect_timeout_ms: 3000, retention_days: 30 / 7 },
      async ({ plugin }) => {
        const t = freshTopic();
        const live: string[] = [];
        await plugin.subscribe(t, (m) => live.push(m.content));
        const id = await plugin.post(t, asHandle('w'), 'pushed');
        await expect.poll(() => live, { timeout: 5000, interval: 50 }).toEqual(['pushed']);
        const page = await plugin.fetchRecent({ topic: t, limit: 10 });
        expect(page.messages.map((m) => m.backendMsgId)).toEqual([id]);
      },
    ));
});

// -------------------------------------------------------------------------------------------
// CLASS: a knob graded only by what connect() does with its VALUE, so the prose is free to explain
// it by a mechanism it is not on the path of. `block_ms` is the XREAD BLOCK timeout — how long an
// idle read parks before re-arming — and was documented in two places as `subscribe`'s shutdown
// re-check interval, which `disconnect()` never waits for (it destroys the reader socket, breaking
// the parked read at once). Both halves of the claim are measured here AGAINST THE INTERVAL, so the
// rows cannot pass by the value being small, and the README rule that grades the prose cannot drift
// away from the behaviour it describes.
// -------------------------------------------------------------------------------------------

describe.skipIf(!redisUp)('redis failure modes — block_ms is an idle re-arm interval only', () => {
  const parked = async (
    plugin: RedisPlugin,
    topic: Topic,
    handler: (m: { content: string }) => void = () => undefined,
  ): Promise<void> => {
    await plugin.subscribe(topic, handler);
    await new Promise((r) => setTimeout(r, 200)); // let the loop reach its first XREAD BLOCK
  };

  it.each([2000, 60_000])('disconnect() does not wait out a block_ms of %i', async (blockMs) =>
    withPlugin({ block_ms: blockMs }, async ({ plugin }) => {
      await parked(plugin, freshTopic());
      const started = Date.now();
      await plugin.disconnect();
      expect(
        Date.now() - started,
        `disconnect() waited out the block_ms of ${blockMs}, so it IS a shutdown knob`,
      ).toBeLessThan(blockMs / 2);
    }));

  it('a live post is delivered without waiting out a block_ms of 60000', async () =>
    withPlugin({ block_ms: 60_000 }, async ({ plugin }) => {
      const t = freshTopic();
      const live: string[] = [];
      // Parked FIRST, so the row cannot pass on the first read happening to land after the post:
      // a loop that re-armed on a timer instead of blocking would be asleep for the interval here.
      await parked(plugin, t, (m) => live.push(m.content));
      await plugin.post(t, asHandle('w'), 'pushed');
      await expect.poll(() => live, { timeout: 5000, interval: 50 }).toEqual(['pushed']);
    }));
});

// The teardown-ordering half of the same class: connect() validates its WHOLE config before it tears
// the previous connection down, so a value an operator got wrong can never leave a live bridge with
// no client and every later seam call answering "not connected". Driven over every rejection row of
// every knob, because the ordering is a property of connect() rather than of any one knob.

describe.skipIf(!redisUp)(
  'redis failure modes — a rejected connect() must not destroy a live one',
  () => {
    it.each(CONFIG_KEYS)('every rejected %s leaves the live connection usable', async (knob) =>
      withPlugin({}, async ({ plugin, prefix }) => {
        const rows = rejectedByKnob[knob] ?? [];
        expect(rows.length, `no rejection rows are declared for '${knob}'`).toBeGreaterThan(0);
        const t = freshTopic();
        const destroyed: string[] = [];
        await plugin.post(t, asHandle('w'), 'before');
        for (const [rowLabel, value] of rows) {
          const rejection = await plugin
            .connect({ url: REDIS_URL, key_prefix: prefix, [knob]: value })
            .then(
              () => undefined,
              (err: Error) => err,
            );
          if (rejection === undefined) {
            destroyed.push(`${rowLabel}: accepted, so this row proves nothing`);
            continue;
          }
          const survived = await plugin.post(t, asHandle('w'), rowLabel).then(
            () => true,
            () => false,
          );
          if (!survived) destroyed.push(`${rowLabel}: ${rejection.message}`);
        }
        expect(
          destroyed,
          `a rejected ${knob} tore the live connection down before finishing validation`,
        ).toEqual([]);
        const page = await plugin.fetchRecent({ topic: t, limit: 1000 });
        expect(page.messages.map((m) => m.content)).toContain('before');
      }),
    );
  },
);
