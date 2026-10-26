import { describe, expect, it } from 'vitest';
import { backendConfigDeclarations, testSourcesOf } from './declared-config-keys.js';

const count = (text: string, needle: string): number => text.split(needle).length - 1;

/**
 * CLASS: a plugin renders a rejected `backend_config` value into an error an operator reads and
 * core hands to a model. Every such plugin has to be crossed over the shared hostile corpus, and
 * the set of them is DERIVED from each plugin's own `satisfies Record<keyof Required<…>>` block
 * rather than listed here — a hand-listed set is what shipped this defect in five plugins, and then
 * again in three more the fix's own ratchet never asked about.
 */
describe('every backend that declares a backend_config is crossed over the hostile corpus', () => {
  const declared = backendConfigDeclarations();

  it('finds the declarations at all, so the rows below are not vacuous', () => {
    expect(declared.length).toBeGreaterThan(5);
    expect(declared.filter((d) => d.keys.length === 0)).toEqual([]);
  });

  it.each(declared.map((d) => [d.pkg] as const))('%s crosses it', (pkg) => {
    expect(
      count(testSourcesOf(pkg), 'expectLabelledRefusal('),
      `${pkg} declares a backend_config but no test of its own calls expectLabelledRefusal`,
    ).toBeGreaterThan(0);
  });

  /**
   * A spec may grade a surface that is not a `backend_config` — a cursor, a page size — by saying
   * so. A package whose specs ALL say so has a declared config surface nobody drives, which is how
   * nats shipped two config validators no corpus had ever been near while its package read as
   * covered: its one spec graded `normalizeLimit`, a cursor helper.
   */
  it.each(declared.map((d) => [d.pkg] as const))('%s crosses it over its CONFIG surface', (pkg) => {
    const text = testSourcesOf(pkg);
    expect(
      count(text, 'expectLabelledRefusal(') - count(text, "declared: 'not backend_config'"),
      `${pkg}'s refusal specs all disclaim the backend_config surface it declares`,
    ).toBeGreaterThan(0);
  });
});
