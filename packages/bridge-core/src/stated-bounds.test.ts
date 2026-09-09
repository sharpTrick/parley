/// <reference types="vite/client" />
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { Allowlist, TopicNotAllowedError } from './allowlist.js';
import { MAX_CLIENTS, MAX_PENDING, shedCrowdedest } from './auth/eviction.js';
import { ParleyOAuthProvider } from './auth/oauth-provider.js';
import { DISCOVERY_TIMEOUT_MS, fetchOidcDiscovery } from './auth/oidc-discovery.js';
import {
  MAX_BLOCK_MS,
  MAX_HANDLE_LEN,
  MAX_POST_TOPICS,
  MAX_TOPIC_LEN,
  MAX_TOPICS,
  parseConfig,
} from './config.js';
import { catchUpTopic, MAX_CATCHUP_PAGES } from './engine/catchup.js';
import { ReadStateStore } from './engine/read-state.js';
import { SEEN_MAX_PER_TOPIC, SEEN_MAX_TOPICS, SeenSet } from './engine/seen-set.js';
import { asBackendMsgId, asCursor, asHandle, asTopic } from './message.js';
import {
  isRedosSafeSource,
  MAX_AMBIGUITY,
  MAX_MATCH_INPUT,
  MIN_COMPOUNDING_REPEAT,
} from './regex-safety.js';
import { FakePlugin } from './testing/fake-plugin.js';
import { harness } from './testing/tool-harness.js';
import { boundedLine, MAX_NAMED_FRAGMENT } from './bounded-line.js';
import { MAX_TIMER_MS } from './timer-bounds.js';
import { DEFAULT_HASH_LEN, MAX_HASH_LEN, MIN_HASH_LEN, safeName } from './topic-name.js';
import { MAX_FETCH_LIMIT } from './transport/tools.js';

// Every limit below is documented as INCLUSIVE — "at most 64 characters", "an integer in [10, 40]"
// — and each is stated in an error message the operator reads.
// A table that samples one interior value on each side leaves the equality case free, and the
// equality case is where a one-character regression lands: it refuses a legal input with a message
// that contradicts itself ("at most 64 characters (this one is 64)"), and it locks an operator out
// of post/fetch for a topic the doc promises works. So grade the bound itself, three cells per rule,
// every probe value derived from the constant rather than from a literal.

type Verdict = 'accepted' | 'refused';

interface StatedBound {
  label: string;
  bound: number;
  /** Which side of the bound is legal; the bound value itself is legal on both. */
  legal: 'at-or-below' | 'at-or-above';
  probe: (value: number) => Verdict;
}

const sanitizeAlias = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, '_');

