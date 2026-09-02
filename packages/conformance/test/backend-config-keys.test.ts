import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * CLASS: a repo-wide fail-fast invariant every package implements for itself, so a package that
 * never implemented it at all is invisible to every package-scoped reader. Six backends refused an
 * unknown `backend_config` key at `connect()` and four accepted one in silence — a mistyped
 * `chanel_map` meaning every topic is used as a literal channel id, a mistyped `allowed_mentions`
 * meaning the mention blast radius stays at the built-in default the operator believed they had
 * narrowed — and nothing in the repo graded the difference.
 *
 * The rows are DERIVED twice over, so that neither half can go stale:
 *   - which packages are graded comes from the root manifest's `workspaces` and from the SEAM
 *     (a package is graded iff it exports a constructor whose prototype carries all six methods),
 *     never from a list of backend names kept here;
 *   - which keys are probed comes from each plugin's own refusal message, never from a list of
 *     config keys kept here. A backend that adds a key widens its own row.
 *
 * Both derivations have a floor below, so that a scan which has stopped matching fails instead of
 * passing on an empty table.
 */

const REPO = fileURLToPath(new URL('../../../', import.meta.url));

/** The seam's method set (DESIGN §4) — what makes an exported class a backend plugin. */
const SEAM_METHODS = [
  'connect',
  'disconnect',
  'subscribe',
  'post',
  'fetchRecent',
  'resolveIdentity',
] as const;

interface Plugin {
  connect(config: Record<string, unknown>): Promise<void>;
  disconnect(): Promise<void>;
}
type PluginCtor = new () => Plugin;

function isPluginConstructor(value: unknown): value is PluginCtor {
  if (typeof value !== 'function') return false;
  const proto = (value as { prototype?: Record<string, unknown> }).prototype;
  if (proto === undefined || proto === null) return false;
  return SEAM_METHODS.every((m) => typeof proto[m] === 'function');
}

interface Manifest {
  name: string;
  exports?: unknown;
  workspaces?: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** Every workspace manifest, from the root `workspaces` globs — the set, never a member. */
function workspaceManifests(): Manifest[] {
  const root = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as Manifest;
  const areas = [...new Set(root.workspaces?.map((w) => w.replace(/\/\*+$/, '')) ?? [])];
  return areas.flatMap((area) => {
    const at = join(REPO, area);
    if (!existsSync(at)) return [];
    return readdirSync(at)
      .map((d) => join(at, d))
      .filter((d) => statSync(d).isDirectory() && existsSync(join(d, 'package.json')))
      .map((d) => JSON.parse(readFileSync(join(d, 'package.json'), 'utf8')) as Manifest);
  });
}

/** A workspace with no `exports` map is not importable by name; nothing else may fail to import. */
const IMPORTABLE = workspaceManifests().filter((m) => m.exports !== undefined);

const SUITE = '@sharptrick/parley-conformance';

/**
 * Which packages that run the shared suite this table does NOT reach. A backend whose plugin class
 * is not on its package's export surface would otherwise drop out of the rows in silence, and the
 * count floor cannot see an eleventh backend going ungraded.
 */
export const ungraded = (consumers: readonly string[], graded: readonly string[]): string[] =>
  consumers.filter((name) => !graded.includes(name));

const SUITE_CONSUMERS = workspaceManifests()
  .filter((m) => SUITE in { ...m.dependencies, ...m.devDependencies })
  .map((m) => m.name);

const PLUGINS: { name: string; Ctor: PluginCtor }[] = [];
for (const { name } of IMPORTABLE) {
  const mod = (await import(name)) as Record<string, unknown>;
  for (const [, value] of Object.entries(mod)) {
    if (isPluginConstructor(value)) PLUGINS.push({ name, Ctor: value });
  }
}

const PROBE_KEY = '__parley_probe_unknown_key__';

/** Never the empty string, and never a name already declared: both would probe nothing. */
function nearMisses(key: string, declared: readonly string[]): string[] {
  const candidates = [
    key.slice(0, -1),
    `${key}${key.slice(-1)}`,
    key.replaceAll('_', ''),
    key.toUpperCase(),
  ];
  return [...new Set(candidates)].filter(
    (c) => c !== '' && c !== key && !declared.includes(c),
  );
}

/**
 * `connect()` with `config`, resolved to the rejection it produced. A load-time key check answers
 * without a server, so a call that has not settled inside the budget has reached the network — that
 * is a failure of this invariant, not a slow test, and it is reported as one.
 */
async function connectOutcome(Ctor: PluginCtor, config: Record<string, unknown>): Promise<string> {
  const plugin = new Ctor();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      plugin.connect(config),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('did not settle offline')), 5000);
        timer.unref();
      }),
    ]);
    return 'accepted the config';
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await plugin.disconnect().catch(() => undefined);
  }
}

