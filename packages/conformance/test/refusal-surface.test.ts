import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  asTopic,
  type BackendPlugin,
  isBlockingFetchUnsupportedError,
} from '@sharptrick/parley-core';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * CLASS: which answer `block_ms` gets is a permanent fact about a backend's read path, so it does
 * not depend on whether the instance happens to be connected. A backend with nowhere to park raises
 * its refusal BEFORE anything the call would need a socket for; two of the eight raised a
 * connectivity error instead, which is a TRANSIENT fault — an agent taught to retry one retries
 * `block_ms` against those two forever while dropping it after a single try against the other six.
 *
 * Driven off UNCONNECTED instances, so every row runs with no server, no container and no fake. That
 * is the property the conformance suite cannot supply: xmpp, postgres and matrix gate their whole
 * conformance run on a reachable server, so on a machine with none, dropping the refusal from any of
 * them was graded by nothing at all.
 *
 * The backend SET is DISCOVERED from the workspace rather than listed, so an eleventh plugin is a
 * red row the day it lands instead of a backend nothing asks the question of.
 */
const PACKAGES = fileURLToPath(new URL('../../', import.meta.url));

/** Every workspace package that exports a `*Plugin` class — the shipped backends, discovered. */
const shipped = new Map<string, new () => BackendPlugin>();

beforeAll(async () => {
  for (const dir of readdirSync(PACKAGES).sort()) {
    const entry = join(PACKAGES, dir, 'src/index.ts');
    if (!existsSync(entry)) continue;
    const module = (await import(/* @vite-ignore */ pathToFileURL(entry).href)) as Record<
      string,
      unknown
    >;
    for (const [name, exported] of Object.entries(module)) {
      if (name.endsWith('Plugin') && typeof exported === 'function') {
        shipped.set(dir, exported as new () => BackendPlugin);
      }
    }
  }
});

/**
 * Which arm of the `block_ms` contract each shipped backend takes. RECORDED rather than inferred:
 * the arm is decided by what a plugin does with a budget against a live server, and these rows run
 * without one. It is not a declaration a backend can hide behind — every row below fails if the
 * entry is wrong in either direction, and the conformance suite decides the same question
 * behaviourally wherever a server is reachable.
 *
 * Keyed off the DISCOVERED set, so a backend that ships with no decision recorded here is a red row.
 */
const ARM: Record<string, 'refuses' | 'parks'> = {
  'bridge-discord': 'refuses',
  'bridge-matrix': 'refuses',
  'bridge-nats': 'parks',
  'bridge-postgres': 'refuses',
  'bridge-redis': 'parks',
  'bridge-slack': 'refuses',
  'bridge-sqlite': 'refuses',
  'bridge-telegram': 'refuses',
  'bridge-xmpp': 'refuses',
  'bridge-zulip': 'refuses',
};

const answerTo = async (dir: string, blockMs: number): Promise<unknown> => {
  const Plugin = shipped.get(dir) as new () => BackendPlugin;
  return new Plugin().fetchRecent({ topic: asTopic('ops'), blockMs }).catch((err: unknown) => err);
};

describe('every shipped backend answers block_ms before it needs a connection', () => {
  it('discovers the shipped plugins, so the rows below are not an empty table', () => {
    expect(shipped.size).toBeGreaterThan(5);
  });

  it('records an arm for exactly the backends the workspace ships', () => {
    expect(
      Object.keys(ARM).sort(),
      'a shipped backend with no arm recorded here is one no row below asks the question of; a ' +
        'recorded name the workspace no longer ships is a row grading nothing',
    ).toEqual([...shipped.keys()].sort());
  });

  it.each(Object.entries(ARM))('%s (%s) never answers a positive block_ms with a page', async (dir) => {
    const answered = await answerTo(dir, 5_000);
    expect(
      answered instanceof Error,
      `an unconnected ${dir} answered a 5s block_ms with a page. A page returned as though the ` +
        'wait had happened is what a long poll that timed out empty looks like',
    ).toBe(true);
  });

  it.each(Object.entries(ARM).filter(([, arm]) => arm === 'refuses'))(
    '%s refuses it by name rather than reporting a connectivity fault',
    async (dir) => {
      const answered = await answerTo(dir, 5_000);
      expect(
        isBlockingFetchUnsupportedError(answered),
        `an unconnected ${dir} answered a block_ms with ${String(answered)}. That is a fault a ` +
          'caller retries; the refusal is a fact about the backend that no retry changes',
      ).toBe(true);
      expect(String(answered)).toContain(dir.replace('bridge-', 'parley-'));
    },
  );

  // `blockMs: 0` is the ordinary catch-up call core makes on every read, so it must never be taken
  // for a budget — on either arm.
  it.each(Object.entries(ARM))('%s (%s) does not mistake the catch-up call for a budget', async (dir) => {
    expect(isBlockingFetchUnsupportedError(await answerTo(dir, 0))).toBe(false);
  });

  // The other direction of the recorded arm: a backend that PARKS has no refusal to give, so one
  // that raises it here is a backend whose recorded arm is wrong — which would let the row above
  // certify the ordering of a plugin that never refuses at all.
  it.each(Object.entries(ARM).filter(([, arm]) => arm === 'parks'))(
    '%s parks rather than refusing, so it raises no refusal at all',
    async (dir) => {
      expect(isBlockingFetchUnsupportedError(await answerTo(dir, 5_000))).toBe(false);
    },
  );
});