const BOUNDS: StatedBound[] = [
  {
    label: 'Allowlist post-pattern input clamp (MAX_MATCH_INPUT)',
    bound: MAX_MATCH_INPUT,
    legal: 'at-or-below',
    probe: (len) => {
      const allow = new Allowlist(['ctx'], { postPatterns: ['ctx-.*'] });
      const topic = `ctx-${'a'.repeat(len - 4)}`;
      expect(topic).toHaveLength(len);
      try {
        allow.assert(topic);
        return 'accepted';
      } catch (e) {
        expect(e).toBeInstanceOf(TopicNotAllowedError);
        expect((e as Error).message).toMatch(
          new RegExp(`at most ${MAX_MATCH_INPUT} characters \\(this one is ${len}\\)`),
        );
        return 'refused';
      }
    },
  },
  {
    label: 'safeName hash suffix floor (MIN_HASH_LEN)',
    bound: MIN_HASH_LEN,
    legal: 'at-or-above',
    probe: (hashLen) => hashLenVerdict(hashLen),
  },
  {
    label: 'safeName hash suffix ceiling (MAX_HASH_LEN)',
    bound: MAX_HASH_LEN,
    legal: 'at-or-below',
    probe: (hashLen) => hashLenVerdict(hashLen),
  },
  {
    label: 'catchup.block_max_ms ceiling (MAX_BLOCK_MS)',
    bound: MAX_BLOCK_MS,
    legal: 'at-or-below',
    probe: (block_max_ms) => {
      try {
        const cfg = parseConfig({
          identity: { handle: 'h' },
          topics: ['ctx'],
          catchup: { block_max_ms },
        });
        expect(cfg.catchup.block_max_ms).toBe(block_max_ms);
        return 'accepted';
      } catch (e) {
        expect((e as Error).message).toMatch(
          new RegExp(`block_max_ms must be <= ${MAX_BLOCK_MS}`),
        );
        return 'refused';
      }
    },
  },
  {
    label: 'catchup.block_poll_interval_ms ceiling (MAX_TIMER_MS)',
    bound: MAX_TIMER_MS,
    legal: 'at-or-below',
    probe: (block_poll_interval_ms) => {
      try {
        const cfg = parseConfig({
          identity: { handle: 'h' },
          topics: ['ctx'],
          catchup: { block_poll_interval_ms },
        });
        expect(cfg.catchup.block_poll_interval_ms).toBe(block_poll_interval_ms);
        return 'accepted';
      } catch (e) {
        expect((e as Error).message).toMatch(
          new RegExp(`block_poll_interval_ms must be <= ${MAX_TIMER_MS}`),
        );
        return 'refused';
      }
    },
  },
  {
    label: 'regex screen ambiguity budget (MAX_AMBIGUITY)',
    bound: Math.log2(MAX_AMBIGUITY),
    legal: 'at-or-below',
    // Each `a?` doubles the paths the engine can explore, so n optional atoms cost exactly 2^n.
    probe: (n) => (isRedosSafeSource(`${'a?'.repeat(n)}b`) ? 'accepted' : 'refused'),
  },
  {
    label: 'named-fragment length in a diagnostic (MAX_NAMED_FRAGMENT)',
    bound: MAX_NAMED_FRAGMENT,
    legal: 'at-or-below',
    probe: (len) => (boundedLine('x'.repeat(len)).endsWith('[truncated]') ? 'refused' : 'accepted'),
  },
];

function hashLenVerdict(hashLen: number): Verdict {
  try {
    safeName(asTopic('a b'), sanitizeAlias, { hashLen });
    return 'accepted';
  } catch (e) {
    expect(e).toBeInstanceOf(RangeError);
    expect((e as Error).message).toMatch(
      new RegExp(`integer in \\[${MIN_HASH_LEN}, ${MAX_HASH_LEN}\\]`),
    );
    return 'refused';
  }
}

const inside = (b: StatedBound): number => (b.legal === 'at-or-below' ? b.bound - 1 : b.bound + 1);
const outside = (b: StatedBound): number => (b.legal === 'at-or-below' ? b.bound + 1 : b.bound - 1);

describe('every documented inclusive bound is graded AT the bound', () => {
  it('pins the set of graded bounds and that each is an integer probe point', () => {
    expect(BOUNDS.map((b) => b.label)).toEqual([
      'Allowlist post-pattern input clamp (MAX_MATCH_INPUT)',
      'safeName hash suffix floor (MIN_HASH_LEN)',
      'safeName hash suffix ceiling (MAX_HASH_LEN)',
      'catchup.block_max_ms ceiling (MAX_BLOCK_MS)',
      'catchup.block_poll_interval_ms ceiling (MAX_TIMER_MS)',
      'regex screen ambiguity budget (MAX_AMBIGUITY)',
      'named-fragment length in a diagnostic (MAX_NAMED_FRAGMENT)',
    ]);
    for (const b of BOUNDS) expect(Number.isInteger(b.bound), b.label).toBe(true);
  });

  it.each(BOUNDS.map((b) => [b.label, b] as const))('%s accepts the bound itself', (_l, b) => {
    expect(b.probe(b.bound)).toBe('accepted');
  });

  it.each(BOUNDS.map((b) => [b.label, b] as const))(
    '%s accepts one step inside the bound',
    (_l, b) => {
      expect(b.probe(inside(b))).toBe('accepted');
    },
  );

  it.each(BOUNDS.map((b) => [b.label, b] as const))('%s refuses one step past it', (_l, b) => {
    expect(b.probe(outside(b))).toBe('refused');
  });
});

