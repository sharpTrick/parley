import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

// Class: a plugin taking `backend_config` by unchecked cast. Core deliberately leaves the object
// open (config.ts) BECAUSE each plugin validates it; this one cast it, so a misspelled key was a
// silent default (`muc_servce` addressed every room at muc.parley.local and the join bounced
// remote-server-not-found — a retryable condition, so the operator got four seconds of quiet
// retries and an error naming neither the key nor the plugin), a YAML-quoted number silently became
// the default page size, and a wrong-typed nick surfaced as `TypeError: s is not iterable`. DESIGN
// §11 even documented a `jid` key this plugin has never read. The table crosses every declared key
// with every way a config can be wrong and demands one shape of every cell: a rejection naming this
// plugin and the key, raised before any socket is opened.

const mockState = vi.hoisted(() => ({ clients: 0 }));
vi.mock('@xmpp/client', async () => {
  const actual = await vi.importActual<typeof import('@xmpp/client')>('@xmpp/client');
  return {
    ...actual,
    client: () => {
      mockState.clients++;
      return {
        jid: { toString: () => 'parley@parley.local/r' },
        start: async () => undefined,
        stop: async () => undefined,
        send: async () => undefined,
        on: () => undefined,
        iqCaller: { request: async () => undefined },
      };
    },
  };
});

import { CONFIG_KEYS, XmppPlugin } from '../src/index.js';

const valid: Record<string, unknown> = {
  service: 'xmpp://127.0.0.1:5222',
  domain: 'parley.local',
  muc_service: 'muc.parley.local',
  username: 'parley',
  password: 'a-real-secret',
  nick: 'session-a',
  mam_page: 50,
};

const badStrings: unknown[] = [123, true, null, [], {}, ''];
const badNumbers: unknown[] = ['50', true, null, [], {}, 0, -1, 1.5, Number.NaN, 20_000];

const label = (v: unknown): string =>
  typeof v === 'string' ? `'${v}'` : Array.isArray(v) ? '[]' : JSON.stringify(v) ?? String(v);

const wrongValues = CONFIG_KEYS.flatMap((key) =>
  (key === 'mam_page' ? badNumbers : badStrings).map((value) => ({ key, value })),
);

/** Typos an operator actually makes: a transposition, a dropped letter, DESIGN's phantom key. */
const unknownKeys = ['muc_servce', 'mucservice', 'usernam', 'jid', 'MAM_PAGE', 'nickname'];

const connectWith = async (config: Record<string, unknown>): Promise<Error | undefined> => {
  const plugin = new XmppPlugin();
  try {
    await plugin.connect(config);
    await plugin.disconnect();
    return undefined;
  } catch (err) {
    return err as Error;
  }
};

describe('XMPP backend_config is validated before anything connects', () => {
  it('the fully-specified valid config is accepted', async () => {
    expect(await connectWith({ ...valid })).toBeUndefined();
  });

  it.each(CONFIG_KEYS)('%s may be omitted', async (key) => {
    const config = { ...valid };
    delete config[key];
    expect(await connectWith(config)).toBeUndefined();
  });

  it.each(wrongValues)('$key = $value is refused by name', async ({ key, value }) => {
    const before = mockState.clients;
    const err = await connectWith({ ...valid, [key]: value });
    expect(err?.message ?? '').toContain('parley-xmpp');
    expect(err?.message ?? '').toContain(key);
    expect(err?.constructor.name).toBe('Error'); // never a bare TypeError from deep inside
    expect(mockState.clients).toBe(before); // and no stream was opened on a bad config
  }, 10_000);

  it.each(unknownKeys)('an unknown key %s is a load error listing what is accepted', async (key) => {
    const err = await connectWith({ ...valid, [key]: 'anything' });
    expect(err?.message ?? '').toContain('parley-xmpp');
    expect(err?.message ?? '').toContain(key);
    for (const known of CONFIG_KEYS) expect(err?.message ?? '').toContain(known);
  });

  it.each(['domain', 'muc_service', 'username'] as const)(
    'a JID separator inside %s is refused rather than silently re-addressed',
    async (key) => {
      for (const value of ['bot@example.com', 'muc example.com', 'a/b']) {
        const err = await connectWith({ ...valid, [key]: value });
        expect(err?.message ?? '').toContain(`backend_config.${key}`);
      }
    },
  );

  it('a nick carrying the resource separator is refused', async () => {
    const err = await connectWith({ ...valid, nick: 'agent/one' });
    expect(err?.message ?? '').toContain('backend_config.nick');
  });
});

// Class: a config key documented in one place and unimplemented (or renamed) in another. DESIGN §11
// listed `jid`, which this plugin has never read, while the README listed the real keys — and with
// backend_config unvalidated, following DESIGN silently authenticated as the default account. The
// three now have to agree, so any of them drifting fails the build rather than an operator's deploy.

const repoFile = (path: string): string =>
  readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');

const readmeKeys = (): string[] => {
  const readme = repoFile('packages/bridge-xmpp/README.md');
  const block = /## Config \(`backend_config`\)\s*```yaml\n([\s\S]*?)```/.exec(readme);
  expect(block).not.toBeNull();
  return [...(block?.[1] as string).matchAll(/^\s*#?\s*([a-z_]+):/gm)]
    .map((m) => m[1] as string)
    .filter((key) => key !== 'backend_config');
};

const designKeys = (): string[] => {
  const design = repoFile('DESIGN.md');
  const line = /^\s*#\s*xmpp:\s*\{([^}]*)\}/m.exec(design);
  expect(line).not.toBeNull();
  return (line?.[1] as string).split(',').map((key) => key.trim().replace(/\?$/, ''));
};

describe('XMPP backend_config keys agree across code, README and DESIGN', () => {
  it('the README config block lists exactly the accepted keys', () => {
    expect([...readmeKeys()].sort()).toEqual([...CONFIG_KEYS].sort());
  });

  it('the DESIGN §11 xmpp line lists exactly the accepted keys', () => {
    expect([...designKeys()].sort()).toEqual([...CONFIG_KEYS].sort());
  });
});
