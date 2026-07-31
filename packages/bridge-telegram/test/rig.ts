import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, vi } from 'vitest';
import { TelegramPlugin } from '../src/index.js';
import { type FakeTelegram, startFakeTelegram } from './fake-telegram.js';

/**
 * The one connect-a-plugin-against-the-fake-with-a-tmpdir rig for this package's tests, and the one
 * stderr capture. Both used to be retyped per file — the rig in eight of the ten test files under
 * three names and two teardown contracts, so a fix to teardown ordering was either made eight times
 * or made once and silently not applied, and one copy had drifted into asserting on a plugin it
 * never connected. `docs.test.ts` lints the duplication back out, using THIS file as its positive
 * control.
 *
 * Teardown is registered on the importing file's `afterEach` and runs newest-first: parked long
 * polls and store descriptors go before the fake and the tmpdir they belong to. A test that needs a
 * different lifetime (the conformance suite owns its own) takes {@link openRig} instead.
 */
export interface Rig {
  fake: FakeTelegram;
  plugin: TelegramPlugin;
  /** Path of the observed-message store — shared by every plugin this rig connects. */
  storePath: string;
  /** Connect a NEW plugin instance against the same fake and store file (cold restart). */
  restart(): Promise<TelegramPlugin>;
}

const cleanups: (() => Promise<void> | void)[] = [];

/**
 * Run every registered teardown, newest-first, and forget them. Exported so a test whose subject IS
 * the teardown can drive it and then assert; the `afterEach` below finds nothing left to do.
 */
export async function runCleanups(): Promise<void> {
  for (const c of cleanups.splice(0).reverse()) await c();
}

afterEach(async () => {
  await runCleanups();
  vi.restoreAllMocks();
});

/** Register teardown for something a test built itself, in the rig's own LIFO order. */
export function registerCleanup(fn: () => Promise<void> | void): void {
  cleanups.push(fn);
}

/** A store path in a fresh tmpdir, removed after the test. */
export function storePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'parley-tg-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'store.jsonl');
}

/** A fake Bot API, closed after the test. */
export async function startFake(): Promise<FakeTelegram> {
  const fake = await startFakeTelegram();
  cleanups.push(() => fake.close());
  return fake;
}

async function connect(
  fake: FakeTelegram,
  path: string,
  config: Record<string, unknown>,
): Promise<TelegramPlugin> {
  const plugin = new TelegramPlugin();
  await plugin.connect({
    token: fake.token,
    api_url: fake.url,
    store_path: path,
    poll_timeout_s: 1,
    ...config,
  });
  return plugin;
}

/** Connect a plugin to `fake` against `path`, disconnected after the test. */
export async function connectTo(
  fake: FakeTelegram,
  path: string,
  config: Record<string, unknown> = {},
): Promise<TelegramPlugin> {
  const plugin = await connect(fake, path, config);
  cleanups.push(() => plugin.disconnect());
  return plugin;
}

/** A fake + a store path + a connected plugin, with `restart()` for the cold-restart route. */
export async function startRig(config: Record<string, unknown> = {}): Promise<Rig> {
  const fake = await startFake();
  const path = storePath();
  const reconnect = (): Promise<TelegramPlugin> => connectTo(fake, path, config);
  return { fake, storePath: path, plugin: await reconnect(), restart: reconnect };
}

/**
 * The same rig with an EXPLICIT lifetime, for a caller whose teardown is not `afterEach` — the
 * shared conformance suite closes its context itself.
 */
export async function openRig(
  config: Record<string, unknown> = {},
): Promise<Rig & { close(): Promise<void> }> {
  const fake = await startFakeTelegram();
  const dir = mkdtempSync(join(tmpdir(), 'parley-tg-'));
  const path = join(dir, 'store.jsonl');
  // Every plugin this rig connects, so `close` releases all of them newest-first — the same LIFO
  // contract `startRig` gets from the module-level cleanups. A `close` that only knew about the
  // FIRST one left a restart's poll loop and store descriptor running past the test that made it.
  const connected: TelegramPlugin[] = [await connect(fake, path, config)];
  return {
    fake,
    plugin: connected[0] as TelegramPlugin,
    storePath: path,
    restart: async () => {
      const plugin = await connect(fake, path, config);
      connected.push(plugin);
      return plugin;
    },
    close: async () => {
      for (const plugin of [...connected].reverse()) await plugin.disconnect();
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Matches a cursor this plugin issues: the store file's identity, then its observation sequence. */
export const QUALIFIED_CURSOR = /^[0-9a-f]{16}\.\d+$/;

/**
 * The observation sequence a cursor names, asserting the qualified shape on the way through. A
 * cursor is `<store epoch>.<seq>`, and the epoch half is what makes a cursor minted by a store file
 * this one did not inherit refusable — so a test that compared cursors with `Number()` would read
 * every one of them as `NaN` and compare nothing.
 */
export function seqOf(cursor: string): number {
  expect(cursor).toMatch(QUALIFIED_CURSOR);
  return Number(cursor.split('.')[1]);
}

/** Capture stderr diagnostics without letting them pollute the test output. */
export function captureStderr(): string[] {
  const lines: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });
  return lines;
}