// Grading a bound only through probes DERIVED from it leaves its VALUE free: with every probe built
// as `'a'.repeat(bound - 1)`, shrinking a capacity to 8 keeps the whole suite green while an
// operator's configured topic starts being rejected. These constants are chosen limits, not
// promises derived from anything, so what is gradable about one is that it is ENFORCED at the value
// it names: pin the value as a literal, pair it with a literal, realistic input that must still be
// accepted, and require one step past it to be refused.
//
// The SUBJECT SET is derived from the tree the code lives in, never named. A hand-written list of
// four filenames used to stand here; it could not see src/engine or src/transport, and thirteen
// capacities lived there ungraded. So: walk every shipped module, import it, and take every numeric
// export. A naming convention is not the universe either; a capacity called SEEN_MAX_PER_TOPIC
// escapes a MAX/MIN/DEFAULT prefix scan while being exactly the same promise.

const SHIPPED_MODULES: Record<string, () => Promise<unknown>> = Object.fromEntries(
  Object.entries(import.meta.glob('./**/*.ts') as Record<string, () => Promise<unknown>>).filter(
    ([path]) => !path.endsWith('.test.ts') && !path.endsWith('.d.ts'),
  ),
);

async function declaredCapacities(): Promise<Map<string, number>> {
  const found = new Map<string, number>();
  for (const load of Object.values(SHIPPED_MODULES)) {
    const mod = (await load()) as Record<string, unknown>;
    for (const [name, value] of Object.entries(mod)) {
      if (typeof value !== 'number') continue;
      expect(found.get(name) ?? value, `${name} is exported with two different values`).toBe(value);
      found.set(name, value);
    }
  }
  return found;
}

interface Capacity {
  name: string;
  actual: number;
  expected: number;
  realistic: string;
  accepts: () => boolean | Promise<boolean>;
  /**
   * The same path one step PAST the capacity: refused, shed or truncated. A pin catches a widened
   * literal; this catches a widening achieved by weakening the enforcement the literal feeds.
   */
  refusesPast?: () => boolean | Promise<boolean>;
}

/** True when the call is REFUSED — an enforcement point that throws rather than silently widening. */
function refused(call: () => unknown): boolean {
  try {
    call();
    return false;
  } catch {
    return true;
  }
}

/** A plugin that records the `limit` every fetchRecent is asked for, so a clamp is observable. */
function limitRecordingPlugin(): { plugin: FakePlugin; limits: number[] } {
  const plugin = new FakePlugin();
  const limits: number[] = [];
  const inner = plugin.fetchRecent.bind(plugin);
  plugin.fetchRecent = async (args) => {
    if (args.limit !== undefined) limits.push(args.limit);
    return inner(args);
  };
  return { plugin, limits };
}

const DISCOVERY_ISSUER = 'https://idp.example.test/realms/parley';

const discoveryDocument = {
  issuer: DISCOVERY_ISSUER,
  authorization_endpoint: `${DISCOVERY_ISSUER}/protocol/openid-connect/auth`,
  token_endpoint: `${DISCOVERY_ISSUER}/protocol/openid-connect/token`,
  jwks_uri: `${DISCOVERY_ISSUER}/protocol/openid-connect/certs`,
  response_types_supported: ['code'],
  subject_types_supported: ['public'],
  id_token_signing_alg_values_supported: ['RS256'],
};

