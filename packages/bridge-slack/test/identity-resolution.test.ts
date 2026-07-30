/**
 * CLASS: a seam method whose RETURNED VALUE no row asserts.
 *
 * `resolveIdentity` has the most branches of any method on this plugin and was the least graded of
 * them: the whole `auth.test` arm — a memoized network call plus the id it returns — could be
 * replaced with `return { handle, backendRef: handle }` and the suite stayed green, because the one
 * test that drove it called the method purely to count wire hits and never looked at the answer. So
 * the README's "own bot name → `auth.test` user id" row was unbacked, and the branch could have been
 * deleted outright without a failure.
 *
 * Every row below therefore asserts the FULL `BackendIdentity`, not one field of it, and the table
 * covers each way a handle can resolve: through the workspace directory, through the bot's own
 * identity under either of its two names, and through the name-convention passthrough that DESIGN §4
 * exists for. `http-contract.test.ts` owns the failure codes; this owns the successful shapes.
 */
import { asHandle, type BackendIdentity } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { withSlack } from './harness.js';

/** What the fake's `auth.test` answers with — the bot's two names, and the id both must resolve to. */
const BOT_NAME = 'parley-bot';
const BOT_USER_ID = 'U0PARLEY';

const RESOLUTIONS: Array<{ name: string; handle: string; backendRef: string }> = [
  {
    name: 'an email that the workspace directory knows',
    handle: 'alice@example.com',
    backendRef: 'U0ALICE',
  },
  {
    name: 'an email the workspace directory does not know',
    handle: 'nobody@example.com',
    backendRef: 'nobody@example.com',
  },
  { name: "the bot's own user name", handle: BOT_NAME, backendRef: BOT_USER_ID },
  { name: "the bot's own user id", handle: BOT_USER_ID, backendRef: BOT_USER_ID },
  { name: 'an unrelated bare handle', handle: 'ctx-payments', backendRef: 'ctx-payments' },
  // Discrimination, not resolution: each of these is NEITHER of the bot's names, so a comparison
  // loose about prefixes or case would hand back the bot's id for somebody else's handle.
  { name: "a handle sharing the bot name's prefix", handle: 'parley-bot-2', backendRef: 'parley-bot-2' },
  { name: "a handle sharing the bot id's prefix", handle: 'U0PARLEYX', backendRef: 'U0PARLEYX' },
  { name: "the bot name in another case", handle: 'PARLEY-BOT', backendRef: 'PARLEY-BOT' },
  { name: 'the empty-ish handle a caller can still pass', handle: ' ', backendRef: ' ' },
];

describe('slack resolveIdentity returns the identity each row declares', () => {
  for (const row of RESOLUTIONS) {
    it(`${row.name} → ${JSON.stringify(row.backendRef)}`, async () => {
      await withSlack({}, async (_fake, plugin) => {
        const identity: BackendIdentity = await plugin.resolveIdentity(asHandle(row.handle));
        expect(identity).toEqual({ handle: row.handle, backendRef: row.backendRef });
      });
    });
  }

  it('the bot rows are answered by auth.test, memoized across every handle', async () => {
    await withSlack({}, async (fake, plugin) => {
      for (const row of RESOLUTIONS) await plugin.resolveIdentity(asHandle(row.handle));
      // Every bare handle consults the bot's identity; the call behind it happens once.
      expect(fake.hits('auth.test'), 'auth.test calls').toBe(1);
      // …and the passthrough rows never ask the directory about a handle with no `@` in it.
      expect(fake.hits('users.lookupByEmail'), 'directory lookups').toBe(
        RESOLUTIONS.filter((r) => r.handle.includes('@')).length,
      );
    });
  });
});