const DECLARED_SET = /expected one of (.+)$/;

/**
 * Everything wrong with one plugin's unknown-key refusal, as reportable lines. Empty means the
 * plugin refuses an unknown key AND every single-character near miss of every key it declares.
 */
export async function unknownKeyFindings(Ctor: PluginCtor): Promise<string[]> {
  const found: string[] = [];
  const probe = await connectOutcome(Ctor, { [PROBE_KEY]: 'x' });
  if (!probe.includes(PROBE_KEY)) {
    return [`an unknown key is not refused by name: ${probe}`];
  }
  const declared = (DECLARED_SET.exec(probe)?.[1] ?? '').split(', ').filter((k) => k !== '');
  if (declared.length < 2) {
    return [`the refusal does not list the accepted keys: ${probe}`];
  }
  for (const key of declared) {
    for (const miss of nearMisses(key, declared)) {
      const outcome = await connectOutcome(Ctor, { [miss]: 'x' });
      if (!outcome.includes(miss)) found.push(`a near miss of '${key}' — '${miss}' — ${outcome}`);
    }
  }
  return found;
}

describe('every backend refuses a backend_config key it does not declare', () => {
  it('sees every importable workspace and every plugin in it, so the rows are not an empty table', () => {
    expect(IMPORTABLE.length).toBeGreaterThan(10);
    expect(
      PLUGINS.length,
      'the seam-method detector matched no exported plugin at all',
    ).toBeGreaterThanOrEqual(10);
    expect(new Set(PLUGINS.map((p) => p.name)).size).toBe(PLUGINS.length);
    expect(SUITE_CONSUMERS.length).toBeGreaterThanOrEqual(10);
    expect(
      ungraded(SUITE_CONSUMERS, PLUGINS.map((p) => p.name)),
      'runs the shared conformance suite but exports no plugin this table can reach',
    ).toEqual([]);
  });

  it.each(PLUGINS.map((p) => [p.name, p.Ctor] as const))('%s', async (_name, Ctor) => {
    expect(await unknownKeyFindings(Ctor)).toEqual([]);
  });
});

/**
 * The rule on SYNTHETIC plugins, because the repo's own shape is what a scan like this silently
 * comes to depend on: what it must catch is what is no longer on disk to catch.
 */
