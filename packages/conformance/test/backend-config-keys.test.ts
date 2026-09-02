import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
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