const CAPACITIES: Capacity[] = [
  {
    name: 'MAX_TOPICS',
    actual: MAX_TOPICS,
    expected: 64,
    realistic: 'a bridge configured for 64 topics loads and allowlists all 64',
    accepts: () =>
      parseConfig({ identity: { handle: 'h' }, topics: ctxTopics(64) }).topics.length === 64,
    refusesPast: () =>
      refused(() => parseConfig({ identity: { handle: 'h' }, topics: ctxTopics(65) })),
  },
  {
    name: 'MAX_POST_TOPICS',
    actual: MAX_POST_TOPICS,
    expected: 64,
    realistic: 'sixteen post_topics patterns',
    accepts: () => {
      const cfg = parseConfig({
        identity: { handle: 'h' },
        topics: ['ctx'],
        post_topics: Array.from({ length: 16 }, (_, i) => `ctx-team-${i}-.*`),
      });
      return cfg.post_topics.length === 16;
    },
    refusesPast: () =>
      refused(() =>
        parseConfig({
          identity: { handle: 'h' },
          topics: ['ctx'],
          post_topics: Array.from({ length: 65 }, (_, i) => `ctx-team-${i}-.*`),
        }),
      ),
  },
  {
    name: 'MAX_BLOCK_MS',
    actual: MAX_BLOCK_MS,
    expected: 300_000,
    realistic: 'a two-minute long-poll clamp',
    accepts: () => {
      const cfg = parseConfig({
        identity: { handle: 'h' },
        topics: ['ctx'],
        catchup: { block_max_ms: 120_000 },
      });
      return cfg.catchup.block_max_ms === 120_000;
    },
    refusesPast: () =>
      refused(() =>
        parseConfig({ identity: { handle: 'h' }, topics: ['ctx'], catchup: { block_max_ms: 300_001 } }),
      ),
  },
  {
    name: 'MAX_TIMER_MS',
    actual: MAX_TIMER_MS,
    expected: 2_147_483_647,
    realistic: 'a quarter-second long-poll re-query interval',
    accepts: () => {
      const cfg = parseConfig({
        identity: { handle: 'h' },
        topics: ['ctx'],
        catchup: { block_poll_interval_ms: 250 },
      });
      return cfg.catchup.block_poll_interval_ms === 250;
    },
    refusesPast: () =>
      refused(() =>
        parseConfig({
          identity: { handle: 'h' },
          topics: ['ctx'],
          catchup: { block_poll_interval_ms: MAX_TIMER_MS + 1 },
        }),
      ),
  },
  {
    name: 'MAX_NAMED_FRAGMENT',
    actual: MAX_NAMED_FRAGMENT,
    expected: 128,
    realistic: 'backend_config.gateway_dialers (30 chars)',
    accepts: () => boundedLine('backend_config.gateway_dialers') === 'backend_config.gateway_dialers',
    refusesPast: () => boundedLine('x'.repeat(MAX_NAMED_FRAGMENT + 1)).endsWith('[truncated]'),
  },
  {
    name: 'MAX_MATCH_INPUT',
    actual: MAX_MATCH_INPUT,
    expected: 64,
    realistic: 'ctx-payments-oncall-europe-west-handoff-2 (41 chars)',
    accepts: () => {
      const topic = 'ctx-payments-oncall-europe-west-handoff-2';
      expect(topic).toHaveLength(41);
      new Allowlist(['ctx'], { postPatterns: ['ctx-.*'] }).assert(topic);
      return true;
    },
    refusesPast: () =>
      refused(() => new Allowlist(['ctx'], { postPatterns: ['ctx-.*'] }).assert(`ctx-${'a'.repeat(61)}`)),
  },
  {
    name: 'MAX_AMBIGUITY',
    actual: MAX_AMBIGUITY,
    expected: 65_536,
    realistic: 'ctx-(?:payments|billing|search)-[a-z0-9-]{1,32}',
    accepts: () => isRedosSafeSource('ctx-(?:payments|billing|search)-[a-z0-9-]{1,32}'),
    refusesPast: () => !isRedosSafeSource(`${'a?'.repeat(17)}b`),
  },
  {
    name: 'MIN_COMPOUNDING_REPEAT',
    actual: MIN_COMPOUNDING_REPEAT,
    expected: 2,
    realistic: 'ctx-(?:payments|billing){1} — a bound too small to compound stays postable',
    accepts: () => isRedosSafeSource('ctx-(?:payments|billing){1}'),
    refusesPast: () => !isRedosSafeSource('ctx-(?:payments|billing){2}'),
  },
  {
    name: 'MIN_HASH_LEN',
    actual: MIN_HASH_LEN,
    expected: 10,
    realistic: 'a caller may ask for the floor explicitly, and gets exactly it',
    accepts: () => {
      const minted = safeName(asTopic('a b'), sanitizeAlias, { hashLen: MIN_HASH_LEN })
        .split('-')
        .pop()!;
      return minted.length === MIN_HASH_LEN && /^[0-9a-f]+$/.test(minted);
    },
    refusesPast: () => refused(() => safeName(asTopic('a b'), sanitizeAlias, { hashLen: 9 })),
  },
  {
    name: 'DEFAULT_HASH_LEN',
    actual: DEFAULT_HASH_LEN,
    expected: 16,
    // Grade the width safeName mints when `hashLen` is omitted — exactly, not `{16,}`, which would
    // leave the security parameter free to move under a green suite. Every shipped backend omits it,
    // so this is the width a deployment runs on, and changing it renames every channel.
    realistic: 'the suffix minted when hashLen is omitted is exactly this many hex digits',
    accepts: () => {
      const minted = safeName(asTopic('a b'), sanitizeAlias).split('-').pop()!;
      return minted.length === DEFAULT_HASH_LEN && /^[0-9a-f]+$/.test(minted);
    },
  },
  {
    name: 'MAX_HASH_LEN',
    actual: MAX_HASH_LEN,
    expected: 40,
    realistic: 'a full sha1 hex suffix',
    accepts: () => /-[0-9a-f]{40}$/.test(safeName(asTopic('a b'), sanitizeAlias, { hashLen: 40 })),
    refusesPast: () => refused(() => safeName(asTopic('a b'), sanitizeAlias, { hashLen: 41 })),
  },
  {
    name: 'MAX_HANDLE_LEN',
    actual: MAX_HANDLE_LEN,
    expected: 128,
    realistic: 'claude-agent-oncall-payments-eu is a loadable identity',
    accepts: () =>
      parseConfig({ identity: { handle: 'claude-agent-oncall-payments-eu' }, topics: ['ctx'] })
        .identity.handle === 'claude-agent-oncall-payments-eu',
    refusesPast: () =>
      refused(() => parseConfig({ identity: { handle: 'h'.repeat(129) }, topics: ['ctx'] })),
  },
  {
    name: 'MAX_TOPIC_LEN',
    actual: MAX_TOPIC_LEN,
    expected: 512,
    realistic: 'a 512-character topic name is configurable verbatim',
    accepts: () =>
      parseConfig({ identity: { handle: 'h' }, topics: ['t'.repeat(512)] }).topics[0]?.length === 512,
    refusesPast: () =>
      refused(() => parseConfig({ identity: { handle: 'h' }, topics: ['t'.repeat(513)] })),
  },
  {
    name: 'SEEN_MAX_PER_TOPIC',
    actual: SEEN_MAX_PER_TOPIC,
    expected: 4096,
    realistic: 'a busy topic is deduped 4096 messages deep',
    accepts: () => rememberedAfter(4096),
    refusesPast: () => !rememberedAfter(4097),
  },
  {
    name: 'SEEN_MAX_TOPICS',
    actual: SEEN_MAX_TOPICS,
    expected: 256,
    realistic: 'a bridge on 256 topics dedups on all of them at once',
    accepts: () => rememberedAcross(256),
    refusesPast: () => !rememberedAcross(257),
  },
  {
    name: 'MAX_CATCHUP_PAGES',
    actual: MAX_CATCHUP_PAGES,
    expected: 10_000,
    realistic: 'a resumed catch-up walks three pages of two and finishes',
    accepts: async () => (await resumedCatchUp(6, 2)) === 6,
  },
  {
    name: 'MAX_FETCH_LIMIT',
    actual: MAX_FETCH_LIMIT,
    expected: 1_000,
    realistic: 'a caller asking for a full 1000-message page gets it asked for verbatim',
    accepts: async () => (await fetchLimitReaching(1_000)) === 1_000,
    refusesPast: async () => (await fetchLimitReaching(1_001)) === 1_000,
  },
  {
    name: 'MAX_CLIENTS',
    actual: MAX_CLIENTS,
    expected: 100,
    realistic: '100 connectors stay registered at once; the first is not evicted to fit the last',
    accepts: () => registrationSurvives(100),
    refusesPast: () => !registrationSurvives(101),
  },
  {
    name: 'MAX_PENDING',
    actual: MAX_PENDING,
    expected: 100,
    realistic: '100 consent pages are held open at once',
    accepts: () => pendingHeld(100) === 100,
    refusesPast: () => pendingHeld(101) === 100,
  },
  {
    name: 'DISCOVERY_TIMEOUT_MS',
    actual: DISCOVERY_TIMEOUT_MS,
    expected: 10_000,
    realistic: 'an IdP that takes 50 ms to answer boot-time discovery is waited for',
    accepts: async () => (await discoverySlowBy(50)) === DISCOVERY_ISSUER,
  },
];

