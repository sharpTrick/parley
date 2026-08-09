import { asHandle, asTopic } from '@sharptrick/parley-core';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  connect,
  credsAuthenticator,
  nkeyAuthenticator,
  nkeys,
  type ConnectionOptions,
} from 'nats';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { captures, NatsPlugin, plaintextRemoteServer, redactUserinfo } from '../src/index.js';
import { fakeJetStream, injectFake } from './fake-jetstream.js';
import {
  declaredConfigKeys,
  declaredConfigPaths,
  legalStreamName,
  legalSubject,
} from './helpers.js';

// Class 1: every backend_config field the docs promise is actually honoured by the driver, and no
// secret value is echoed back out. A credential the plugin silently drops means the operator
// believes a cluster is authenticated when the connection is anonymous.
// Class 2: a backend_config value is validated where it is READ, not where it eventually lands.
// A value the backend reinterprets (JetStream reads `max_age: 0` as unlimited) or rejects much
// later must fail at connect(), naming the field the operator actually wrote. This covers EVERY
// field the plugin reads, not just the one that prompted it: the prefixes are pasted onto a
// subject and a stream name, so a wildcard token in one silently widens a per-topic stream to
// capture a third party's subjects — an allowlisted topic delivering messages nobody allowlisted.
vi.mock('nats', async (importOriginal) => {
  const actual = await importOriginal<typeof import('nats')>();
  return {
    ...actual,
    connect: vi.fn(async () => ({
      jetstream: () => ({}),
      jetstreamManager: async () => ({}),
      drain: async () => undefined,
      close: async () => undefined,
      isClosed: () => false,
    })),
    // Wrapped, not replaced: `typeof o.authenticator === 'function'` is true of either factory's
    // output, so WHICH one ran is the only observable that can grade a documented precedence.
    credsAuthenticator: vi.fn(actual.credsAuthenticator),
    nkeyAuthenticator: vi.fn(actual.nkeyAuthenticator),
  };
});

const captured = (): ConnectionOptions =>
  vi.mocked(connect).mock.calls.at(-1)?.[0] as ConnectionOptions;

const dir = mkdtempSync(join(tmpdir(), 'parley-nats-'));
const seed = new TextDecoder().decode(nkeys.createUser().getSeed());
const credsPath = join(dir, 'user.creds');
writeFileSync(
  credsPath,
  `-----BEGIN NATS USER JWT-----\neyJhbGciOiJlZDI1NTE5LW5rZXkifQ.e30.sig\n------END NATS USER JWT------\n\n-----BEGIN USER NKEY SEED-----\n${seed}\n------END USER NKEY SEED------\n`,
);

const SECRET = 'sup3r-s3cret-value';

const cases: { name: string; config: Record<string, unknown>; check: (o: ConnectionOptions) => void }[] = [
  {
    name: 'servers',
    config: { servers: ['nats://a:4222', 'nats://b:4222'] },
    check: (o) => expect(o.servers).toEqual(['nats://a:4222', 'nats://b:4222']),
  },
  {
    name: 'token',
    config: { token: SECRET },
    check: (o) => expect(o.token).toBe(SECRET),
  },
  {
    name: 'user/pass',
    config: { user: 'alice', pass: SECRET },
    check: (o) => {
      expect(o.user).toBe('alice');
      expect(o.pass).toBe(SECRET);
    },
  },
  {
    name: 'creds_file',
    config: { creds_file: credsPath },
    check: (o) => expect(typeof o.authenticator).toBe('function'),
  },
  {
    name: 'nkey_seed',
    config: { nkey_seed: seed },
    check: (o) => expect(typeof o.authenticator).toBe('function'),
  },
  {
    name: 'tls material',
    config: { tls: { ca_file: '/tmp/ca.pem', cert_file: '/tmp/c.pem', key_file: '/tmp/k.pem' } },
    check: (o) =>
      expect(o.tls).toEqual({ caFile: '/tmp/ca.pem', certFile: '/tmp/c.pem', keyFile: '/tmp/k.pem' }),
  },
];

