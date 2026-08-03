import { runConformanceSuite } from '@sharptrick/parley-conformance';
import { describe, it } from 'vitest';
import { BROKEN_VARIANTS, brokenSuiteName } from './reference-plugin.js';

// These suites are MEANT to fail — they are the negative control's subject, not part of the ordinary
// run. Keep them behind the env var, so that a bare `vitest run` never collects a red suite.
if (process.env.PARLEY_CONFORMANCE_BROKEN === '1') {
  for (const variant of BROKEN_VARIANTS) {
    runConformanceSuite(brokenSuiteName(variant.name), variant.make);
  }
} else {
  describe('broken conformance variants', () => {
    it('registered only by negative-control.test.ts, which runs this file itself', () => undefined);
  });
}
