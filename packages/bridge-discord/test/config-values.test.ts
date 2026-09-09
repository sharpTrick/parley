import { asHandle, asTopic, MAX_TIMER_MS, type Topic } from '@sharptrick/parley-core';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG_SHAPES, MAX_DIALERS, type ConfigShape } from '../src/config.js';
import { DiscordPlugin, RECONNECT_CAP_MS } from '../src/index.js';
import { startFakeDiscord, type FakeDiscord } from './fake-discord.js';
import { probe, settleOf } from './harness.js';

/**
 * CLASS: a `backend_config` value whose TYPE nothing checked. Core parses `backend_config` as an
 * unchecked record and refuses only the key NAMES, so every value arrives as whatever the YAML
 * held and lands in one of three sinks — the channel id a topic routes to, a `setTimeout` delay,
 * or the URL a credentialed call is sent to. Two instances shipped: a numeric `channel_map` value
 * (the shape an unquoted YAML channel id has) keyed `subs` under a number while dispatch
 * looked them up under the string Discord sends, so the topic posted and caught up but was
 * PERMANENTLY DEAF to push, with no diagnostic; and `handshake_timeout_ms: '10s'` reached
 * `setTimeout` as NaN, so every dial failed 1 ms after the socket opened, forever, spending the
 * per-token IDENTIFY quota whose overrun resets the bot token.
 *
 * So the table below is keyed by the DECLARED SHAPE of each key rather than by the two keys that
 * were wrong, and the corpus is a `Record<ConfigShape, …>`: a key added to the plugin's config must
 * declare a shape (a compile error in src otherwise), and a shape added to the vocabulary must
 * bring values that must not load (a compile error here otherwise). A knob added later is graded by
 * existing rather than by being remembered.
 *
 * The second half is the arm that would have caught the numeric map with no type check at all: for
 * every mapped value that DOES load, `post`, `fetchRecent` and live `MESSAGE_CREATE` dispatch must
 * all agree on the same channel. The existing `channel_map` cases pass only string values and none
 * of them checks that a mapped topic still receives push.
 */

/** A settled `connect()` that is required to have refused, plus what it said. */
const refusalOf = async (call: Promise<unknown>): Promise<string> => {
  const settled = await settleOf(call);
  expect(settled.status, 'connect() accepted a value it cannot use').toBe('rejected');
  return settled.status === 'rejected' ? String(settled.error) : '';
};

/**
 * Values NO key of that shape may load, as [what it is, the value]. Keyed by shape, so that the
 * corpus cannot silently cover only the keys someone thought of.
 */
