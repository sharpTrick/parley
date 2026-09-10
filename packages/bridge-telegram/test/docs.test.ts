import { existsSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asTopic } from '@sharptrick/parley-core';
import { describe, expect, it, vi } from 'vitest';
import { TelegramPlugin } from '../src/index.js';
import { KNOWN_CHANNEL } from './fake-telegram.js';
import { derivedRows } from '@sharptrick/parley-net-util/testing';
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
const configTable = /## Config \(`backend_config`\)([\s\S]*?)\n## /.exec(readme)?.[1] ?? '';
const declaredKeys = [
  ...(/export interface TelegramBackendConfig \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? '').matchAll(
    /^ {2}(\w+)\??:/gm,
  ),
].map((m) => m[1] as string);

/**
 * The cursor a fetched message carries is the store's own observation sequence, never Telegram's
 * `message_id`. A `message_id` is minted when the sender's message is accepted, so one minted
 * BEFORE a post of ours can be delivered after it and would sit forever below a cursor already
 * issued.
 *
 * Why this shape: a first chat consumes two sequences, so the second chat's `message_id` (1) and
 * its cursor (3) cannot coincide — against one chat a plugin returning either value looks the same.
 *
 * Proof it can fail: return the `message_id` half of the id as the cursor and this reds.
 */
describe('telegram cursors are the observation sequence', () => {
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

  /**
   * The same bullet for the chat that has NOTHING but the mark. The case above posts into every
   * chat it names, so each one is also a chat the store is retaining records for — and a mark list
   * derived from those records carries it for that reason rather than because it was served. A
   * topic a seam call merely READ has no records, no `chat_map` entry and no traffic yet, which is
   * exactly the state the bullet's "before any seam call in the new process could have named it
   * again" describes; the store file is rewritten wholesale on every compaction, so the mark has to
   * survive one.
   */
  it('keeps a chat a seam call only read, across the rewrite that compacts the store file', async () => {
    const quiet = '-1009882222';
    const rig = await startRig({
      observed_max_chats: 2,
      observed_retention_per_chat: 1,
      chat_map: { sentinel: SENTINEL },
    });
    // A read is a seam call: it names the chat, and it is all this chat will ever have.
    expect(await contentsOf(rig.plugin, asTopic(quiet))).toEqual([]);
    // Evicted records are what arm the store's amortized rewrite; a retention of 1 evicts on every
    // drain, so the file is compacted well before the restart.
    for (let round = 0; round < 4; round++) await drain(rig, `settled-${round}`);

    const restarted = await coldRestart(rig);
    const after: Rig = { ...rig, plugin: restarted };
    rig.fake.injectUserMessage(quiet, 'ops', 'first traffic');
    await drain(after, 'the quiet chat spoke');
    for (const c of FLOOD_CHATS) rig.fake.injectUserMessage(c, 'mallory', `displacing-${c}`);
    await drain(after, 'flooded');

    // Measured last: asking after the chat is itself what would have protected it.
    expect(await contentsOf(restarted, asTopic(quiet))).toContain('first traffic');
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
  const modules = derivedRows(
    'every telegram source module',
    () => readdirSync(join(here, '..', 'src')).filter((f) => f.endsWith('.ts')).sort(),
    { floor: 3, witness: ['config.ts'] },
  );
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

/**
 * `fs.writeSync` performs ONE `write(2)` and REPORTS how much of the buffer the kernel took;
 * `appendFileSync`/`writeFileSync` loop until there is none left, and this package leans on that
 * elsewhere. Nothing in the type system separates the two kinds, so a call whose returned count is
 * dropped on the floor is a short write that reports success — and this store's rewrite renames its
 * output over the ONLY copy of a backend's history, with no Bot API endpoint that could rebuild a
 * truncated one. Read over `src/` as a whole rather than at named call sites, so that a writer
 * added beside a sibling this store grows later inherits the rule.
 */
describe('telegram single-write primitives never discard their byte count', () => {
  /** A call in statement position — nothing to the left of it that could be reading the count. */
  const DISCARDED = /(?:^|[;{}])\s*(?:void\s+)?(?:[\w$]+\.)?(writeSync|writevSync|readSync|readvSync)\s*\(/g;
  const discardedIn = (text: string): string[] =>
    [...text.matchAll(DISCARDED)].map((m) => m[1] as string);

  /**
   * Graded against SAMPLES rather than against the package, so that the guard cannot rot into a
   * pattern matching nothing — and so that it never becomes a reason this package must go on
   * calling these primitives at all.
   */
  it('tells a discarded byte count from a consumed one', () => {
    expect(discardedIn('  writeSync(fd, text);\n')).toEqual(['writeSync']);
    expect(discardedIn('  fs.writeSync(fd, text);\n')).toEqual(['writeSync']);
    expect(discardedIn('{ readSync(fd, buf); }')).toEqual(['readSync']);
    expect(discardedIn('  const n = writeSync(fd, b, 0, 1);\n')).toEqual([]);
    expect(discardedIn('  while (n < len) n += writeSync(fd, b, n, len - n);\n')).toEqual([]);
    expect(discardedIn('    const n =\n      fs.writeSync(fd, b);\n')).toEqual([]);
  });

  it('reads every count the package asks for', () => {
    expect(discardedIn(source)).toEqual([]);
  });
});

describe('telegram test suite hygiene', () => {
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
  const SUFFIX = 'parley/telegram/observed.jsonl';
  const FALLBACK_BASE = '.local/state';

  const ENVS = [
    { name: 'XDG_STATE_HOME set', base: (home: string): string => home, xdg: true },
    { name: 'XDG_STATE_HOME unset', base: (home: string): string => join(home, FALLBACK_BASE), xdg: false },
  ];

  it.each(ENVS)('with $name the default store lands under the state directory, absolute', async ({ base, xdg }) => {
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

    const expected = join(base(home), SUFFIX);
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
 * A topic that is neither a numeric chat id nor an `@channelusername` resolves to no chat. The
 * caller's rejection says so; the operator gets a line on stderr too, so a misconfigured topic is
 * not a silently dead one.
 */
describe('telegram diagnostics for an unresolvable topic', () => {
  const UNRESOLVABLE_TOPIC = 'not-a-chat-id';

  it('writes a diagnostic when a topic resolves to no chat, instead of failing silently', async () => {
    const stderr = captureStderr();
    const { plugin } = await startRig();
    await expect(
      plugin.fetchRecent({ topic: asTopic(UNRESOLVABLE_TOPIC) }),
    ).rejects.toThrow(/not a Telegram chat id/);
    expect(stderr.join('')).toContain(UNRESOLVABLE_TOPIC);
    expect(stderr.join('')).toMatch(/resolves to no Telegram chat/);
  }, 20_000);
});
