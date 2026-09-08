import { describe, expect, it } from 'vitest';
import { NEVER_RENDERABLE, RENDER_LEAK_SENTINEL } from '@sharptrick/parley-net-util';
import { CONFIG_KEYS, validateBackendConfig } from '../src/config.js';

/**
 * CLASS: a value is refused on SHAPE, but only after the refusal message has tried to render it.
 * A renderer that throws replaces this plugin's labelled load error with whatever the caller's own
 * value raised — a bare `TypeError` naming neither the key nor the plugin, or the caller's text
 * verbatim in the operator's log and in the model context core renders a seam error into.
 */
describe('xmpp refuses an unrenderable backend_config value under its own label', () => {
  for (const key of CONFIG_KEYS) {
    it.each(NEVER_RENDERABLE)(`${String(key)} = %s is a labelled refusal`, (_label, value) => {
      let raised: unknown;
      try {
        validateBackendConfig({ [key]: value });
      } catch (err) {
        raised = err;
      }
      const message = raised instanceof Error ? raised.message : String(raised);
      expect(message).toMatch(
        new RegExp(`^parley-xmpp: invalid backend_config\\.${String(key)} `),
      );
      expect(message).not.toContain(RENDER_LEAK_SENTINEL);
      expect(message).not.toMatch(/[\n\r]/);
    });
  }
});