const ctxTopics = (n: number): string[] => Array.from({ length: n }, (_, i) => `ctx-${i}`);

const id = (n: number): string => `msg-${n}`;

/** Whether the OLDEST id is still deduped after `n` ids land on one topic. */
function rememberedAfter(n: number): boolean {
  const seen = new SeenSet();
  const topic = asTopic('ctx');
  for (let i = 0; i < n; i++) seen.markSeen(topic, asBackendMsgId(id(i)));
  return seen.has(topic, asBackendMsgId(id(0)));
}

/** Whether the OLDEST topic is still deduped after ids land on `n` topics. */
function rememberedAcross(n: number): boolean {
  const seen = new SeenSet();
  for (let i = 0; i < n; i++) seen.markSeen(asTopic(`ctx-${i}`), asBackendMsgId(id(1)));
  return seen.has(asTopic('ctx-0'), asBackendMsgId(id(1)));
}

async function resumedCatchUp(messages: number, pageSize: number): Promise<number> {
  const plugin = new FakePlugin();
  await plugin.connect({});
  const topic = asTopic('ctx');
  for (let i = 0; i < messages; i++) await plugin.post(topic, asHandle('a'), `m${i}`);
  const readState = new ReadStateStore(`${tmpdir()}/parley-stated-bounds-${randomUUID()}.json`);
  readState.set(topic, asCursor('0'));
  return catchUpTopic({ plugin, topic, limit: pageSize, readState, seen: new SeenSet() });
}

