import { existsSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asTopic } from '@sharptrick/parley-core';
import { describe, expect, it, vi } from 'vitest';
import { TelegramPlugin } from '../src/index.js';
import { KNOWN_CHANNEL } from './fake-telegram.js';
import {
  captureStderr,
  coldRestart,
  connectTo,
  contentsOf,
  openRig,
  packageSource,
  type Rig,
  registerCleanup,
  runCleanups,
  SENDER,
  seqOf,
  startFake,
  startRig,
  storePath,
} from './rig.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const source = packageSource();
const readme = readFileSync(join(here, '..', 'README.md'), 'utf8');
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as {
  description: string;
};

const configTable = /## Config \(`backend_config`\)([\s\S]*?)\n## /.exec(readme)?.[1] ?? '';
const cursorRow = readme.split('\n').find((l) => l.startsWith('| `cursor`')) ?? '';
const declaredKeys = [
  ...(/export interface TelegramBackendConfig \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? '').matchAll(
    /^ {2}(\w+)\??:/gm,
  ),
].map((m) => m[1] as string);

/**
 * Shipped metadata is read by people who will never open the source: the npm page, the README
 * table, DESIGN's backend row. Each claim below is checked against the strings the plugin actually
 * produces, so drift is a failing test rather than an integrator's wasted afternoon.
 */