describe('nats backend_config — documented connection fields reach the driver', () => {
  beforeEach(() => {
    vi.mocked(connect).mockClear();
  });

  for (const c of cases) {
    it(`passes ${c.name} through to connect()`, async () => {
      const plugin = new NatsPlugin();
      await plugin.connect(c.config);
      c.check(captured());
      await plugin.disconnect();
    });
  }

  it('always asks for unbounded reconnect with a bounded, jittered wait', async () => {
    const plugin = new NatsPlugin();
    await plugin.connect({});
    const opts = captured();
    expect(opts.maxReconnectAttempts).toBe(-1);
    expect(opts.reconnectTimeWait).toBeGreaterThan(0);
    expect(opts.reconnectJitter).toBeGreaterThan(0);
    await plugin.disconnect();
  });

  const NS_PER_DAY = 86_400_000_000_000;
  const retentions: { value: unknown; maxAge?: number }[] = [
    { value: undefined, maxAge: undefined },
    { value: 30, maxAge: 30 * NS_PER_DAY },
    { value: 1, maxAge: NS_PER_DAY },
    { value: 0.5, maxAge: NS_PER_DAY / 2 },
    { value: 0 },
    { value: -0 },
    { value: -1 },
    { value: -0.5 },
    { value: Number.NaN },
    { value: Number.POSITIVE_INFINITY },
    { value: Number.NEGATIVE_INFINITY },
    { value: '30' },
    { value: 'thirty' },
    { value: null },
    { value: true },
    { value: [] },
  ];

  for (const r of retentions) {
    const label = Object.is(r.value, -0)
      ? '-0'
      : typeof r.value === 'object'
        ? JSON.stringify(r.value)
        : String(r.value);
    it(`retention_days ${label} ${r.maxAge === undefined && r.value !== undefined ? 'is rejected at connect()' : 'reaches the stream as max_age'}`, async () => {
      const plugin = new NatsPlugin();
      const config = r.value === undefined ? {} : { retention_days: r.value };

      if (r.maxAge === undefined && r.value !== undefined) {
        await expect(plugin.connect(config)).rejects.toThrow(/retention_days/);
        return;
      }

      await plugin.connect(config);
      const fake = fakeJetStream();
      injectFake(plugin, fake);
      await plugin.post(asTopic('retention'), asHandle('sys'), 'x');
      expect(fake.state.added?.max_age).toBe(r.maxAge);
      await plugin.disconnect();
    });
  }

  // Class: a value judged in the OPERATOR's unit and applied in the BACKEND's unit, where the
  // conversion can carry an accepted value OUT of the range the backend can represent — at EITHER
  // end. The rows above sit at operator scale — the smallest is twelve orders of magnitude above
  // the low boundary and the largest fifteen below the high one — so they cannot see either. These
  // are generated across the conversion itself, and the verdict is not stated per row: whichever
  // side of a boundary a row lands on, a stream that gets created must carry a max_age JetStream
  // can actually hold, because whatever it carries is locked in at creation.
  //
  // JetStream's max_age is an int64 nanosecond count and it reads 0 as UNLIMITED, so the only
  // values that mean what an operator wrote are the finite numbers in [1, 2^63). Both edges are the
  // SERVER's, measured against nats:2.10-alpine: max_age 9223372036854774784 (the largest double
  // below 2^63) is stored verbatim, 2^63 is refused with `invalid json`, and Infinity — which
  // JSON.stringify writes as `null` — is ACCEPTED and stored as max_age 0, i.e. unlimited.
  const MAX_AGE_NS_LIMIT = 2 ** 63;
  const holdable = (maxAge: number): boolean =>
    Number.isFinite(maxAge) && maxAge >= 1 && maxAge < MAX_AGE_NS_LIMIT;

  const boundaryDays: { days: number; end: 'low' | 'high' }[] = [
    { days: 1e-15, end: 'low' },
    { days: 5e-15, end: 'low' },
    { days: 1e-12, end: 'low' },
    { days: 1e-9, end: 'low' },
    { days: 1e-6, end: 'low' },
    { days: 0.2 / NS_PER_DAY, end: 'low' },
    { days: 0.5 / NS_PER_DAY, end: 'low' },
    { days: 1 / NS_PER_DAY, end: 'low' },
    { days: 2 / NS_PER_DAY, end: 'low' },
    { days: 1000 / NS_PER_DAY, end: 'low' },
    { days: 1e4, end: 'high' },
    { days: 1.06e5, end: 'high' },
    { days: 1.07e5, end: 'high' },
    { days: 1e6, end: 'high' },
    { days: 1e18, end: 'high' },
    { days: 1e294, end: 'high' },
    { days: 1e300, end: 'high' },
    { days: Number.MAX_VALUE, end: 'high' },
  ];

  interface BoundaryRow {
    days: number;
    end: 'low' | 'high';
    maxAge: number | 'refused';
    /** What `max_age` survives as once the config is serialized — `Infinity` does not. */
    onTheWire: unknown;
  }

  const composedMaxAge = async (days: number): Promise<Omit<BoundaryRow, 'days' | 'end'>> => {
    const plugin = new NatsPlugin();
    const err = await plugin
      .connect({ retention_days: days })
      .then(() => undefined, (e: unknown) => e);
    if (err !== undefined) {
      expect(String(err)).toContain('retention_days');
      return { maxAge: 'refused', onTheWire: 'refused' };
    }
    const fake = fakeJetStream();
    injectFake(plugin, fake);
    await plugin.post(asTopic('retention'), asHandle('sys'), 'x');
    await plugin.disconnect();
    const added = fake.state.added ?? {};
    const wire = JSON.parse(JSON.stringify(added)) as { max_age?: unknown };
    return { maxAge: added.max_age ?? Number.NaN, onTheWire: wire.max_age };
  };

  const composedBoundary = async (): Promise<BoundaryRow[]> => {
    const out: BoundaryRow[] = [];
    for (const row of boundaryDays) out.push({ ...row, ...(await composedMaxAge(row.days)) });
    return out;
  };

  it('no accepted retention_days composes a max_age JetStream cannot hold', async () => {
    const composed = await composedBoundary();
    const unholdable = composed.filter((r) => r.maxAge !== 'refused' && !holdable(r.maxAge));
    expect(unholdable).toEqual([]);
  });

  // The clause no numeric range assertion on the JS value can see: a max_age that means one thing
  // in the process and another once it is serialized. Infinity becomes null, which the server
  // stores as 0 — unlimited.
  it('every accepted retention_days composes a max_age that survives serialization', async () => {
    const composed = await composedBoundary();
    const lost = composed.filter((r) => r.maxAge !== 'refused' && r.onTheWire !== r.maxAge);
    expect(lost).toEqual([]);
  });

  // A generator is worth what it emits: rows that were all refused, or all accepted, would grade
  // the invariants above against nothing — and one that straddles only ONE boundary grades only
  // that end, which is how the high end shipped unguarded.
  it('the boundary rows straddle the conversion at both ends — some refused, some accepted', async () => {
    const composed = await composedBoundary();
    const straddle = (['low', 'high'] as const).map((end) => {
      const rows = composed.filter((r) => r.end === end);
      return {
        end,
        refused: rows.some((r) => r.maxAge === 'refused'),
        accepted: rows.some((r) => r.maxAge !== 'refused'),
      };
    });
    expect(straddle).toEqual([
      { end: 'low', refused: true, accepted: true },
      { end: 'high', refused: true, accepted: true },
    ]);
  });


  const prefixes: { field: 'subject_prefix' | 'stream_prefix'; value: unknown; accepted?: true }[] = [
    { field: 'subject_prefix', value: 'parley.', accepted: true },
    { field: 'subject_prefix', value: '', accepted: true },
    { field: 'subject_prefix', value: 'a.b.c.', accepted: true },
    { field: 'subject_prefix', value: 'pw.*.' },
    { field: 'subject_prefix', value: '*.' },
    { field: 'subject_prefix', value: 'pw.>.' },
    { field: 'subject_prefix', value: '>' },
    { field: 'subject_prefix', value: 'pw x.' },
    { field: 'subject_prefix', value: 'pw\t.' },
    { field: 'subject_prefix', value: 'pw\n.' },
    { field: 'subject_prefix', value: 'pw\u0000.' },
    { field: 'subject_prefix', value: 42 },
    { field: 'subject_prefix', value: null },
    { field: 'subject_prefix', value: ['parley.'] },
    { field: 'stream_prefix', value: 'PARLEY_', accepted: true },
    { field: 'stream_prefix', value: '', accepted: true },
    { field: 'stream_prefix', value: 'PB.x_' },
    { field: 'stream_prefix', value: 'PB x_' },
    { field: 'stream_prefix', value: 'PB*_' },
    { field: 'stream_prefix', value: 'PB>_' },
    { field: 'stream_prefix', value: 'PB/x_' },
    { field: 'stream_prefix', value: 'PB\\x_' },
    { field: 'stream_prefix', value: 'PB\u0000_' },
    { field: 'stream_prefix', value: 7 },
    { field: 'stream_prefix', value: {} },
  ];

  for (const row of prefixes) {
    const label = typeof row.value === 'string' ? JSON.stringify(row.value) : String(row.value);
    it(`${row.field} ${label} ${row.accepted === true ? 'is accepted' : 'is rejected at connect(), naming the field'}`, async () => {
      const plugin = new NatsPlugin();
      const config = { [row.field]: row.value };

      if (row.accepted === true) {
        await plugin.connect(config);
        await plugin.disconnect();
        return;
      }
      const err = await plugin.connect(config).then(() => undefined, (e: unknown) => e);
      expect(String(err)).toContain(row.field);
      expect(vi.mocked(connect)).not.toHaveBeenCalled();
    });
  }

  // The same contract stated as a PROPERTY of the composed name rather than as a list of characters:
  // a prefix is legal exactly when `<prefix><topic token>` is a legal literal NATS name. Separator
  // placement is what the character list cannot see — every character of `parley..` is allowed, and
  // the empty token it composes is not a subject any server will accept.
  const PROBE = 'topic';
  const composedCases = ['', 'a', 'a.', 'a.b', 'a.b.c.', '.', '..', '.a.', 'a..', 'a..b.', 'a.b..c.'];

  for (const field of ['subject_prefix', 'stream_prefix'] as const) {
    for (const value of composedCases) {
      const composed = value + PROBE;
      const legal = field === 'subject_prefix' ? legalSubject(composed) : legalStreamName(composed);
      it(`${field} ${JSON.stringify(value)} composes ${JSON.stringify(composed)}, which is ${legal ? 'legal — accepted' : 'illegal — rejected at connect()'}`, async () => {
        const plugin = new NatsPlugin();
        const err = await plugin.connect({ [field]: value }).then(() => undefined, (e: unknown) => e);

        if (legal) {
          expect(err).toBeUndefined();
          await plugin.disconnect();
          return;
        }
        expect(String(err)).toContain(field);
        expect(vi.mocked(connect)).not.toHaveBeenCalled();
      });
    }
  }

  // The same contract on its LENGTH axis. JetStream caps a stream name at 255 bytes, and the name
  // is composed from a field the operator writes and a topic a CALLER can name through `post_topics`
  // — so the refusal has to say which half is over, on both the write and the read path. The rows
  // sit exactly either side of the limit, from both directions, so any bound that is off by one
  // fails here rather than at someone's first post.
  const MAX_STREAM_NAME = 255;
  const rep = (n: number): string => 'a'.repeat(n);

  const prefixLengths: { name: string; value: string; accepted?: true }[] = [
    { name: `composes exactly ${MAX_STREAM_NAME}`, value: rep(MAX_STREAM_NAME - PROBE.length), accepted: true },
    { name: `composes ${MAX_STREAM_NAME + 1}`, value: rep(MAX_STREAM_NAME - PROBE.length + 1) },
    { name: 'is far past the limit', value: rep(400) },
  ];

  for (const row of prefixLengths) {
    it(`stream_prefix that ${row.name} is ${row.accepted === true ? 'accepted' : 'rejected at connect(), naming the field'}`, async () => {
      const plugin = new NatsPlugin();
      const err = await plugin
        .connect({ stream_prefix: row.value })
        .then(() => undefined, (e: unknown) => e);

      if (row.accepted === true) {
        expect(err).toBeUndefined();
        await plugin.disconnect();
        return;
      }
      expect(String(err)).toContain('stream_prefix');
      expect(String(err)).toContain(String(MAX_STREAM_NAME));
      expect(vi.mocked(connect)).not.toHaveBeenCalled();
    });
  }

  const topicLengths: { prefix: string; topicLen: number; accepted?: true }[] = [
    { prefix: 'P_', topicLen: MAX_STREAM_NAME - 2, accepted: true },
    { prefix: 'P_', topicLen: MAX_STREAM_NAME - 1 },
    { prefix: rep(MAX_STREAM_NAME - PROBE.length), topicLen: PROBE.length, accepted: true },
    { prefix: rep(MAX_STREAM_NAME - PROBE.length), topicLen: PROBE.length + 1 },
    { prefix: 'P_', topicLen: 1000 },
  ];

  for (const row of topicLengths) {
    const composed = row.prefix.length + row.topicLen;
    for (const call of ['post', 'fetchRecent'] as const) {
      it(`${call} on a topic composing a ${composed}-byte stream name is ${row.accepted === true ? 'accepted' : 'refused, naming the topic and stream_prefix'}`, async () => {
        const plugin = new NatsPlugin();
        await plugin.connect({ stream_prefix: row.prefix });
        const topic = asTopic(rep(row.topicLen));
        // A refused name throws before any I/O, so only the accepted rows need a backend at all.
        if (row.accepted === true) injectFake(plugin, fakeJetStream({ records: [] }), topic);

        const err = await (call === 'post'
          ? plugin.post(topic, asHandle('sys'), 'x')
          : plugin.fetchRecent({ topic })
        ).then(() => undefined, (e: unknown) => e);

        if (row.accepted === true) {
          expect(err).toBeUndefined();
          await plugin.disconnect();
          return;
        }
        expect(String(err)).toContain('stream_prefix');
        expect(String(err)).toContain(String(MAX_STREAM_NAME));
        expect(String(err)).toContain(JSON.stringify(String(topic)));
        await plugin.disconnect();
      });
    }
  }

  it('the composed-name predicate rejects an empty token and spares a legal name', () => {
    expect(legalSubject('parley.topic')).toBe(true);
    expect(legalSubject('parley..topic')).toBe(false);
    expect(legalSubject('.topic')).toBe(false);
    expect(legalStreamName('PARLEY_topic')).toBe(true);
    expect(legalStreamName('PARLEY.topic')).toBe(false);
  });

  // Class 3: a prefix that diverges from the instance that created the stream is a BROKEN bridge,
  // not split history — the stream that exists captures a subject this instance never publishes to.
  // Whatever the plugin does about it, the error must name the field the operator can actually
  // change; a driver error naming neither sends them hunting for the wrong fault.
  const divergences: {
    name: string;
    state: { addFails: 'name-in-use' | 'subject-overlap'; subjects?: string[] };
    names: RegExp;
  }[] = [
    {
      name: 'the stream exists but captures another config’s subject',
      state: { addFails: 'name-in-use', subjects: ['other.deploys'] },
      names: /subject_prefix[\s\S]*stream_prefix|stream_prefix[\s\S]*subject_prefix/,
    },
    {
      name: 'the stream name is new but another stream already captures the subject',
      state: { addFails: 'subject-overlap' },
      names: /stream_prefix/,
    },
  ];

  for (const divergence of divergences) {
    for (const call of ['post', 'fetchRecent'] as const) {
      it(`${call} rejects naming the diverging field when ${divergence.name}`, async () => {
        const plugin = new NatsPlugin();
        await plugin.connect({});
        injectFake(plugin, fakeJetStream(divergence.state));

        const topic = asTopic('deploys');
        const err = await (call === 'post'
          ? plugin.post(topic, asHandle('sys'), 'x')
          : plugin.fetchRecent({ topic })
        ).then(() => undefined, (e: unknown) => e);

        expect(String(err)).toMatch(divergence.names);
        await plugin.disconnect();
      });
    }
  }

  it('an existing stream whose wildcard subject already covers this topic is accepted', async () => {
    const plugin = new NatsPlugin();
    await plugin.connect({});
    const fake = fakeJetStream({ addFails: 'name-in-use', subjects: ['parley.>'] });
    injectFake(plugin, fake);

    await plugin.post(asTopic('deploys'), asHandle('sys'), 'x');
    expect(fake.state.records).toHaveLength(1);
    await plugin.disconnect();
  });

  // The consequence a wildcard prefix has, stated as behaviour rather than as a character class:
  // the stream a topic maps to must cover that topic's subject and nothing else.
  it('a rejected prefix can never widen a topic subject to match a foreign one', async () => {
    const plugin = new NatsPlugin();
    await expect(plugin.connect({ subject_prefix: 'pw.*.' })).rejects.toThrow(/subject_prefix/);

    const names = plugin as unknown as { subject: (t: never) => string };
    expect(names.subject(asTopic('deploys') as never)).toBe('parley.deploys');
  });

  for (const c of cases.filter((x) => JSON.stringify(x.config).includes(SECRET))) {
    it(`never echoes the ${c.name} secret in a connection failure`, async () => {
      vi.mocked(connect).mockRejectedValueOnce(new Error('AUTHORIZATION_VIOLATION'));
      const plugin = new NatsPlugin();
      const err = await plugin.connect(c.config).catch((e: unknown) => e);
      expect(String(err)).not.toContain(SECRET);
      expect((err as Error).stack ?? '').not.toContain(SECRET);
    });
  }
});

