import { describe, expect, it } from 'vitest';
import {
  NEVER_RENDERABLE,
  RENDER_LEAK_SENTINEL,
} from '../../bridge-net-util/test/never-renderable.js';
import { requireNumericKnobs, type TelegramBackendConfig } from '../src/config.js';

/**
 * CLASS: a value is refused on SHAPE, but only after the refusal message has tried to render it.
 * A renderer that throws replaces this plugin's labelled load error with whatever the caller's own
 * value raised — a bare `TypeError` naming neither the key nor the plugin, or the caller's text
 * verbatim in the operator's log and in the model context core renders a seam error into.
 */
const KNOBS = [
  'poll_timeout_s',
  'observed_retention_per_chat',
  'observed_retention_per_topic',
  'observed_max_chats',
] as const;

describe('telegram refuses an unrenderable numeric knob under its own label', () => {
  for (const key of KNOBS) {
    it.each(NEVER_RENDERABLE)(`${key} = %s is a labelled refusal`, (_label, value) => {
      let raised: unknown;
      try {
        requireNumericKnobs({ [key]: value } as unknown as TelegramBackendConfig);
      } catch (err) {
        raised = err;
      }
      const message = raised instanceof Error ? raised.message : String(raised);
      expect(message).toMatch(new RegExp(`^TelegramPlugin: backend_config\\.${key} `));
      expect(message).not.toContain(RENDER_LEAK_SENTINEL);
      expect(message).not.toMatch(/[\n\r]/);
    });
  }
});