describe('the rule can see each way a key check goes wrong (controls)', () => {
  const DECLARED = ['api_url', 'bot_token'];

  class StrictPlugin {
    async connect(config: Record<string, unknown>): Promise<void> {
      for (const key of Object.keys(config)) {
        if (!DECLARED.includes(key)) {
          throw new Error(`unknown backend_config key '${key}' — expected one of ${DECLARED.join(', ')}`);
        }
      }
    }
    async disconnect(): Promise<void> {}
    async subscribe(): Promise<void> {}
    async post(): Promise<void> {}
    async fetchRecent(): Promise<void> {}
    async resolveIdentity(): Promise<void> {}
  }

  class LaxPlugin extends StrictPlugin {
    override async connect(): Promise<void> {}
  }

  /** Refuses the obviously foreign, accepts a typo of its own — the shape a probe key alone misses. */
  class PrefixOnlyPlugin extends StrictPlugin {
    override async connect(config: Record<string, unknown>): Promise<void> {
      for (const key of Object.keys(config)) {
        if (key.startsWith('__')) {
          throw new Error(`unknown backend_config key '${key}' — expected one of ${DECLARED.join(', ')}`);
        }
      }
    }
  }

  /** Refuses, but names neither the key nor the accepted set. */
  class UnnamedPlugin extends StrictPlugin {
    override async connect(config: Record<string, unknown>): Promise<void> {
      if (Object.keys(config).some((k) => !DECLARED.includes(k))) {
        throw new Error('bad backend_config');
      }
    }
  }

  class StallingPlugin extends StrictPlugin {
    override async connect(): Promise<void> {
      await new Promise(() => undefined);
    }
  }

  it('the detector matches a seam implementation and nothing else', () => {
    expect(isPluginConstructor(StrictPlugin)).toBe(true);
    expect(isPluginConstructor(class {})).toBe(false);
    expect(isPluginConstructor({ connect: () => undefined })).toBe(false);
  });

  it('a correct plugin is reported clean', async () => {
    expect(await unknownKeyFindings(StrictPlugin as unknown as PluginCtor)).toEqual([]);
  });

  it('a plugin that accepts everything is reported', async () => {
    expect(await unknownKeyFindings(LaxPlugin as unknown as PluginCtor)).toEqual([
      `an unknown key is not refused by name: accepted the config`,
    ]);
  });

  it('a plugin that refuses only obviously foreign keys is reported, key by key', async () => {
    const found = await unknownKeyFindings(PrefixOnlyPlugin as unknown as PluginCtor);
    expect(found.length).toBeGreaterThanOrEqual(DECLARED.length);
    for (const key of DECLARED) expect(found.join('\n')).toContain(`a near miss of '${key}'`);
  });

  it('a plugin whose refusal names nothing is reported', async () => {
    expect(await unknownKeyFindings(UnnamedPlugin as unknown as PluginCtor)).toEqual([
      'an unknown key is not refused by name: bad backend_config',
    ]);
  });

  it('a plugin that reaches the network instead of answering at load is reported', async () => {
    expect(await unknownKeyFindings(StallingPlugin as unknown as PluginCtor)).toEqual([
      'an unknown key is not refused by name: did not settle offline',
    ]);
  }, 10_000);

  it('a suite consumer this table cannot reach is reported', () => {
    expect(ungraded(['a', 'b'], ['a', 'b'])).toEqual([]);
    expect(ungraded(['a', 'b'], ['a'])).toEqual(['b']);
    expect(ungraded(['a'], [])).toEqual(['a']);
  });

  it('a near miss is never the empty string, the key itself, or another declared key', () => {
    expect(nearMisses('a', DECLARED)).not.toContain('');
    expect(nearMisses('api_url', DECLARED)).not.toContain('api_url');
    expect(nearMisses('bot_token', ['bot_token', 'bot_toke'])).not.toContain('bot_toke');
    expect(nearMisses('api_url', DECLARED)).toContain('apiurl');
  });
});

/**
 * CLASS: a repo-wide WARN invariant every package implements for itself, so a package that never
 * implemented it at all is invisible to every package-scoped reader. Nine backends classified a
 * credential-carrying endpoint pointed at a plaintext non-loopback host and named it on stderr; one
 * did not, and it was the backend whose published default connection string embeds a password. Each
 * package's own creds-warning suite grades only the package it lives in, so nine of them passing is
 * not evidence about the tenth.
 *
 * The rows are the SEAM's plugins, so an eleventh backend is a row the day it lands: a plugin with
 * no configurable endpoint records that instead, and a plugin with one is probed through its real
 * `connect()` rather than by scanning it for a helper. Endpoints are unroutable or closed on
 * purpose — the classification is made before anything is dialled, and nothing here should reach a
 * network to find that out.
 */
interface EndpointProbe {
  /** The declared key the endpoint is configured under. */
  key: string;
  /** A config carrying a credential and a PLAINTEXT endpoint at a host that is not loopback. */
  remote: Record<string, unknown>;
  /** The same, pointed at loopback — which must stay silent. */
  loopback: Record<string, unknown>;
  /** The origin the warning has to name, and the secret it must never print. */
  origin: string;
  secret: string;
}

const REMOTE_HOST = 'parley-not-a-host.invalid';
const CLOSED_LOOPBACK = '127.0.0.1:1';
const SECRET = 'hunter2-not-a-real-secret';

/**
 * One entry per plugin: the endpoint probe, or why the plugin has no endpoint to classify. Every
 * seam plugin must appear — that completeness is what the hole this grades looked like.
 */