// Class: a backend_config key the plugin does not recognise is silently ignored. Every field here is
// either a credential or an addressing decision, so the silence is expensive in both directions: a
// misspelled `token` connects anonymously while the operator believes the cluster is authenticated,
// and a misspelled `subject_prefix` addresses a different stream than the sibling session it was
// meant to share with. The near misses are generated off the declared interface rather than listed,
// so a field added later is policed by default. The `cases` table above is the neighbouring test
// that cannot reach this: every row spells its key correctly.
// The generator walks the declared shape to its LEAVES, because a check that policed only the
// outermost level is exactly how `tls: { ca_flie: … }` shipped: accepted, dropped, and the link
// verified against the system trust store instead of the pinned CA with nothing said. The three
// ways a declared value can be wrong are crossed as dimensions — a typo at the leaf, a leaf holding
// something other than what it is declared to hold, and a container that is not an object at all —
// so a nested field added later is graded on all three by default.
describe('nats backend_config — an unrecognised key is refused, not dropped', () => {
  beforeEach(() => {
    vi.mocked(connect).mockClear();
  });

  const declared = declaredConfigKeys();
  const paths = declaredConfigPaths();
  const nearMisses = (key: string): string[] => [
    key.slice(0, -1),
    `${key.slice(0, -2)}${key.at(-1) ?? ''}${key.at(-2) ?? ''}`,
    `${key}s`,
    key.toUpperCase(),
  ];

  /** Names declared alongside `path` at ITS level — a near miss that spells one of them is not one. */
  const siblingsOf = (path: string): string[] => {
    const cut = path.lastIndexOf('.');
    if (cut < 0) return declared;
    const parent = path.slice(0, cut + 1);
    return paths.filter((p) => p.startsWith(parent)).map((p) => p.slice(parent.length));
  };

  const typos = [
    ...new Set(
      paths.flatMap((path) => {
        const cut = path.lastIndexOf('.');
        const parent = path.slice(0, cut + 1);
        const known = siblingsOf(path);
        return nearMisses(path.slice(cut + 1))
          .filter((t) => !known.includes(t))
          .map((t) => `${parent}${t}`);
      }),
    ),
  ];

  /** `{ tls: { ca_flie: v } }` from `'tls.ca_flie'` — the config an operator would actually write. */
  const configAt = (path: string, value: unknown): Record<string, unknown> => {
    const cut = path.indexOf('.');
    return cut < 0
      ? { [path]: value }
      : { [path.slice(0, cut)]: { [path.slice(cut + 1)]: value } };
  };

  const containers = [
    ...new Set(paths.filter((p) => p.includes('.')).map((p) => p.slice(0, p.indexOf('.')))),
  ];

  it('generates a near miss for every declared path, nested members included', () => {
    expect(declared).toContain('nkey_seed');
    expect(paths).toContain('nkey_seed');
    expect(paths).toContain('tls.ca_file');
    expect(containers.length).toBeGreaterThan(0);
    expect(typos).toContain('tokens');
    expect(typos).toContain('tls.ca_files');
    expect(typos.filter((t) => t.includes('.')).length).toBeGreaterThanOrEqual(9);
    expect(typos.length).toBeGreaterThanOrEqual(paths.length * 3);
  });

  for (const typo of typos) {
    it(`refuses backend_config.${typo}, naming the key, before connecting`, async () => {
      const plugin = new NatsPlugin();

      const err = await plugin
        .connect({ servers: '127.0.0.1:4222', ...configAt(typo, 'x') })
        .then(() => undefined, (e: unknown) => e);

      expect(String(err)).toContain(typo);
      expect(vi.mocked(connect)).not.toHaveBeenCalled();
    });
  }

  const NOT_A_STRING: unknown[] = [true, 42, null, [], {}, ['/tmp/ca.pem']];

  for (const path of paths.filter((p) => p.includes('.'))) {
    for (const value of NOT_A_STRING) {
      it(`refuses backend_config.${path} holding ${JSON.stringify(value)}, naming the key`, async () => {
        const plugin = new NatsPlugin();

        const err = await plugin
          .connect(configAt(path, value))
          .then(() => undefined, (e: unknown) => e);

        expect(String(err)).toContain(path);
        expect(vi.mocked(connect)).not.toHaveBeenCalled();
      });
    }
  }

  // `tls: true` is the sharpest of these: it supplies no material at all, and merely being defined
  // is what `plaintextCredentialRisks` reads as proof the link will be encrypted.
  const NOT_AN_OBJECT: unknown[] = [true, false, 'yes', '/tmp/ca.pem', 42, null, [], ['/tmp/ca.pem']];

  for (const container of containers) {
    for (const value of NOT_AN_OBJECT) {
      it(`refuses backend_config.${container} holding ${JSON.stringify(value)} instead of an object`, async () => {
        const plugin = new NatsPlugin();

        const err = await plugin
          .connect({ [container]: value, token: SECRET })
          .then(() => undefined, (e: unknown) => e);

        expect(String(err)).toContain(`backend_config.${container}`);
        expect(String(err)).not.toContain(SECRET);
        expect(vi.mocked(connect)).not.toHaveBeenCalled();
      });
    }
  }

  // The rule is "no UNKNOWN member", never "at least one known member": an empty `tls` is how an
  // operator asks for encryption with the material left to the system trust store, and it is what
  // the live transport-agreement fixture connects with.
  for (const container of containers) {
    it(`accepts an empty backend_config.${container}`, async () => {
      const plugin = new NatsPlugin();
      await plugin.connect({ [container]: {} });
      await plugin.disconnect();
      expect(vi.mocked(connect)).toHaveBeenCalledTimes(1);
    });
  }

  it('accepts a config that sets every declared key at once', async () => {
    const full: Record<string, unknown> = {
      servers: '127.0.0.1:4222',
      subject_prefix: 'parley.',
      stream_prefix: 'PARLEY_',
      retention_days: 30,
      token: SECRET,
      user: 'alice',
      pass: SECRET,
      creds_file: credsPath,
      nkey_seed: seed,
      tls: { ca_file: '/tmp/ca.pem' },
    };
    expect(Object.keys(full).sort()).toEqual([...declared].sort());

    const plugin = new NatsPlugin();
    await plugin.connect(full);
    await plugin.disconnect();
    expect(vi.mocked(connect)).toHaveBeenCalledTimes(1);
  });
});

