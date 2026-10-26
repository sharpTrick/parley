import { describe, expect, it } from 'vitest';
import { builtinOnlyOptions } from '../server.js';

/**
 * The remote front door REFUSES a builtin-only option under `auth.mode: oidc` rather than
 * discarding it, so a `PARLEY_TRUST_PROXY` left over from an earlier deployment turns a mode switch
 * into a failed boot. Every builtin-only env var has to be dropped before it reaches the factory.
 */
const BUILTIN_ONLY = [
  ['PARLEY_TRUST_PROXY', '2', 'trustProxy'],
  ['PARLEY_OWNER_SECRET_HASH', 'scrypt$1$2$3', 'ownerSecretHash'],
  ['PARLEY_OWNER_PASSPHRASE', 'hunter2', 'ownerPassphrase'],
] as const;

describe('builtin-only options are gated on auth.mode', () => {
  it.each(BUILTIN_ONLY)('%s is dropped in oidc mode', (envVar, value) => {
    expect(builtinOnlyOptions('oidc', { [envVar]: value })).toEqual({});
  });

  // The floor: gating must not become "always drop", which would silently disable the owner gate.
  it.each(BUILTIN_ONLY)('%s is passed through in builtin mode', (envVar, value, option) => {
    const out = builtinOnlyOptions('builtin', { [envVar]: value }) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual([option]);
    expect(out[option]).toBeDefined();
  });

  it('prefers a hash over a passphrase when both are set', () => {
    const out = builtinOnlyOptions('builtin', {
      PARLEY_OWNER_SECRET_HASH: 'scrypt$1$2$3',
      PARLEY_OWNER_PASSPHRASE: 'hunter2',
    });
    expect(out).toEqual({ ownerSecretHash: 'scrypt$1$2$3' });
  });

  it('passes nothing when the environment sets nothing', () => {
    expect(builtinOnlyOptions('builtin', {})).toEqual({});
  });
});
