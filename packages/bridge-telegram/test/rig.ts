import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asHandle, type Topic } from '@sharptrick/parley-core';
import { afterEach, expect, vi } from 'vitest';
import { TelegramPlugin } from '../src/index.js';
import type { StoredRecord } from '../src/store.js';
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
  /**
   * Connect the SAME plugin instance again, as a client that disconnected and came back does. The
   * per-instance registries a `disconnect` has to clear — live subscriptions — survive on the
   * object, so a new instance from {@link restart} cannot reach them.
   */
  reconnect(): Promise<void>;
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

/**
 * Every module of this package's source, concatenated. Structural lints read declarations out of
 * the source text; anchoring them on the TREE rather than on one path is what lets a module be
 * split without a lint that has no opinion about layout going red — and what makes a symbol moved
 * into a new file still count as declared.
 */
export function packageSource(): string {
  const dir = fileURLToPath(new URL('../src/', import.meta.url));
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n');
}

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

async function connectPlugin(
  plugin: TelegramPlugin,
  fake: FakeTelegram,
  path: string,
  config: Record<string, unknown>,
): Promise<void> {
  await plugin.connect({
    token: fake.token,
    api_url: fake.url,
    store_path: path,
    poll_timeout_s: 1,
    ...config,
  });
}

async function connect(
  fake: FakeTelegram,
  path: string,
  config: Record<string, unknown>,
): Promise<TelegramPlugin> {
  const plugin = new TelegramPlugin();
  await connectPlugin(plugin, fake, path, config);
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

/** Connect a plugin to `fake` against a store of its own, for a test that never names the file. */
export function connectFresh(
  fake: FakeTelegram,
  config: Record<string, unknown> = {},
): Promise<TelegramPlugin> {
  return connectTo(fake, storePath(), config);
}

/** A fake + a store path + a connected plugin, with `restart()` for the cold-restart route. */
export async function startRig(config: Record<string, unknown> = {}): Promise<Rig> {
  const fake = await startFake();
  const path = storePath();
  const restart = (): Promise<TelegramPlugin> => connectTo(fake, path, config);
  const plugin = await restart();
  return {
    fake,
    storePath: path,
    plugin,
    restart,
    reconnect: () => connectPlugin(plugin, fake, path, config),
  };
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
    reconnect: () => connectPlugin(connected[0] as TelegramPlugin, fake, path, config),
    close: async () => {
      for (const plugin of [...connected].reverse()) await plugin.disconnect();
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The handle this package's tests post under. */
export const SENDER = asHandle('me');

/** A topic's retained window, oldest first — what an agent catching up on it would be given. */
export async function contentsOf(plugin: TelegramPlugin, topic: Topic): Promise<string[]> {
  return (await plugin.fetchRecent({ topic, limit: 100 })).messages.map((m) => m.content);
}

/** Cold restart: a fresh plugin instance on the same fake and the same store file. */
export async function coldRestart(rig: Rig): Promise<TelegramPlugin> {
  await rig.plugin.disconnect();
  return rig.restart();
}

/** A stored record of the shape `ObservedStore` admits, for a test that drives the store directly. */
export const record = (
  chatId: string,
  messageId: number,
  content: string,
  seq = messageId,
): StoredRecord => ({
  chat_id: chatId,
  message_id: messageId,
  seq,
  sender: 's',
  content,
  ts: new Date().toISOString(),
});

/** Record lines on disk — the dedup memory a compaction persists is not a record. */
export const lineCount = (path: string): number =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l !== '' && !l.startsWith('#')).length;

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