const ENDPOINTS: Record<string, EndpointProbe | { none: string }> = {
  '@sharptrick/parley-discord': {
    key: 'api_url',
    remote: { token: SECRET, api_url: `http://${REMOTE_HOST}/api/v10` },
    loopback: { token: SECRET, api_url: `http://${CLOSED_LOOPBACK}/api/v10` },
    origin: `http://${REMOTE_HOST}`,
    secret: SECRET,
  },
  '@sharptrick/parley-matrix': {
    key: 'homeserver_url',
    remote: { homeserver_url: `http://${REMOTE_HOST}`, user: 'u', password: SECRET },
    loopback: { homeserver_url: `http://${CLOSED_LOOPBACK}`, user: 'u', password: SECRET },
    origin: `http://${REMOTE_HOST}`,
    secret: SECRET,
  },
  '@sharptrick/parley-nats': {
    key: 'servers',
    remote: { servers: `nats://${REMOTE_HOST}:4222`, token: SECRET },
    loopback: { servers: `nats://${CLOSED_LOOPBACK}`, token: SECRET },
    origin: REMOTE_HOST,
    secret: SECRET,
  },
  '@sharptrick/parley-postgres': {
    key: 'url',
    remote: { url: `postgres://app:${SECRET}@${REMOTE_HOST}:5432/prod` },
    loopback: { url: `postgres://app:${SECRET}@${CLOSED_LOOPBACK}/prod` },
    origin: `postgres://${REMOTE_HOST}`,
    secret: SECRET,
  },
  '@sharptrick/parley-redis': {
    key: 'url',
    remote: { url: `redis://app:${SECRET}@${REMOTE_HOST}:6379` },
    loopback: { url: `redis://app:${SECRET}@${CLOSED_LOOPBACK}` },
    origin: `redis://${REMOTE_HOST}`,
    secret: SECRET,
  },
  '@sharptrick/parley-slack': {
    key: 'api_url',
    remote: { bot_token: `xoxb-${SECRET}`, app_token: `xapp-${SECRET}`, api_url: `http://${REMOTE_HOST}/api/` },
    loopback: { bot_token: `xoxb-${SECRET}`, app_token: `xapp-${SECRET}`, api_url: `http://${CLOSED_LOOPBACK}/api/` },
    origin: `http://${REMOTE_HOST}`,
    secret: SECRET,
  },
  '@sharptrick/parley-sqlite': {
    none: 'the store is a local file: there is no endpoint to point elsewhere and no credential to send',
  },
  '@sharptrick/parley-telegram': {
    key: 'api_url',
    remote: { token: SECRET, api_url: `http://${REMOTE_HOST}` },
    loopback: { token: SECRET, api_url: `http://${CLOSED_LOOPBACK}` },
    origin: `http://${REMOTE_HOST}`,
    secret: SECRET,
  },
  '@sharptrick/parley-xmpp': {
    key: 'service',
    remote: { service: `xmpp://${REMOTE_HOST}:5222`, domain: 'd.invalid', username: 'u', password: SECRET },
    loopback: { service: `xmpp://${CLOSED_LOOPBACK}`, domain: 'd.invalid', username: 'u', password: SECRET },
    origin: REMOTE_HOST,
    secret: SECRET,
  },
  '@sharptrick/parley-zulip': {
    key: 'site_url',
    remote: { site_url: `http://${REMOTE_HOST}`, email: 'a@b.invalid', api_key: SECRET },
    loopback: { site_url: `http://${CLOSED_LOOPBACK}`, email: 'a@b.invalid', api_key: SECRET },
    origin: `http://${REMOTE_HOST}`,
    secret: SECRET,
  },
};