const REFUSED: Record<ConfigShape, Array<[string, unknown]>> = {
  text: [
    ['a number', 5],
    ['null', null],
    ['a boolean', true],
    ['an array', ['x']],
    ['an object', { toString: 'x' }],
  ],
  'channel map': [
    ['a number', 5],
    ['a string', 'abc'],
    ['an empty array', []],
    ['an array of ids', ['777000111']],
    ['null', null],
    ['a boolean', true],
    ['an unquoted short id', { alerts: 7788990011223 }],
    ['an unquoted 19-digit id', { alerts: 1234567890123456789 }],
    ['a boolean id', { alerts: true }],
    ['a null id', { alerts: null }],
    ['an empty id', { alerts: '' }],
    ['an object id', { alerts: {} }],
    ['one good id and one number', { alerts: '777000111', pages: 7788990011223 }],
  ],
  'timer ms': [
    ['a duration spelled as text', '10s'],
    ['a numeric string', '10000'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['zero', 0],
    ['a negative delay', -1],
    ['a fractional delay', 1.5],
    ['a sub-millisecond delay', 0.5],
    ['a delay past the 32-bit timer range', 2 ** 31],
    ['a delay a human might mean as days', 3_000_000_000],
    ['null', null],
    ['an array', []],
    ['an object', {}],
  ],
  'dialer count': [
    ['a fleet size spelled as text', '4'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['zero', 0],
    ['a negative count', -1],
    ['a fractional count', 1.5],
    ['a fleet whose ceiling outruns the timer range', 2 ** 31],
    ['a fleet one past the ceiling that still arms', Math.floor((2 ** 31 - 1) / RECONNECT_CAP_MS) + 1],
    ['null', null],
    ['an array', []],
    ['an object', {}],
  ],
  'nested object': [
    ['a number', 5],
    ['a string', 'abc'],
    ['an array', []],
    ['null', null],
    ['a misspelled member', { parse: ['users'], reply_user: false }],
  ],
};

/** Mapped channel ids that DO load — every one has to carry the whole trio. */
const MAPPED_IDS: Array<[string, string]> = [
  ['a snowflake', '777000111222333444'],
  ['an id carrying a space', 'has space'],
  ['an id carrying non-ASCII', 'naïve'],
  ['an id carrying a query delimiter', 'x?limit=1'],
  ['an id carrying a percent escape', 'x%2F'],
];

/** Figures a `backend_config` knob turns into a delay, read off the plugin that was handed them. */
const armedFigures = (plugin: DiscordPlugin): Array<[string, number]> => {
  const gateway = probe<object>(plugin, 'gateway');
  return [
    ['the handshake watchdog', probe<number>(gateway, 'handshakeTimeoutMs')],
    ['the reconnect ceiling', probe<number>(gateway, 'reconnectCapMs')],
  ];
};

/**
 * Node's documented timer range, stated HERE rather than imported: the accepted figures below come
 * from the plugin's own ceilings, so a ceiling that widens has to be graded against a number the
 * widening cannot move with it.
 */
const NODE_TIMER_MAX_MS = 2 ** 31 - 1;
const SENDER = asHandle('writer');
/** A channel the armable-figure rows dial, so the plugin arms its own timers inside the window. */
const DIALED_CHANNEL = '777000111222333555';
const MAPPED_TOPIC = asTopic('ctx-1');

describe('discord backend_config values', () => {
  let fake: FakeDiscord;

  beforeAll(async () => {
    fake = await startFakeDiscord();
  });
  afterAll(async () => {
    await fake.close();
  });
  beforeEach(() => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const connect = async (extra: Record<string, unknown>): Promise<DiscordPlugin> => {
    const p = new DiscordPlugin();
    await p.connect({
      token: 'fake-token',
      api_url: fake.apiUrl,
      gateway_url: fake.gatewayUrl,
      ...extra,
    });
    return p;
  };

  describe('a value of the wrong shape is a load error, before anything is dialled', () => {
    for (const [key, shape] of Object.entries(CONFIG_SHAPES)) {
      it(`${key} has values its ${shape} shape must refuse`, () => {
        expect(REFUSED[shape].length, `nothing grades the ${shape} shape`).toBeGreaterThan(0);
      });

      for (const [label, value] of REFUSED[shape]) {
        it(`${key} refuses ${label}`, async () => {
          const before = fake.requestCount();
          const said = await refusalOf(connect({ [key]: value }));
          expect(said, 'the refusal has to name the key an operator must fix').toContain(key);
          expect(fake.requestCount(), 'a refused config still reached the provider').toBe(before);
        });
      }
    }

    it('names the offending topic when a channel_map entry is the problem', async () => {
      const said = await refusalOf(connect({ channel_map: { ok: '777000111', broken: 7788990011223 } }));
      expect(said).toContain('broken');
    });

    it('describes a refused value by type, never by what it holds', async () => {
      const said = await refusalOf(connect({ token: { value: 'a-real-bot-token' } }));
      expect(said, 'the refusal put the credential it refused on stderr').not.toContain(
        'a-real-bot-token',
      );
      expect(said).toContain('an object');
    });
  });

  // The arm that catches a value the type check does not: a `channel_map` target the plugin
  // ACCEPTS has to reach all three of post, catch-up and push, and the same channel in each. A
  // value that keys the subscription table differently from what Discord's dispatch carries passes
  // post and fetchRecent and delivers nothing, forever.
  describe('every mapped channel id that loads carries post, fetchRecent AND push', () => {
    for (const [label, channelId] of MAPPED_IDS) {
      it(`${label}`, async () => {
        fake.createChannel(channelId);
        const p = await connect({ channel_map: { [MAPPED_TOPIC as string]: channelId } });
        const pushed: Array<[Topic, string]> = [];
        try {
          await p.subscribe(MAPPED_TOPIC, (m) => {
            pushed.push([m.topic, m.content]);
          });
          const posted = await p.post(MAPPED_TOPIC, SENDER, `hello ${label}`);
          const page = await p.fetchRecent({ topic: MAPPED_TOPIC, limit: 10 });

          expect(page.messages.map((m) => m.content)).toContain(`hello ${label}`);
          await expect
            .poll(() => pushed.length, { timeout: 3000 })
            .toBeGreaterThan(0);
          expect(pushed.at(-1), 'push delivered under a different topic').toEqual([
            MAPPED_TOPIC,
            `hello ${label}`,
          ]);
          expect(
            fake.posts().filter((post) => post.channelId === channelId).length,
            'post went to a channel the map does not name',
          ).toBeGreaterThan(0);
          expect(page.messages.map((m) => m.backendMsgId)).toContain(posted);
        } finally {
          await p.disconnect();
        }
      });
    }
  });

  // A figure that loads has to be one a timer can HOLD: Node wraps a delay past 2^31-1 to 1 ms and
  // warns, so an accepted knob whose derived delay overflows is the same defect one step later —
  // and the reconnect ceiling is a PRODUCT (120000 × gateway_dialers), which no per-key bound sees.
  //
  // The `warning` listener spans a real dial and so covers timers this case does not enumerate; the
  // two it does enumerate are graded by the three assertions on the figures themselves.
  describe('every figure a loaded config arms is a delay Node holds', () => {
    const ACCEPTED: Array<[string, Record<string, unknown>]> = [
      ['the defaults', {}],
      ['the smallest figures', { handshake_timeout_ms: 1, gateway_dialers: 1 }],
      [
        'the largest figures the plugin says it accepts',
        { handshake_timeout_ms: MAX_TIMER_MS, gateway_dialers: MAX_DIALERS },
      ],
    ];

    for (const [label, config] of ACCEPTED) {
      it(`${label}`, async () => {
        const warnings: string[] = [];
        const onWarning = (w: Error): void => {
          warnings.push(w.name);
        };
        process.on('warning', onWarning);
        const p = await connect(config);
        try {
          fake.createChannel(DIALED_CHANNEL);
          await p.subscribe(asTopic(DIALED_CHANNEL), () => undefined);
          for (const [what, ms] of armedFigures(p)) {
            expect(Number.isInteger(ms), `${what} is not a whole number of ms`).toBe(true);
            expect(ms, `${what} is below Node's timer range`).toBeGreaterThanOrEqual(1);
            expect(ms, `${what} is past Node's timer range`).toBeLessThanOrEqual(NODE_TIMER_MAX_MS);
          }
          await new Promise((resolve) => setImmediate(resolve));
          expect(warnings.filter((name) => name.startsWith('Timeout'))).toEqual([]);
        } finally {
          process.off('warning', onWarning);
          await p.disconnect();
        }
      });
    }
  });

  // A knob nobody documented is one an operator meets only by having it refused.
  describe('every declared key is documented', () => {
    const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const CONFIG_SECTION = README.slice(
      README.indexOf('## Config (`backend_config`)'),
      README.indexOf('## Rate limits'),
    );

    it('carries the config section the keys are documented in', () => {
      expect(CONFIG_SECTION.length).toBeGreaterThan(0);
    });

    for (const key of Object.keys(CONFIG_SHAPES)) {
      it(`${key} has a row`, () => {
        expect(CONFIG_SECTION).toContain(`\`${key}\``);
      });
    }

    // A range an operator is told to configure inside has to be the range the load error enforces.
    const RANGES: Array<[string, number]> = [
      ['the timer ceiling', MAX_TIMER_MS],
      ['the fleet ceiling', MAX_DIALERS],
    ];

    for (const [label, bound] of RANGES) {
      it(`states ${label} as ${bound}`, () => {
        expect(CONFIG_SECTION).toContain(String(bound));
      });
    }

  });
});
