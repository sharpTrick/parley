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

import {
  CONFIG_KEYS,
  JID_PART_MAX_BYTES,
  JID_SIZED_KEYS,
  XmppPlugin,
} from '../src/index.js';

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

/**
 * The ceiling every JID part carries, per key that becomes one. A value one byte over is refused
 * BY NAME rather than left to bounce as a bare `jid-malformed` naming neither the plugin nor the
 * key, and the multibyte row is what makes `.length` an insufficient measure of it.
 */
const lengths = JID_SIZED_KEYS.flatMap((key) => [
  { key, case: 'at the limit', value: 'x'.repeat(JID_PART_MAX_BYTES), accepted: true },
  { key, case: 'one byte over', value: 'x'.repeat(JID_PART_MAX_BYTES + 1), accepted: false },
  {
    key,
    case: 'under the limit in characters but over it in bytes',
    value: 'é'.repeat(JID_PART_MAX_BYTES - 1),
    accepted: false,
  },
]);

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

  it.each(lengths)('$key $case', async ({ key, value, accepted }) => {
    const before = mockState.clients;
    const err = await connectWith({ ...valid, [key]: value });
    if (accepted) {
      expect(err).toBeUndefined();
      return;
    }
    expect(err?.message ?? '').toContain('parley-xmpp');
    expect(err?.message ?? '').toContain(`backend_config.${key}`);
    expect(err?.message ?? '').toContain(String(JID_PART_MAX_BYTES));
    expect(mockState.clients).toBe(before); // refused before any stream was opened
  });

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

// Class: a claim graded behaviourally in ONE file that survives verbatim in another shipped doc.
// `multi-session-doc.test.ts` pins what actually happens when two sessions share an account — a
// silent sender merge, never an error — but it grades only the package README's wording. The
// example page and the three runnable configs an operator actually copies still described the
// pre-nick-adoption plugin: `post()` ignoring `identity`, a random per-connection nick handing every
// session distinct attribution "for free", and a duplicate pinned nick failing "outright" — a SAFETY
// claim inverted, since the real outcome is the silent merge. Every doc surface that describes this
// contract is graded together here: a retired phrase may appear in none of them, and the current
// claim must appear in all, so a behavioural fix that does not propagate is a red row rather than
// rot nobody re-reads.

/** Comment markers and line wrapping are formatting; a claim must not hide behind either. */
const flatten = (text: string): string => text.replace(/^\s*#+\s?/gm, '').replace(/\s+/g, ' ');

/** One `##`/`###` section of a markdown file — the Matrix section makes true claims XMPP retired. */
const section = (markdown: string, heading: RegExp): string => {
  const found = markdown.split(/^(?=#{2,3} )/m).find((part) => heading.test(part));
  expect(found).toBeDefined();
  return found as string;
};

const surfaces = (): Array<{ name: string; text: string }> => [
  { name: 'packages/bridge-xmpp/README.md', text: repoFile('packages/bridge-xmpp/README.md') },
  {
    name: 'examples/multi-session/README.md (XMPP section)',
    text: section(repoFile('examples/multi-session/README.md'), /^### XMPP\b/),
  },
  {
    name: 'examples/multi-session/xmpp/*.yaml',
    text: ['code-agent-a', 'code-agent-b', 'remote-chat']
      .map((f) => repoFile(`examples/multi-session/xmpp/${f}.yaml`))
      .join('\n'),
  },
];

const retired = [
  { claim: "post() ignores the seam's identity", pattern: /post\(\)[^.]{0,120}ignor/i },
  { claim: 'the identity parameter is unused (_identity)', pattern: /_identity/ },
  {
    claim: 'the occupant nick is auto-generated at random per connection',
    pattern: /auto-generat|\$\{username\}-\$\{rand/i,
  },
  { claim: 'a duplicate pinned nick fails outright', pattern: /fails?\s+outright/i },
];

const current = [
  { claim: 'identity.handle is what the sender comes from', pattern: /identity\.handle/ },
  {
    claim: 'a shared identity merges senders with no error',
    pattern: /no error at (any point|all)/i,
  },
];

const claimCells = <T extends { claim: string }>(claims: T[]): Array<T & { surface: string }> =>
  claims.flatMap((c) => surfaces().map((s) => ({ ...c, surface: s.name })));

const textOf = (name: string): string =>
  flatten(surfaces().find((s) => s.name === name)?.text as string);

describe('XMPP identity/nick doc claims are retired everywhere or nowhere', () => {
  it.each(claimCells(retired))('$surface no longer claims "$claim"', ({ surface, pattern }) => {
    expect(textOf(surface)).not.toMatch(pattern);
  });

  it.each(claimCells(current))('$surface states "$claim"', ({ surface, pattern }) => {
    expect(textOf(surface)).toMatch(pattern);
  });
});