/** Every line a `connect()` warned on, whichever channel the plugin writes it to. */
async function warningsFrom(Ctor: PluginCtor, config: Record<string, unknown>): Promise<string[]> {
  const lines: string[] = [];
  const stderr = process.stderr.write.bind(process.stderr);
  const warn = console.warn.bind(console);
  process.stderr.write = ((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  console.warn = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  try {
    await connectOutcome(Ctor, config);
  } finally {
    process.stderr.write = stderr;
    console.warn = warn;
  }
  return lines.filter((line) => line.includes('SECURITY'));
}

describe('every backend names a credential put on a plaintext remote endpoint', () => {
  it('classifies every plugin the seam finds, so no backend drops out of the rows', () => {
    expect(
      PLUGINS.map((p) => p.name).filter((name) => !(name in ENDPOINTS)),
      'a plugin this suite reaches has no entry: give it an endpoint probe, or record that it has none',
    ).toEqual([]);
    expect(
      Object.keys(ENDPOINTS).filter((name) => !PLUGINS.some((p) => p.name === name)),
      'an entry names a plugin the seam no longer finds',
    ).toEqual([]);
    expect(
      Object.values(ENDPOINTS).filter((e) => 'key' in e).length,
      'no plugin is probed at all — the table has emptied itself out',
    ).toBeGreaterThan(8);
  });

  it.each(
    PLUGINS.filter((p) => 'key' in (ENDPOINTS[p.name] ?? { none: '' })).map(
      (p) => [p.name, p.Ctor, ENDPOINTS[p.name] as EndpointProbe] as const,
    ),
  )('%s', async (_name, Ctor, probe) => {
    const remote = await warningsFrom(Ctor, probe.remote);
    const named = remote.filter((line) => line.includes(`backend_config.${probe.key}`));
    expect(named.length, 'a plaintext remote endpoint carrying a credential warned about nothing').toBeGreaterThan(0);
    expect(named.join('\n')).toContain(probe.origin);
    for (const line of named) expect(line).not.toContain(probe.secret);

    const loopback = await warningsFrom(Ctor, probe.loopback);
    expect(
      loopback.filter((line) => line.includes(`backend_config.${probe.key}`)),
      'a loopback endpoint was warned about, which would make the dev servers noise',
    ).toEqual([]);
  }, 20_000);
});

/**
 * CLASS: one documented `backend_config` key name, shared by several backends, with a different
 * acceptance contract in each. `retention_days` is declared by four; a window of 43 seconds was a
 * load error on two of them (naming the history it would destroy) and silently accepted by the
 * other two, where it trims the whole store on the next write. A window of a million days was the
 * mirror image: refused by three, accepted by the fourth, where pruning then never runs at all.
 * Each backend had fixed its own cell and nothing carried the fix across, because nothing in the
 * repo compared them.
 *
 * The shared KEYS are derived — each plugin's own refusal message lists what it declares — so the
 * fifth backend to take one of these names is a row the day it lands, and so is a key that becomes
 * shared for the first time. What each shared key's contract IS has to be written down, and an
 * entry that records a divergence rather than a contract is pinned to the set of plugins it was
 * measured against, so it cannot quietly come to cover a plugin nobody looked at.
 */
interface SharedKeyContract {
  /** Values every declaring plugin must refuse, naming the key. */
  refuses: [label: string, value: unknown][];
  /** Values every declaring plugin must let through validation. */
  accepts: [label: string, value: unknown][];
}
type SharedKeyEntry = SharedKeyContract | { divergent: string; declaredBy: string[] };

const SHARED_KEYS: Record<string, SharedKeyEntry> = {
  retention_days: {
    refuses: [
      ['zero', 0],
      ['negative', -1],
      ['a nanosecond of a day', 1e-9],
      ['a picosecond of a day', 1e-12],
      ['forty-three seconds', 0.0005],
      ['a million days', 1e6],
      ['past every representable cutoff', 1e18],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['a string', '7'],
      ['a boolean', true],
      ['an array', []],
    ],
    // A key written in yaml with no value parses to `null`, and a window that is absent keeps every
    // message: the reading that destroys nothing, and the one the four already agreed on the most.
    accepts: [['null', null]],
  },
  token: {
    divergent:
      'a pass-through credential, not a window: two declarers require a non-empty string and the ' +
      'third hands whatever it is given to its driver. Unifying it is a change to what each ' +
      'backend accepts as a secret, which is not this key-name question',
    declaredBy: ['@sharptrick/parley-discord', '@sharptrick/parley-nats', '@sharptrick/parley-telegram'],
  },
  api_url: {
    divergent:
      'an endpoint override whose default differs per backend; `null` selects the default on one ' +
      'declarer and is refused by the other two. Graded instead by the plaintext-endpoint table above',
    declaredBy: ['@sharptrick/parley-discord', '@sharptrick/parley-slack', '@sharptrick/parley-telegram'],
  },
  url: {
    divergent:
      'a DSN whose scheme and shape are the backend\'s own; `null` selects the default endpoint on ' +
      'one declarer and is refused by the other. Graded instead by the plaintext-endpoint table above',
    declaredBy: ['@sharptrick/parley-postgres', '@sharptrick/parley-redis'],
  },
  user: {
    divergent: 'an account name on one backend and a pass-through auth field on the other',
    declaredBy: ['@sharptrick/parley-matrix', '@sharptrick/parley-nats'],
  },
  password: {
    refuses: [
      ['null', null],
      ['zero', 0],
      ['negative', -1],
      ['a large number', 1e6],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['a boolean', true],
      ['an array', []],
      ['an object', {}],
    ],
    accepts: [['a secret', 'a-secret-that-is-not-a-default']],
  },
  channel_map: {
    divergent: 'a topic → channel-id map whose id shape is each backend\'s own',
    declaredBy: ['@sharptrick/parley-discord', '@sharptrick/parley-slack'],
  },
  handshake_timeout_ms: {
    divergent: 'a latency bound, with no shared destructive edge to agree on',
    declaredBy: ['@sharptrick/parley-discord', '@sharptrick/parley-slack'],
  },
};

/** Which plugins declare each key, read off each plugin's own refusal. */
async function declaredBy(): Promise<Map<string, string[]>> {
  const byKey = new Map<string, string[]>();
  for (const { name, Ctor } of PLUGINS) {
    const probe = await connectOutcome(Ctor, { [PROBE_KEY]: 'x' });
    for (const key of (DECLARED_SET.exec(probe)?.[1] ?? '').split(', ').filter((k) => k !== '')) {
      byKey.set(key, [...(byKey.get(key) ?? []), name]);
    }
  }
  return byKey;
}

const SHARED = [...(await declaredBy())].filter(([, owners]) => owners.length > 1).sort();

/** A config that cannot reach anything, so a value that PASSES validation still dials nothing. */
const offlineBase = (name: string): Record<string, unknown> => {
  const probe = ENDPOINTS[name];
  if (probe !== undefined && 'key' in probe) return { ...probe.loopback };
  return { db_path: join(mkdtempSync(join(tmpdir(), 'parley-shared-key-')), 'p.db') };
};

describe('a backend_config key several backends declare means the same thing to all of them', () => {
  it('finds the shared keys and a contract for each, so the rows below are not an empty table', () => {
    expect(SHARED.length, 'no key is declared by more than one plugin at all').toBeGreaterThan(2);
    expect(
      SHARED.map(([key]) => key).filter((key) => !(key in SHARED_KEYS)),
      'a key several backends declare has no recorded contract: give it one, or record the divergence',
    ).toEqual([]);
    expect(
      Object.keys(SHARED_KEYS).filter((key) => !SHARED.some(([k]) => k === key)),
      'a recorded contract names a key no longer shared',
    ).toEqual([]);
    const graded = Object.values(SHARED_KEYS).filter((e) => 'refuses' in e);
    expect(graded.length, 'every shared key is recorded as divergent — nothing is graded').toBeGreaterThan(0);
    for (const entry of graded) {
      expect((entry as SharedKeyContract).refuses.length).toBeGreaterThan(8);
      expect((entry as SharedKeyContract).accepts.length).toBeGreaterThan(0);
    }
  });

  it('a divergence is recorded against the plugins it was measured on, and no others', () => {
    for (const [key, owners] of SHARED) {
      const entry = SHARED_KEYS[key];
      if (entry === undefined || 'refuses' in entry) continue;
      expect(entry.divergent.length, `${key}: a divergence with no reason recorded`).toBeGreaterThan(20);
      expect([...entry.declaredBy].sort(), `${key}: the declaring set has moved`).toEqual([...owners].sort());
    }
  });

  it.each(
    SHARED.flatMap(([key, owners]) => {
      const entry = SHARED_KEYS[key];
      if (entry === undefined || !('refuses' in entry)) return [];
      return entry.refuses.map(
        (row) => [`${key} = ${row[0]}`, key, row[1], owners] as const,
      );
    }),
  )('%s is refused by every backend that declares it', async (_label, key, value, owners) => {
    const verdicts: string[] = [];
    for (const name of owners) {
      const { Ctor } = PLUGINS.find((p) => p.name === name) as { Ctor: PluginCtor };
      const outcome = await connectOutcome(Ctor, { [key]: value });
      if (!outcome.includes(key)) verdicts.push(`${name}: ${outcome}`);
    }
    expect(verdicts, 'let through a value its siblings refuse, or refused it without naming the key').toEqual([]);
  }, 30_000);

  it.each(
    SHARED.flatMap(([key, owners]) => {
      const entry = SHARED_KEYS[key];
      if (entry === undefined || !('refuses' in entry)) return [];
      return entry.accepts.map((row) => [`${key} = ${row[0]}`, key, row[1], owners] as const);
    }),
  )('%s clears validation on every backend that declares it', async (_label, key, value, owners) => {
    const verdicts: string[] = [];
    for (const name of owners) {
      const { Ctor } = PLUGINS.find((p) => p.name === name) as { Ctor: PluginCtor };
      const outcome = await connectOutcome(Ctor, { ...offlineBase(name), [key]: value });
      if (outcome.includes(key)) verdicts.push(`${name}: ${outcome}`);
    }
    expect(verdicts, 'refused a value its siblings accept').toEqual([]);
  }, 30_000);
});
