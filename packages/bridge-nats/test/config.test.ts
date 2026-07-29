import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, nkeys, type ConnectionOptions } from 'nats';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NatsPlugin } from '../src/index.js';

// Class: every backend_config field the docs promise is actually honoured by the driver, and no
// secret value is echoed back out. A credential the plugin silently drops means the operator
// believes a cluster is authenticated when the connection is anonymous.
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
