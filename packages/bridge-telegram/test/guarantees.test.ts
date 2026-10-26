import { asHandle } from '@sharptrick/parley-core';
import { describe, expect, it, vi } from 'vitest';
import { BOT_IDENTITY } from './fake-telegram.js';
import { startRig } from './rig.js';

/**
 * Behaviour this package states as a guarantee in its JSDoc and its README seam-mapping table but
 * that no test could fail on: prose is not a guarantee, and every row here was written by deleting
 * the implementing lines first and watching it go red.
 */
describe('telegram documented guarantees', () => {
  it('disconnect aborts the in-flight long poll rather than leaving it parked upstream', async () => {
    const { fake, plugin } = await startRig({ poll_timeout_s: 20 });
    await vi.waitFor(() => expect(fake.parkedPolls()).toBe(1), { timeout: 5000, interval: 10 });

    await plugin.disconnect();
    await vi.waitFor(() => expect(fake.parkedPolls()).toBe(0), { timeout: 1000, interval: 10 });
  }, 20_000);

  it.each([
    { name: "the bot's own username", handle: BOT_IDENTITY.username, ref: String(BOT_IDENTITY.id) },
    { name: 'any other handle', handle: 'someone-else', ref: 'someone-else' },
  ])('resolveIdentity maps $name', async ({ handle, ref }) => {
    const { plugin } = await startRig();
    const identity = await plugin.resolveIdentity(asHandle(handle));
    expect(identity).toEqual({ handle, backendRef: ref });
  }, 20_000);
});
