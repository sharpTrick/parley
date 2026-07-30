import net from 'node:net';
import { asTopic, type Topic } from '@sharptrick/parley-core';
import {
  createRedisClient,
  DEFAULT_URL,
  RedisPlugin,
  type RedisBackendConfig,
} from '../src/index.js';

// One liveness gate, one topic minter, one endpoint minter and one cleanup path for every live-server
// file in this package. Keep them here, so that two copies of the skip gate cannot drift and leave
// one file silently skipping — or silently running — while the other does the opposite, and so that
// no test file names an endpoint of its own (see `endpoint-hygiene.test.ts`).

export const REDIS_URL = process.env.PARLEY_REDIS_URL ?? DEFAULT_URL;

/**
 * A `redis://` URL on a port the OS just told us was free.
 *
 * Keep the mint, so that a "nothing is listening here" row owns the guarantee it asserts: a
 * hard-coded port is one any other process on the box — a sibling agent's throwaway server, a
 * previous run's leftover container — can take, turning the row red for a reason unrelated to the
 * code under test.
 */
export async function freeEndpoint(): Promise<string> {
  const probe = net.createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>((r) => probe.close(() => r()));
  return `redis://127.0.0.1:${port}`;
}

/** Connect budget for probe/admin connections: long enough for a live server, short enough to fail. */
export const FAST_MS = 800;

/**
 * Probe with the PLUGIN's own client builder, so that the harness can never be configured more
 * defensively than the code under test: a probe with private fail-fast options would make the
 * suite skip cleanly while the shipped plugin hangs forever against the same endpoint.
 */
export async function isRedisUp(url: string = REDIS_URL): Promise<boolean> {
  const c = createRedisClient(url, FAST_MS);
  try {
    await c.connect();
    await c.ping();
    await c.disconnect();
    return true;
  } catch {
    await c.disconnect().catch(() => undefined);
    return false;
  }
}

/** `host:port` of a connection URL, the way the plugin's own error lines spell an endpoint. */
export function endpointOf(url: string): string {
  const u = new URL(url);
  return `${u.hostname}:${u.port === '' ? '6379' : u.port}`;
}

export const rand = (): string => Math.random().toString(36).slice(2, 8);

/** A key namespace no other test (or concurrent run) shares. */
export const freshPrefix = (): string => `parleytest:${rand()}:`;

let seq = 0;

/** A topic no other test (or concurrent run) shares; `kind` names the file for a stray-key hunt. */
export const freshTopic = (kind: string): Topic => asTopic(`${kind}-${++seq}-${rand()}`);

/**
 * One connected plugin in a key namespace no other case shares, torn down and wiped however `body`
 * ends. `config` overrides anything but the namespace, which the rig owns because it also cleans it.
 *
 * Keep the setup and the teardown here rather than restated per case, so that a change to either —
 * draining stray readers, asserting no key survives the wipe — reaches every case instead of the
 * subset whose copy someone remembered to edit.
 */
export async function withPlugin<T>(
  config: RedisBackendConfig,
  body: (rig: { plugin: RedisPlugin; prefix: string }) => Promise<T>,
): Promise<T> {
  const prefix = freshPrefix();
  const plugin = new RedisPlugin();
  try {
    await plugin.connect({ url: REDIS_URL, ...config, key_prefix: prefix });
    return await body({ plugin, prefix });
  } finally {
    await plugin.disconnect().catch(() => undefined);
    await wipe(prefix);
  }
}

/**
 * An INDEPENDENT connection to the same server, closed however `body` ends — what a case uses to
 * write or read a stream without going through the code under test.
 */
export async function withWriter<T>(
  body: (writer: ReturnType<typeof createRedisClient>) => Promise<T>,
): Promise<T> {
  const writer = createRedisClient(REDIS_URL, FAST_MS);
  try {
    await writer.connect();
    return await body(writer);
  } finally {
    await writer.disconnect().catch(() => undefined);
  }
}

/** Delete every key a test's prefix owns; cleanup failures never mask the test's own verdict. */
export async function wipe(prefix: string): Promise<void> {
  const admin = createRedisClient(REDIS_URL, FAST_MS);
  try {
    await admin.connect();
    const keys = await admin.keys(`${prefix}*`);
    if (keys.length > 0) await admin.del(keys);
  } catch {
    /* the test already failed for a better reason than cleanup */
  } finally {
    await admin.disconnect().catch(() => undefined);
  }
}