// Class: a documented precedence between two config fields that can both be set. Both auth
// factories return a function, so `typeof o.authenticator === 'function'` holds whichever one ran —
// the assertion has to be on WHICH credential reached the driver. One row per pair of credential
// groups, with the groups derived from the declared interface, so a new auth field arrives with no
// declared outcome rather than silently untested.
describe('nats auth precedence — which credential reaches the driver when two are set', () => {
  beforeEach(() => {
    vi.mocked(connect).mockClear();
    vi.mocked(credsAuthenticator).mockClear();
    vi.mocked(nkeyAuthenticator).mockClear();
  });

  const groups = {
    token: { fields: ['token'], config: { token: SECRET }, reached: () => captured().token === SECRET },
    'user/pass': {
      fields: ['user', 'pass'],
      config: { user: 'alice', pass: SECRET },
      reached: () => captured().user === 'alice' && captured().pass === SECRET,
    },
    creds_file: {
      fields: ['creds_file'],
      config: { creds_file: credsPath },
      reached: () => vi.mocked(credsAuthenticator).mock.calls.length === 1,
    },
    nkey_seed: {
      fields: ['nkey_seed'],
      config: { nkey_seed: seed },
      reached: () => vi.mocked(nkeyAuthenticator).mock.calls.length === 1,
    },
  } as const;

  type Group = keyof typeof groups;
  const names = Object.keys(groups) as Group[];

  it('every declared credential field belongs to exactly one group', () => {
    const NON_AUTH = ['servers', 'subject_prefix', 'stream_prefix', 'retention_days', 'tls'];
    const grouped = names.flatMap((n) => [...groups[n].fields]);
    expect([...grouped, ...NON_AUTH].sort()).toEqual([...declaredConfigKeys()].sort());
  });

  // `wins` names the groups whose credential must still reach the driver with both set. NATS itself
  // arbitrates a token against user/pass, so those pairs are both-reach; the README promises
  // creds_file over nkey_seed, and that is the one pair with a loser.
  const pairs: { a: Group; b: Group; wins: Group[] }[] = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = names[i] as Group;
      const b = names[j] as Group;
      const exclusive = a === 'creds_file' && b === 'nkey_seed';
      pairs.push({ a, b, wins: exclusive ? [a] : [a, b] });
    }
  }

  it('covers every pair of credential groups', () => {
    expect(pairs).toHaveLength((names.length * (names.length - 1)) / 2);
  });

  for (const pair of pairs) {
    it(`${pair.a} + ${pair.b} both set: ${pair.wins.join(' and ')} reach${pair.wins.length === 1 ? 'es' : ''} the driver`, async () => {
      const plugin = new NatsPlugin();
      await plugin.connect({ ...groups[pair.a].config, ...groups[pair.b].config });

      const reached = [pair.a, pair.b].filter((g) => groups[g].reached());
      expect(reached).toEqual(pair.wins);
      await plugin.disconnect();
    });
  }
});

