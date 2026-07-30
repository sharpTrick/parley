import { asHandle, asTopic } from '@sharptrick/parley-core';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, nkeys, type ConnectionOptions } from 'nats';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NatsPlugin } from '../src/index.js';
import { fakeJetStream, injectFake } from './fake-jetstream.js';

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
  const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f]');
  const legalSubject = (name: string): boolean =>
    name.length > 0 &&
    name.split('.').every((token) => token.length > 0 && !/[*>\s]/.test(token) && !CONTROL.test(token));
  const legalStreamName = (name: string): boolean =>
    name.length > 0 && !/[.*>/\\\s]/.test(name) && !CONTROL.test(name);

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
