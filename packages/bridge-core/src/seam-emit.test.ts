import { expect, it } from 'vitest';

/**
 * CLASS: the module a seam type is DECLARED in is the contract every backend author reads, and a
 * helper parked in one publishes an implementation from the declaration of an interface — the two
 * things this repo's prime directive keeps apart.
 *
 * Judged by IMPORTING the module and asking what it bound. A declaration file emits nothing, so its
 * namespace is empty; the moment anything in it BINDS a name the namespace is not, whatever shape
 * that binding takes — a `const` arrow, a decorator. What a module pulls IN is a different question
 * and a different guard: a side-effecting import never adds a key to the importing module's
 * namespace, and the dependency-direction rule in the conformance suite is what grades it. Three
 * earlier spellings of this rule were hollowed out in three rounds, each by moving what it anchors on:
 * `seam.ts` was replaced by a checker-derived file set, which is a derivation nothing outside the
 * suite could keep honest and which still resolved to this one module.
 */
it('the seam declaration emits nothing', async () => {
  expect(Object.keys(await import('./seam.js'))).toEqual([]);
});