// Class: a credential-bearing config that would put the secret on an unencrypted remote link must
// SAY SO. A NATS credential rides the CONNECT frame of the first round trip, and nats.js upgrades a
// `nats://` link only when `tls` asks it to — so this is not refused (a loopback fixture and a
// TLS-terminating sidecar are both legitimate), it is reported. The table crosses every dimension
// that can independently flip the answer: the scheme, the host's class, whether `tls` is set, and
// whether there is a secret to expose at all. The `never echoes the secret` rows below are the
// neighbouring test that cannot reach this: they grade the failure message, not the transport.
describe('nats transport safety — a credential on an unencrypted remote link warns', () => {
  const warningsFrom = async (config: Record<string, unknown>): Promise<string[]> => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const plugin = new NatsPlugin();
      await plugin.connect(config);
      await plugin.disconnect();
      return warn.mock.calls.map((c) => String(c[0]));
    } finally {
      warn.mockRestore();
    }
  };

  // Every spelling an operator might write, including schemes no NATS client defines. nats.js
  // strips the scheme in `hostPort()` before it dials and decides encryption from `tls` and the
  // server's INFO alone, so none of these selects a transport and none may move the answer. The
  // unknown ones are listed because an allowlist of "encrypted" schemes silently excused them —
  // `tls://` bought no encryption and suppressed the warning that said so.
  const SCHEMES = ['nats://', 'ws://', '', 'tls://', 'wss://', 'nats+tls://', 'http://', 'gopher://'];
  const LOOPBACK_HOSTS = ['127.0.0.1:4222', 'localhost:4222', '[::1]:4222', '127.0.0.44'];
  // Hosts that read as loopback to a prefix or substring match but are ordinary registrable names
  // their owner points wherever they like, plus two integer spellings of 127.0.0.1.
  const LOOKALIKE_HOSTS = ['127.0.0.1.evil.com', 'localhost.evil.com', '2130706433', '0177.0.0.1'];
  const REMOTE_HOSTS = ['nats.example.com:4222', '203.0.113.9:4222', ...LOOKALIKE_HOSTS];

  // The invariant, stated without a scheme term: the answer is a function of the HOST alone. An
  // allowlist keyed on the scheme cannot satisfy this no matter which schemes it lists.
  it('the scheme never moves the answer — the driver discards it before dialling', () => {
    for (const scheme of SCHEMES) {
      expect(plaintextRemoteServer(`${scheme}remote.example:4222`)).toBeDefined();
      expect(plaintextRemoteServer(`${scheme}127.0.0.1:4222`)).toBeUndefined();
    }
  });

  it.each(LOOKALIKE_HOSTS)('%s is classified remote, not loopback', (host) => {
    expect(plaintextRemoteServer(`nats://${host}`)).toBeDefined();
  });

  const cells: { server: string; secret: boolean; tls: boolean; warns: boolean }[] = [];
  for (const scheme of SCHEMES) {
    for (const [hosts, loopback] of [
      [LOOPBACK_HOSTS, true],
      [REMOTE_HOSTS, false],
    ] as const) {
      for (const host of hosts) {
        for (const secret of [true, false]) {
          for (const tls of [true, false]) {
            cells.push({
              server: `${scheme}${host}`,
              secret,
              tls,
              warns: !loopback && secret && !tls,
            });
          }
        }
      }
    }
  }

  it.each(cells)(
    'servers $server (secret $secret, tls $tls) warns as documented',
    async ({ server, secret, tls, warns }) => {
      const warned = await warningsFrom({
        servers: server,
        ...(secret ? { token: SECRET } : {}),
        ...(tls ? { tls: { ca_file: '/tmp/ca.pem' } } : {}),
      });

      expect(warned).toHaveLength(warns ? 1 : 0);
      for (const line of warned) {
        expect(line).toContain('parley-nats');
        expect(line).toContain(server);
        expect(line).toContain('token');
        expect(line).not.toContain(SECRET);
      }
    },
  );

  // Every field that IS a credential has to be named by the warning; a field that is not must not
  // raise one on its own. Derived from the same `cases` table the pass-through rows use, so a new
  // auth field is unpoliced-by-default rather than silently exempt.
  const credentialKeys = ['token', 'user', 'pass', 'creds_file', 'nkey_seed'];

  it('every documented auth field is one of the credentials this warning knows about', () => {
    for (const key of credentialKeys) expect(declaredConfigKeys()).toContain(key);
  });

  it.each(cases)('$name on a remote plaintext server names the field it would expose', async (c) => {
    const exposed = Object.keys(c.config).filter((k) => credentialKeys.includes(k));
    const warned = await warningsFrom({ ...c.config, servers: 'nats://nats.example.com:4222' });

    expect(warned).toHaveLength(exposed.length === 0 ? 0 : 1);
    for (const field of exposed) expect(warned[0]).toContain(field);
    for (const line of warned) expect(line).not.toContain(SECRET);
  });

  it('the warning names the server with any userinfo redacted', () => {
    expect(plaintextRemoteServer('nats://alice:hunter2@remote.example:4222')).toBe(
      'nats://<redacted>@remote.example:4222',
    );
    expect(plaintextRemoteServer('nats://alice:hunter2@127.0.0.1:4222')).toBeUndefined();
  });

  // The `tls://` entry warns like the rest: it is a remote host, and the scheme buys it nothing.
  it('warns once per offending entry when servers is a list', async () => {
    const warned = await warningsFrom({
      servers: ['nats://127.0.0.1:4222', 'nats://a.example.com:4222', 'tls://b.example.com:4222', 'nats://c.example.com:4222'],
      token: SECRET,
    });

    expect(warned).toHaveLength(3);
    expect(warned.map((l) => (/servers "([^"]+)"/.exec(l) ?? [])[1])).toEqual([
      'nats://a.example.com:4222',
      'tls://b.example.com:4222',
      'nats://c.example.com:4222',
    ]);
  });
});