/** The `limit` parley_fetch_recent actually hands the backend when a caller asks for `asked`. */
async function fetchLimitReaching(asked: number): Promise<number | undefined> {
  const { plugin, limits } = limitRecordingPlugin();
  const h = await harness({ plugin });
  await h.client.callTool({ name: 'parley_fetch_recent', arguments: { topic: 'ctx', limit: asked } });
  return limits.at(-1);
}

/** Whether the FIRST registration survives `n` distinct client registrations. */
function registrationSurvives(n: number): boolean {
  const provider = new ParleyOAuthProvider({
    resource: new URL('https://parley.example.test/mcp'),
    verifyOwner: async () => false,
    consentPath: '/consent',
  });
  try {
    const store = provider.clientsStore;
    for (let i = 0; i < n; i++) {
      store.registerClient!({ client_id: `client-${i}`, redirect_uris: [] } as never);
    }
    return store.getClient('client-0') !== undefined;
  } finally {
    provider.stop();
  }
}

/** How many consent pages survive the shed that runs before the `n`th is inserted. */
function pendingHeld(n: number): number {
  const pending = new Map<string, { clientId: string }>();
  for (let i = 0; i < n; i++) {
    shedCrowdedest(pending, MAX_PENDING - 1, (p) => p.clientId);
    pending.set(`consent-${i}`, { clientId: `client-${i}` });
  }
  return pending.size;
}

async function discoverySlowBy(ms: number): Promise<string> {
  const slow: typeof fetch = async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return new Response(JSON.stringify(discoveryDocument), {
      headers: { 'content-type': 'application/json' },
    });
  };
  return (await fetchOidcDiscovery(DISCOVERY_ISSUER, slow)).issuer;
}

const PROBED_PAST = CAPACITIES.filter((c) => c.refusesPast !== undefined);

describe('every chosen limit is pinned to a value, not only to itself', () => {
  it('has a row for every numeric capacity anything under src/ exports', async () => {
    const declared = await declaredCapacities();
    // Floor the DERIVATION itself: a walk that stops matching would otherwise grade an empty
    // universe and pass, which is the failure this registry exists to make impossible.
    expect(declared.size, 'the capacity walk found fewer than it was written against').toBeGreaterThanOrEqual(19);
    expect([...declared.keys()].sort()).toEqual(CAPACITIES.map((c) => c.name).sort());
    for (const c of CAPACITIES) expect(declared.get(c.name), c.name).toBe(c.actual);
  });

  it('keeps the loosening probes it was written with', () => {
    expect(PROBED_PAST.length, 'a row lost its refusesPast probe').toBeGreaterThanOrEqual(16);
  });

  it.each(CAPACITIES.map((c) => [c.name, c] as const))('pins %s to a literal', (_n, c) => {
    expect(c.actual).toBe(c.expected);
  });

  it.each(CAPACITIES.map((c) => [c.name, c.realistic, c] as const))(
    '%s still admits a realistic input (%s)',
    async (_n, _r, c) => {
      expect(await c.accepts()).toBe(true);
    },
  );

  it.each(PROBED_PAST.map((c) => [c.name, c] as const))(
    '%s still holds one step past the capacity',
    async (_n, c) => {
      expect(await c.refusesPast!()).toBe(true);
    },
  );
});
