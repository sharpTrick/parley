import { asTopic, type Topic } from '@sharptrick/parley-core';
import { createRedisClient } from '../src/index.js';

// One liveness gate, one topic minter and one cleanup path for every live-server file in this
// package. Keep them here, so that two copies of the skip gate cannot drift and leave one file
// silently skipping — or silently running — while the other does the opposite.

export const REDIS_URL = process.env.PARLEY_REDIS_URL ?? 'redis://127.0.0.1:6379';

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

export const rand = (): string => Math.random().toString(36).slice(2, 8);

/** A key namespace no other test (or concurrent run) shares. */
export const freshPrefix = (): string => `parleytest:${rand()}:`;

let seq = 0;

/** A topic no other test (or concurrent run) shares; `kind` names the file for a stray-key hunt. */
export const freshTopic = (kind: string): Topic => asTopic(`${kind}-${++seq}-${rand()}`);

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