describe('telegram shipped metadata matches the seam mapping', () => {
  const SURFACES = [
    { name: 'the npm description', text: () => pkg.description },
    { name: 'the README cursor row', text: () => cursorRow },
    {
      name: 'the root README backend table row',
      text: () => {
        const root = readFileSync(join(here, '..', '..', '..', 'README.md'), 'utf8');
        const row = root.split('\n').find((l) => l.startsWith('| Telegram |')) ?? '';
        expect(row).not.toBe('');
        return row;
      },
    },
    {
      name: 'the DESIGN backend-cursor row',
      text: () => {
        const design = readFileSync(join(here, '..', '..', '..', 'DESIGN.md'), 'utf8');
        const row = /\n {2}- Telegram → ([\s\S]*?)\n {2}- Slack/.exec(design)?.[1] ?? '';
        expect(row).not.toBe('');
        return row;
      },
    },
  ];

  it.each(SURFACES)('$name names the observation sequence as the cursor', ({ text }) => {
    const claim = text();
    expect(claim.toLowerCase()).toContain('observation sequence');
    expect(claim).not.toMatch(/message_id`?\s*(=|→)\s*cursor/i);
  });

  it('and the cursor a fetched message carries really is the sequence, not its message_id', async () => {
    const { plugin } = await startRig();
    // A first chat consumes sequences 1 and 2, so the second chat's message_id (1) and its
    // cursor (3) cannot coincide — a plugin returning either one would otherwise look identical.
    const first = asTopic('-1009850001');
    await plugin.post(first, SENDER, 'x');
    await plugin.post(first, SENDER, 'y');
    const topic = asTopic('-1009850002');
    const id = await plugin.post(topic, SENDER, 'z');

    const message = (await plugin.fetchRecent({ topic })).messages[0];
    expect(message?.backendMsgId).toBe(id);
    const messageId = (id as string).split(':')[1];
    expect(messageId).toBe('1');
    expect(seqOf(message?.cursor as string)).toBe(3);
    expect(message?.cursor).not.toBe(messageId);
  }, 20_000);
});

/**
 * A config key names the unit it bounds. `observed_retention_per_topic` did not — it bounds
 * records per CHAT, and `chat_map` can give one chat two topic names — which the README table had
 * to silently correct in prose. Lint the whole table so the next key cannot repeat it.
 */
describe('telegram config keys name the unit they bound', () => {
  const rowFor = (key: string): string =>
    configTable.split('\n').find((l) => l.startsWith(`| \`${key}\``)) ?? '';

  it('documents exactly the keys TelegramBackendConfig accepts', () => {
    expect(declaredKeys.length).toBeGreaterThan(0);
    const documented = [...configTable.matchAll(/^\| `(\w+)`/gm)].map((m) => m[1]);
    expect([...documented].sort()).toEqual([...declaredKeys].sort());
  });

  const UNITS = [
    { suffix: '_per_chat', requires: /per chat/i, forbids: /per topic/i },
    { suffix: '_per_topic', requires: /per topic/i, forbids: /per chat/i },
    { suffix: '_ms', requires: /\bms\b|milliseconds/i, forbids: null },
    { suffix: '_s', requires: /seconds/i, forbids: null },
  ];

  it.each(declaredKeys)('%s', (key) => {
    const row = rowFor(key);
    expect(row).not.toBe('');
    // A deprecated spelling's job is to point at the key that replaced it, not to state a unit.
    if (/deprecated/i.test(row)) {
      const replacement = declaredKeys.find((k) => k !== key && row.includes(`\`${k}\``));
      expect(replacement).toBeDefined();
      return;
    }
    for (const unit of UNITS) {
      if (!key.endsWith(unit.suffix)) continue;
      expect(row).toMatch(unit.requires);
      if (unit.forbids !== null) expect(row).not.toMatch(unit.forbids);
    }
  });

  it.each([
    { key: 'observed_retention_per_chat', config: { observed_retention_per_chat: 2 }, kept: 2 },
    { key: 'observed_retention_per_topic (deprecated)', config: { observed_retention_per_topic: 3 }, kept: 3 },
    {
      key: 'both, the current key wins',
      config: { observed_retention_per_chat: 2, observed_retention_per_topic: 5 },
      kept: 2,
    },
  ])('$key bounds retention per chat', async ({ config, kept }) => {
    const plugin = await connectTo(await startFake(), storePath(), config);

    const topic = asTopic('-1009860001');
    for (let i = 0; i < 8; i++) await plugin.post(topic, SENDER, `m${i}`);
    const page = await plugin.fetchRecent({ topic, limit: 100 });
    expect(page.messages).toHaveLength(kept);
  }, 20_000);
});

/**
 * A README sentence asserting an ABSOLUTE — "never evicts", "at most", "max distinct" — is the kind
 * of claim nothing else in the suite can fail on, and both of this package's chat-cap absolutes
 * used to be false in opposite directions: `observed_max_chats` documented a bound on the store's
 * TOTAL chats while a served chat is admitted past it (an operator sizing disk from the row is
 * under-provisioned), and "never evicts a chat this bridge serves ... on load or at runtime" did
 * not survive a restart for a chat only a seam call had named (an operator trusting the row loses
 * history the Bot API cannot backfill). So each absolute is bound to an EXECUTED cell: the
 * retention the plugin actually delivers, measured across a cold restart, against what the row
 * promises. A prose-only absolute is a claim that has not been graded.
 */
describe('telegram chat-cap claims are executed, not just written', () => {
  const capRow = readme.split('\n').find((l) => l.startsWith('| `observed_max_chats`')) ?? '';
  /** The whole markdown bullet a claim sits in — a promise is rarely one line long. */
  const bulletContaining = (needle: RegExp): string => {
    const lines = readme.split('\n');
    const start = lines.findIndex((l) => l.startsWith('- ') && needle.test(l));
    if (start < 0) return '';
    const end = lines.findIndex((l, i) => i > start && !l.startsWith('  '));
    return lines.slice(start, end < 0 ? undefined : end).join(' ');
  };
  const neverEvicts = bulletContaining(/never evicts/);

  const ABSOLUTES = [
    {
      what: 'the observed_max_chats row',
      claim: () => capRow,
      // The cap bounds the chats a flood creates, never the store's total — the served chats are
      // exactly the ones it must not evict, so it cannot bound a number that includes them.
      requires: /unserved/i,
      forbids: /max distinct chats kept in the store/i,
    },
    {
      what: 'the never-evict bullet',
      claim: () => neverEvicts,
      // "on load" is only true if the mark outlives the process that made it.
      requires: /store file|persist|restart|next load/i,
      forbids: null,
    },
  ];

  it.each(ABSOLUTES)('$what states the limit of its absolute', ({ claim, requires, forbids }) => {
    const text = claim();
    expect(text).not.toBe('');
    expect(text).toMatch(requires);
    if (forbids !== null) expect(text).not.toMatch(forbids);
  });

  const CAP = 2;
  const SENTINEL = '-1009881111';
  const OPS_CHATS = ['-1009880001', '-1009880002'];
  const FLOOD_CHATS = Array.from({ length: 6 }, (_, i) => `-99880${i}`);

  /**
   * Park until the ingestion loop has consumed everything injected so far, WITHOUT naming any chat
   * under test — asking after a chat is itself a seam call that serves it, which is the protection
   * being measured. The sentinel is served from `chat_map`, so polling it changes nothing.
   */
  const drain = async (rig: Rig, marker: string): Promise<void> => {
    rig.fake.injectUserMessage(SENTINEL, 'ops', marker);
    await vi.waitFor(async () => expect(await contentsOf(rig.plugin, asTopic('sentinel'))).toContain(marker), {
      timeout: 8000,
      interval: 20,
    });
  };

  it('bounds the chats nobody serves at the documented cap, at runtime and after a restart', async () => {
    const rig = await startRig({ observed_max_chats: CAP, chat_map: { sentinel: SENTINEL } });
    for (const c of FLOOD_CHATS) rig.fake.injectUserMessage(c, 'mallory', `flood-${c}`);
    await drain(rig, 'settled');

    const restarted = await coldRestart(rig);
    // Measured last, and only once: asking after a chat names it, which would protect it.
    const kept: string[] = [];
    for (const c of FLOOD_CHATS) {
      if ((await contentsOf(restarted, asTopic(c))).length > 0) kept.push(c);
    }
    expect(kept.length).toBeLessThanOrEqual(CAP);
    expect(kept.length).toBeGreaterThan(0);
  }, 30_000);

  it('keeps a chat a seam call named on load, not only while the process that named it lives', async () => {
    const rig = await startRig({ observed_max_chats: 1, chat_map: { sentinel: SENTINEL } });
    for (const c of FLOOD_CHATS) rig.fake.injectUserMessage(c, 'mallory', `flood-${c}`);
    await drain(rig, 'before');
    // A seam call — not `chat_map` — is what names these, which is the half the bullet's
    // "or one a seam call has named ... on load" is about.
    for (const c of OPS_CHATS) await rig.plugin.post(asTopic(c), SENDER, 'mine');
    for (const c of FLOOD_CHATS) rig.fake.injectUserMessage(c, 'mallory', `more-${c}`);
    await drain(rig, 'after');

    const restarted = await coldRestart(rig);
    for (const c of OPS_CHATS) expect(await contentsOf(restarted, asTopic(c))).toContain('mine');
  }, 30_000);
});

/**
 * Two files carrying the same case cannot fail independently, and a reader of either cannot tell
 * which one owns the check — so the next variant gets a third copy. Titles that are nothing but a
 * table placeholder are exempt: the row supplies the real name.
 */
/**
 * The repo ships no linter and `tsconfig.base.json` enables neither `noUnusedLocals` nor
 * `noUnusedParameters`, so nothing in CI can fail on a symbol the source imports and never uses.
 * `isLoopbackHost` sat in this package's import list for exactly that reason, telling a reader the
 * plaintext check was composed of two pieces when one of them was never called. Parameterized over
 * `src/`, so a new module is covered the moment it lands.
 */
describe('telegram source imports are all used', () => {
  const modules = readdirSync(join(here, '..', 'src')).filter((f) => f.endsWith('.ts'));
  const specifiersOf = (text: string): string[] => {
    const imported: string[] = [];
    for (const statement of text.matchAll(/^import\s+([\s\S]*?)\s+from\s+'[^']+';$/gm)) {
      const clause = statement[1] as string;
      const braced = /\{([\s\S]*)\}/.exec(clause)?.[1] ?? '';
      for (const spec of braced.split(',')) {
        const name = /(?:\bas\s+)?(\w+)\s*$/.exec(spec.trim())?.[1];
        if (name !== undefined) imported.push(name);
      }
      const bare = /^(\w+)\s*(?:,|$)/.exec(clause)?.[1];
      if (bare !== undefined) imported.push(bare);
    }
    return imported;
  };

  it('extracts the import specifiers this lint reads', () => {
    // Guard the extractor: a pattern that stopped matching would make every case below vacuous.
    // Asked of the PACKAGE and not of each module, so that a module with no dependencies is not
    // made to grow one to satisfy a lint that is about UNUSED imports.
    const all = modules.flatMap((f) => specifiersOf(readFileSync(join(here, '..', 'src', f), 'utf8')));
    expect(all.length).toBeGreaterThan(0);
  });

  it.each(modules)('%s imports nothing it does not reference', (file) => {
    const text = readFileSync(join(here, '..', 'src', file), 'utf8');
    const body = text.replace(/^import\s+[\s\S]*?\s+from\s+'[^']+';$/gm, '');
    expect(specifiersOf(text).filter((name) => !new RegExp(`\\b${name}\\b`).test(body))).toEqual([]);
  });
});

describe('telegram test suite hygiene', () => {
  it('declares no case title in two files', () => {
    const owners = new Map<string, string[]>();
    for (const file of readdirSync(here).filter((f) => f.endsWith('.test.ts'))) {
      const text = readFileSync(join(here, file), 'utf8');
      for (const m of text.matchAll(
        /^\s*(?:it|it\.each\([\s\S]*?\))\(\s*(['"`])((?:\\.|(?!\1).)*)\1/gm,
      )) {
        const title = m[2] as string;
        if (/^[\s$%]*(?:[$%]\w+[\s.\w]*)?$/.test(title)) continue;
        owners.set(title, [...(owners.get(title) ?? []), file]);
      }
    }
    // Guard the extractor itself: a regex that stops matching would make this lint vacuous.
    expect(owners.size).toBeGreaterThan(40);
    expect([...owners].filter(([, files]) => new Set(files).size > 1)).toEqual([]);
  });

  /**
   * Duplicate SCAFFOLDING is the same defect one level down, and a title-only lint cannot see it:
   * the connect-a-plugin-against-the-fake-with-a-tmpdir rig was retyped in eight files under three
   * names, with teardown contracts that had already drifted apart — so a fix to one was silently
   * not applied to the other seven, and one copy asserted on a plugin it never connected. `rig.ts`
   * owns both helpers, and is this lint's positive control: if the patterns stop matching THERE,
   * the empty offender list below means nothing.
   */
  /**
   * The enclosing declaration of every `plugin.connect(` in `text`: a named helper is a rig somebody
   * retyped, an `it`/`describe` callback is a one-off inside a single case and stays where it is.
   */
  const rigHelpers = (text: string): string[] => {
    const anchor =
      /^\s*(?:export\s+)?(?:async\s+)?function (\w+)|^\s*(?:const|let) (\w+)(?::[^=\n]+)?\s*=\s*(?:async\s*)?\(|^\s*(?:it|test|describe)\b/gm;
    const owners: string[] = [];
    for (const call of text.matchAll(/\.connect\(/g)) {
      const before = text.slice(0, call.index);
      const enclosing = [...before.matchAll(anchor)].at(-1);
      const named = enclosing?.[1] ?? enclosing?.[2];
      if (named !== undefined) owners.push(named);
    }
    return owners;
  };

  const RIG_SHAPES = [
    {
      what: 'a named helper that connects a plugin',
      matches: (text: string): boolean => rigHelpers(text).length > 0,
    },
    {
      what: 'a stderr capture',
      matches: (text: string): boolean => /spyOn\(process\.stderr/.test(text),
    },
  ];

  /**
   * A comment about a conformance-context field that does not sit on that field is a claim nothing
   * can fail on: `concurrentPost: 'unsupported'` carried a note reading "NO concurrentPost,
   * deliberately" — telling a maintainer the field was absent when it was present, and the two
   * spellings select different conformance clauses. Anchor every such note to the field it
   * describes, so that changing a field cannot leave its narration behind.
   */
  it('annotates each conformance context field on the field itself', () => {
    const lines = readFileSync(join(here, 'conformance.test.ts'), 'utf8').split('\n');
    const fieldOn = (line: string): string | undefined => /^ {4}(\w+):/.exec(line)?.[1];
    const fields = lines.map(fieldOn).filter((f): f is string => f !== undefined);
    // Only multi-word identifiers: a bare `plugin` or `cleanup` is an English word a comment may
    // use about anything, and a lint that reads those as references fires on ordinary prose.
    const referable = fields.filter((f) => /[A-Z_]/.test(f));
    expect(referable).toContain('concurrentPost');

    let checked = 0;
    for (const [i, line] of lines.entries()) {
      const comment = /^\s*(?:\/\/|\*|\/\*)(.*)$/.exec(line)?.[1];
      if (comment === undefined) continue;
      const named = referable.filter((f) => new RegExp(`\\b${f}\\b`).test(comment));
      if (named.length === 0) continue;
      checked++;
      // A trailing comment annotates its own line; a standalone one annotates the next field.
      const annotated = fieldOn(line) ?? lines.slice(i + 1).map(fieldOn).find((f) => f !== undefined);
      expect({ line: comment.trim(), annotated }).toEqual({ line: comment.trim(), annotated: named[0] });
    }
    // A rule nothing exercises is not a rule: at least one field carries a note naming it.
    expect(checked).toBeGreaterThan(0);
  });

  /**
   * The lint above keeps ONE rig per shape; this keeps the two rigs' LIFETIMES the same. They share
   * a method name and a doc and differ only in who runs teardown — so a `restart()` that registered
   * its plugin in one and not in the other gave the same call opposite contracts, and the first test
   * to take the unregistered route would inherit a stray getUpdates loop and an unclosed store
   * descriptor outliving its own case. Graded on descriptors rather than on plugin behaviour: an fd
   * on the store file is what a plugin still running actually holds.
   */
  const openFdsFor = (target: string): number => {
    let held = 0;
    for (const fd of readdirSync('/proc/self/fd')) {
      try {
        // A teardown that removed the tmpdir leaves the link spelled '<path> (deleted)', and a
        // probe that missed that would read every leak as zero.
        const link = readlinkSync(join('/proc/self/fd', fd));
        if (link === target || link === `${target} (deleted)`) held++;
      } catch {
        // The descriptor closed while this scan walked past it.
      }
    }
    return held;
  };

  const RIGS = [
    {
      what: 'startRig',
      open: async (): Promise<{ rig: Rig; teardown: () => Promise<void> }> => ({
        rig: await startRig(),
        teardown: runCleanups,
      }),
    },
    {
      what: 'openRig',
      open: async (): Promise<{ rig: Rig; teardown: () => Promise<void> }> => {
        const rig = await openRig();
        return { rig, teardown: rig.close };
      },
    },
  ];

  it.each(RIGS)('$what releases every plugin its restart() connected', async ({ open }) => {
    const { rig, teardown } = await open();
    let plugin = rig.plugin;
    for (const _ of [1, 2]) {
      await plugin.disconnect();
      plugin = await rig.restart();
    }
    // Positive control for the probe: with one plugin live the store file has exactly one holder,
    // so the assertion after teardown cannot pass by measuring nothing.
    expect(openFdsFor(rig.storePath)).toBe(1);

    await teardown();
    expect(openFdsFor(rig.storePath)).toBe(0);
  }, 20_000);

  it.each(RIG_SHAPES)('leaves $what to rig.ts alone', ({ matches }) => {
    // rig.ts is the positive control: patterns that stop matching there make the list below vacuous.
    expect(matches(readFileSync(join(here, 'rig.ts'), 'utf8'))).toBe(true);
    const offenders = readdirSync(here)
      .filter((f) => f.endsWith('.test.ts'))
      .filter((f) => matches(readFileSync(join(here, f), 'utf8')));
    expect(offenders).toEqual([]);
  });
});

/**
 * `store_path`'s default is executed by nothing else in this package — every other connect passes an
 * explicit path — while the README and its JSDoc rest a load-bearing claim on it: ABSOLUTE, under
 * the state directory core keeps its cursors in. A relative default silently starts a fresh sequence
 * space whenever the bridge is relaunched from another working directory, and `fetchRecent` then
 * rejects every cursor an agent is still holding as ahead of the store. The expectation is read out
 * of the shipped README row, so the code and the claim cannot drift apart in either direction.
 */
describe('telegram default store path', () => {
  const storePathRow = readme.split('\n').find((l) => l.startsWith('| `store_path`')) ?? '';
  const documented = /\$XDG_STATE_HOME\/([\w./-]+)/.exec(storePathRow)?.[1] ?? '';
  const fallbackBase = /else\s+`~\/([\w./-]+?)\/?…/.exec(storePathRow)?.[1] ?? '';

  it('is documented as an absolute path with a state-directory suffix', () => {
    expect(storePathRow).toMatch(/absolute/i);
    expect(documented).toBe('parley/telegram/observed.jsonl');
    expect(fallbackBase).toBe('.local/state');
  });

  const ENVS = [
    { name: 'XDG_STATE_HOME set', base: (home: string): string => home, xdg: true },
    { name: 'XDG_STATE_HOME unset', base: (home: string): string => join(home, fallbackBase), xdg: false },
  ];

  it.each(ENVS)('with $name it lands under the documented suffix, absolute', async ({ base, xdg }) => {
    const home = mkdtempSync(join(tmpdir(), 'parley-tg-xdg-'));
    const saved = { xdg: process.env.XDG_STATE_HOME, home: process.env.HOME };
    registerCleanup(() => {
      process.env.XDG_STATE_HOME = saved.xdg;
      process.env.HOME = saved.home;
      rmSync(home, { recursive: true, force: true });
    });
    // HOME is what `os.homedir()` reads on POSIX, so the unset case never touches the real one.
    process.env.HOME = home;
    if (xdg) process.env.XDG_STATE_HOME = home;
    else delete process.env.XDG_STATE_HOME;

    const fake = await startFake();
    const plugin = new TelegramPlugin();
    await plugin.connect({ token: fake.token, api_url: fake.url, poll_timeout_s: 1 });
    registerCleanup(() => plugin.disconnect());
    const topic = asTopic('-1009870001');
    await plugin.post(topic, SENDER, 'default-path');

    const expected = join(base(home), documented);
    expect(isAbsolute(expected)).toBe(true);
    expect(existsSync(expected)).toBe(true);
    expect(readFileSync(expected, 'utf8')).toContain('default-path');
    // And it is really the store this connection is answering out of.
    expect((await plugin.fetchRecent({ topic })).messages.map((m) => m.content)).toEqual([
      'default-path',
    ]);
  }, 20_000);
});

/**
 * A README row that claims an ABSENCE is the kind of claim nothing else can fail on, and this row
 * used to claim more than the code delivers: resolving an `@channelusername` topic awaits
 * `getChat`, so the first catch-up on such a topic really does need Telegram. Drive the seam call
 * with `getChat` broken and grade the row against what the call actually does.
 */
describe('telegram fetchRecent network claim', () => {
  const fetchRecentRow = readme.split('\n').find((l) => l.startsWith('| `fetchRecent`')) ?? '';

  it('names the resolution cost instead of claiming no network call', () => {
    expect(fetchRecentRow).not.toBe('');
    expect(fetchRecentRow).toMatch(/getChat/);
    expect(fetchRecentRow).toMatch(/no history endpoint is ever called/i);
  });

  it.each([
    { name: 'a chat_map @name topic, resolved during connect', mapped: true, offlineSafe: true },
    { name: 'an @name topic never named in chat_map', mapped: false, offlineSafe: false },
  ])('$name is offline-safe: $offlineSafe', async ({ mapped, offlineSafe }) => {
    captureStderr();
    const fake = await startFake();
    const plugin = await connectTo(fake, storePath(), {
      chat_map: mapped ? { news: KNOWN_CHANNEL.username } : {},
    });
    const topic = asTopic(mapped ? 'news' : KNOWN_CHANNEL.username);

    // Telegram becomes unreachable AFTER connect: catch-up must not depend on it for a chat the
    // bridge already resolved, and the README must not promise more than that.
    fake.failMethod('getChat', { status: 500, description: 'Internal Server Error' });
    const caughtUp = plugin.fetchRecent({ topic });
    if (offlineSafe) {
      expect((await caughtUp).messages).toEqual([]);
      return;
    }
    await expect(caughtUp).rejects.toThrow(/getChat/);
  }, 20_000);
});

/**
 * Core enables presence by default on a topic (`parley-presence`) that is not a Telegram chat id,
 * and core's presence loop swallows the failure — so an operator gets an empty roster and no
 * explanation. The sibling SaaS plugins warn about this in their READMEs; either this one resolves
 * the default topic or it carries the same warning, and either way the plugin says something.
 */
describe('telegram default presence topic', () => {
  const DEFAULT_PRESENCE_TOPIC = 'parley-presence';

  it('is either resolvable or documented as needing configuration', async () => {
    captureStderr();
    const { plugin } = await startRig();
    const resolvable = await plugin
      .fetchRecent({ topic: asTopic(DEFAULT_PRESENCE_TOPIC) })
      .then(() => true)
      .catch(() => false);
    if (resolvable) return;
    const warning = /presence/i.test(readme) ? readme : '';
    expect(warning).toMatch(/presence\.enabled.*false|presence\.topic/is);
    expect(warning).toContain(DEFAULT_PRESENCE_TOPIC);
  }, 20_000);

  it('writes a diagnostic when a topic resolves to no chat, instead of failing silently', async () => {
    const stderr = captureStderr();
    const { plugin } = await startRig();
    await expect(
      plugin.fetchRecent({ topic: asTopic(DEFAULT_PRESENCE_TOPIC) }),
    ).rejects.toThrow(/not a Telegram chat id/);
    expect(stderr.join('')).toContain(DEFAULT_PRESENCE_TOPIC);
    expect(stderr.join('')).toMatch(/resolves to no Telegram chat/);
  }, 20_000);
});
