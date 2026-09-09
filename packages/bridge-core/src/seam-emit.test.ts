import { expect, it } from 'vitest';

/**
 * CLASS: the module a seam type is DECLARED in is the contract every backend author reads, and a
 * helper parked in one publishes an implementation from the declaration of an interface — the two
 * things this repo's prime directive keeps apart.
 *
 * Judged by IMPORTING the module and asking what it bound. A declaration file emits nothing, so its
 * namespace is empty; the moment anything in it emits runtime code the namespace is not, whatever
 * shape that code takes — a `const` arrow, a decorator, a side-effecting import. Three earlier
 * spellings of this rule were hollowed out in three rounds, each by moving what it anchored on:
 * `seam.ts` was replaced by a checker-derived file set, which is a derivation nothing outside the
 * suite could keep honest and which still resolved to this one module.
 */
it('the seam declaration emits nothing', async () => {
  expect(Object.keys(await import('./seam.js'))).toEqual([]);
});
