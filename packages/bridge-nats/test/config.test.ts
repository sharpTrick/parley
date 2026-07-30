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
import { captures, NatsPlugin, plaintextRemoteServer } from '../src/index.js';
import { fakeJetStream, injectFake } from './fake-jetstream.js';
import { declaredConfigKeys, legalStreamName, legalSubject } from './helpers.js';

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
describe('nats backend_config — an unrecognised key is refused, not dropped', () => {
  beforeEach(() => {
    vi.mocked(connect).mockClear();
  });

  const declared = declaredConfigKeys();
  const nearMisses = (key: string): string[] => [
    key.slice(0, -1),
    `${key.slice(0, -2)}${key.at(-1) ?? ''}${key.at(-2) ?? ''}`,
    `${key}s`,
    key.toUpperCase(),
  ];

  const typos = [...new Set(declared.flatMap(nearMisses))].filter((t) => !declared.includes(t));

  it('generates a near miss for every declared key', () => {
    expect(declared).toContain('nkey_seed');
    expect(typos).toContain('tokens');
    expect(typos.length).toBeGreaterThanOrEqual(declared.length * 3);
  });

  for (const typo of typos) {
    it(`refuses backend_config.${typo}, naming the key, before connecting`, async () => {
      const plugin = new NatsPlugin();

      const err = await plugin
        .connect({ servers: '127.0.0.1:4222', [typo]: 'x' })
        .then(() => undefined, (e: unknown) => e);

      expect(String(err)).toContain(typo);
      expect(vi.mocked(connect)).not.toHaveBeenCalled();
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

  const PLAINTEXT_SCHEMES = ['nats://', 'ws://', ''];
  const ENCRYPTED_SCHEMES = ['tls://', 'wss://'];
  const LOOPBACK_HOSTS = ['127.0.0.1:4222', 'localhost:4222', '[::1]:4222', '127.0.0.44'];
  // Hosts that read as loopback to a prefix or substring match but are ordinary registrable names
  // their owner points wherever they like, plus two integer spellings of 127.0.0.1.
  const LOOKALIKE_HOSTS = ['127.0.0.1.evil.com', 'localhost.evil.com', '2130706433', '0177.0.0.1'];
  const REMOTE_HOSTS = ['nats.example.com:4222', '203.0.113.9:4222', ...LOOKALIKE_HOSTS];

  it('the plaintext scheme set is exactly nats://, ws:// and a bare host:port', () => {
    for (const scheme of PLAINTEXT_SCHEMES) {
      expect(plaintextRemoteServer(`${scheme}remote.example:4222`)).toBeDefined();
    }
    for (const scheme of ENCRYPTED_SCHEMES) {
      expect(plaintextRemoteServer(`${scheme}remote.example:4222`)).toBeUndefined();
    }
  });

  it.each(LOOKALIKE_HOSTS)('%s is classified remote, not loopback', (host) => {
    expect(plaintextRemoteServer(`nats://${host}`)).toBeDefined();
  });

  const cells: { server: string; secret: boolean; tls: boolean; warns: boolean }[] = [];
  for (const [schemes, plaintext] of [
    [PLAINTEXT_SCHEMES, true],
    [ENCRYPTED_SCHEMES, false],
  ] as const) {
    for (const scheme of schemes) {
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
                warns: plaintext && !loopback && secret && !tls,
              });
            }
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

  it('warns once per offending entry when servers is a list', async () => {
    const warned = await warningsFrom({
      servers: ['nats://127.0.0.1:4222', 'nats://a.example.com:4222', 'tls://b.example.com:4222', 'nats://c.example.com:4222'],
      token: SECRET,
    });

    expect(warned).toHaveLength(2);
    expect(warned.map((l) => (/servers "([^"]+)"/.exec(l) ?? [])[1])).toEqual([
      'nats://a.example.com:4222',
      'nats://c.example.com:4222',
    ]);
  });
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