// Class: a credential the operator supplied must never come back OUT of the plugin — not in a
// warning, not in an error, not in a stack — and a credential the driver will not use must not be
// accepted in silence. `nats://user:pass@host` is the standard NATS spelling, and nats.js keeps only
// `url.host` of it (`servers.js` `hostPort()`), so the link is opened anonymously; meanwhile the
// warning above interpolated the entry verbatim and printed the password. Every axis that selects a
// different diagnostic path is crossed — the scheme, the host's class, `tls`, and whether a
// credential FIELD is set as well — because the leak is a property of the path, not of the address.
// The scheme is crossed to prove it selects NOTHING: nats.js discards it, so it may not move either
// the refusal or the warning. One representative host per class: the lookalike-host rows of the
// table above cannot flip anything on this axis.
describe('nats transport safety — a credential in the servers URL is refused, never echoed', () => {
  const URL_SECRET = 'url-p4ssw0rd';

  const diagnosticsFrom = async (
    config: Record<string, unknown>,
  ): Promise<{ warnings: string[]; error: string }> => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const plugin = new NatsPlugin();
      const err = await plugin.connect(config).then(() => undefined, (e: unknown) => e);
      if (err === undefined) await plugin.disconnect();
      return {
        warnings: warn.mock.calls.map((c) => String(c[0])),
        error: err === undefined ? '' : `${String(err)}\n${(err as Error).stack ?? ''}`,
      };
    } finally {
      warn.mockRestore();
    }
  };

  const userinfos = [
    { name: 'no userinfo', prefix: '' },
    { name: 'a user', prefix: 'alice@' },
    { name: 'a user and password', prefix: `alice:${URL_SECRET}@` },
    // Userinfo ends at the LAST `@` — a split on the first one leaves the tail of the password in
    // whatever the diagnostic prints.
    { name: 'a password holding an @', prefix: `alice:pa@${URL_SECRET}@` },
  ];
  const REMOTE = 'nats.example.com:4222';
  const addresses = [
    { scheme: 'nats://', host: REMOTE, loopback: false },
    { scheme: 'tls://', host: REMOTE, loopback: false },
    { scheme: 'nats://', host: '127.0.0.1:4222', loopback: true },
    { scheme: '', host: REMOTE, loopback: false },
  ];

  beforeEach(() => {
    vi.mocked(connect).mockClear();
  });

  for (const userinfo of userinfos) {
    for (const address of addresses) {
      for (const field of [true, false]) {
        for (const tls of [true, false]) {
          const server = `${address.scheme}${userinfo.prefix}${address.host}`;
          const refused = userinfo.prefix !== '';
          const warns = !refused && !address.loopback && field && !tls;

          it(`servers ${server} (credential field ${field}, tls ${tls}) ${refused ? 'is refused at connect()' : `warns ${warns ? 'once' : 'not at all'}`}`, async () => {
            const { warnings, error } = await diagnosticsFrom({
              servers: server,
              ...(field ? { token: SECRET } : {}),
              ...(tls ? { tls: { ca_file: '/tmp/ca.pem' } } : {}),
            });

            // The property that holds on EVERY row: nothing the config supplied comes back out.
            for (const line of [...warnings, error]) {
              expect(line).not.toContain(SECRET);
              expect(line).not.toContain(URL_SECRET);
            }

            if (refused) {
              expect(error).toContain('backend_config.servers');
              expect(error).toContain(`${address.scheme}<redacted>@${address.host}`);
              expect(warnings).toEqual([]);
              expect(vi.mocked(connect)).not.toHaveBeenCalled();
              return;
            }
            expect(error).toBe('');
            expect(warnings).toHaveLength(warns ? 1 : 0);
          });
        }
      }
    }
  }

  it('refuses a list whose OTHER entry carries the credential', async () => {
    const { error, warnings } = await diagnosticsFrom({
      servers: ['nats://127.0.0.1:4222', `nats://bob:${URL_SECRET}@b.example.com:4222`],
      token: SECRET,
    });

    expect(error).toContain('backend_config.servers');
    expect(error).not.toContain(URL_SECRET);
    for (const line of warnings) expect(line).not.toContain(URL_SECRET);
    expect(vi.mocked(connect)).not.toHaveBeenCalled();
  });

  // The redaction is what both diagnostics name a server through, so it is graded on the spellings
  // an address can actually take rather than only on the one the refusal above happens to use.
  const redactions: { server: string; redacted: string }[] = [
    { server: 'nats://alice:hunter2@example.com:4222', redacted: 'nats://<redacted>@example.com:4222' },
    { server: 'alice:hunter2@example.com:4222', redacted: '<redacted>@example.com:4222' },
    { server: 'nats://alice@example.com:4222', redacted: 'nats://<redacted>@example.com:4222' },
    // A password may itself hold an `@`: userinfo ends at the LAST one, so a first-`@` split leaks.
    { server: 'nats://alice:hun@ter2@example.com:4222', redacted: 'nats://<redacted>@example.com:4222' },
    { server: 'ws://alice:hunter2@[::1]:4222/nats', redacted: 'ws://<redacted>@[::1]:4222/nats' },
    { server: 'nats://example.com:4222', redacted: 'nats://example.com:4222' },
    { server: 'example.com:4222', redacted: 'example.com:4222' },
    { server: '  nats://example.com:4222  ', redacted: 'nats://example.com:4222' },
  ];

  for (const row of redactions) {
    it(`redacts ${JSON.stringify(row.server)}`, () => {
      expect(redactUserinfo(row.server)).toBe(row.redacted);
    });
  }
});

// Class: a decision function reachable only through a rarely-configured path. `captures` is what
// decides whether a PRE-EXISTING stream really covers this topic's subject — the only thing standing
// between an operator's `parley.*` stream and either a spurious "differs from the instance that
// created it" refusal or, in the other direction, an accepted stream that never carries the topic.
// The one wildcard case above uses `parley.>`, so the single-token `*` arm was reachable by no test
// at all. Driven from a generator as well as a table, so arities and wildcard positions no
// hand-picked pair reaches are covered, and a future prefix change that alters token counts fails
// here rather than in a live stream.
describe('nats subject interest — captures(pattern, subject)', () => {
  const rows: { pattern: string; subject: string; captured: boolean }[] = [
    { pattern: 'parley.deploys', subject: 'parley.deploys', captured: true },
    { pattern: 'parley.deploys', subject: 'parley.deploy', captured: false },
    { pattern: 'parley.*', subject: 'parley.deploys', captured: true },
    { pattern: 'parley.*', subject: 'parley.deploys.eu', captured: false },
    { pattern: 'parley.*', subject: 'parley', captured: false },
    { pattern: '*.deploys', subject: 'parley.deploys', captured: true },
    { pattern: '*.deploys', subject: 'other.deploys', captured: true },
    { pattern: '*', subject: 'parley', captured: true },
    { pattern: '*', subject: 'parley.deploys', captured: false },
    { pattern: 'a.*.c', subject: 'a.b.c', captured: true },
    { pattern: 'a.*.c', subject: 'a.b.d', captured: false },
    { pattern: 'a.*.c', subject: 'a.c', captured: false },
    { pattern: 'parley.>', subject: 'parley.deploys', captured: true },
    { pattern: 'parley.>', subject: 'parley.deploys.eu', captured: true },
    { pattern: 'parley.>', subject: 'parley', captured: false },
    { pattern: '>', subject: 'parley', captured: true },
    { pattern: 'parley.*.>', subject: 'parley.eu.deploys', captured: true },
    { pattern: 'parley.*.>', subject: 'parley.eu', captured: false },
    { pattern: 'parley.deploys', subject: 'parley.deploys.eu', captured: false },
    { pattern: 'parley.deploys.eu', subject: 'parley.deploys', captured: false },
  ];

  for (const row of rows) {
    it(`${row.pattern} ${row.captured ? 'captures' : 'does not capture'} ${row.subject}`, () => {
      expect(captures(row.pattern, row.subject)).toBe(row.captured);
    });
  }

  /** Independent oracle: NATS interest as a regex over the same token rules. */
  const oracle = (pattern: string, subject: string): boolean =>
    new RegExp(
      `^${pattern
        .split('.')
        .map((t) => (t === '*' ? '[^.]+' : t === '>' ? '[^.]+(\\.[^.]+)*' : t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
        .join('\\.')}$`,
    ).test(subject);

  const rnd = (seed: number): (() => number) => {
    let s = seed;
    return () => {
      s = (s * 1103515245 + 12345) % 2147483648;
      return s / 2147483648;
    };
  };

  const generated = ((): { pattern: string; subject: string }[] => {
    const next = rnd(7);
    const tokens = ['a', 'b', 'c', 'deploys'];
    const token = (): string => tokens[Math.floor(next() * tokens.length)] as string;
    return Array.from({ length: 2000 }, () => {
      const subject = Array.from({ length: 1 + Math.floor(next() * 4) }, token).join('.');
      const parts = Array.from({ length: 1 + Math.floor(next() * 4) }, token);
      const at = Math.floor(next() * parts.length);
      const shape = next();
      if (shape < 0.4) parts[at] = '*';
      else if (shape < 0.6) parts.splice(at, parts.length - at, '>');
      return { pattern: parts.join('.'), subject };
    });
  })();

  it('agrees with an independent matcher over generated patterns and subjects', () => {
    const disagreements = generated
      .filter((g) => captures(g.pattern, g.subject) !== oracle(g.pattern, g.subject))
      .map((g) => `${g.pattern} vs ${g.subject}`);
    expect(disagreements).toEqual([]);
  });

  // A generator is worth what it emits: agreement over 2000 exact-match pairs would grade nothing.
  it('emits both wildcards, in every position, and misses as well as matches', () => {
    const held = (test: (g: { pattern: string; subject: string }) => boolean): number =>
      generated.filter(test).length;
    expect(held((g) => g.pattern.startsWith('*.'))).toBeGreaterThan(20);
    expect(held((g) => /\.\*\./.test(g.pattern))).toBeGreaterThan(20);
    expect(held((g) => g.pattern.endsWith('.*'))).toBeGreaterThan(20);
    expect(held((g) => g.pattern.includes('>'))).toBeGreaterThan(20);
    expect(held((g) => captures(g.pattern, g.subject))).toBeGreaterThan(100);
    expect(held((g) => !captures(g.pattern, g.subject))).toBeGreaterThan(100);
    expect(new Set(generated.map((g) => g.subject.split('.').length)).size).toBe(4);
  });
});
