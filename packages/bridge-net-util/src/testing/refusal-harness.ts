import { describe, expect, it } from 'vitest';
import {
  FORBIDDEN_IN_RENDER,
  NEVER_RENDERABLE,
  PLANTED_SECRET,
  RENDER_LEAK_SENTINEL,
  UNSAFE_TEXT,
  WRAPPING_A_SECRET,
} from './hostile-config-values.js';
import { MAX_ERROR_BODY } from '../redact.js';

/** What a backend hands the harness so it can drive that backend's own validator. */
export interface RefusalSpec {
  /** How this plugin labels a refusal of `key`. */
  label: (key: string) => RegExp;
  /** Every key the validator grades. */
  keys: readonly string[];
  /** Keys whose value is, or can carry, a credential — never rendered by value, whatever its type. */
  credentialKeys?: readonly string[];
  /** Keys a hostile STRING is refused under: the only path caller-authored text takes into a refusal. */
  textKeys?: readonly string[];
  /** Hand the validator one key/value pair. It is expected to throw. */
  validate: (key: string, value: unknown) => void;
}

const raisedBy = (spec: RefusalSpec, key: string, value: unknown): string => {
  try {
    spec.validate(key, value);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return '';
};

/**
 * CLASS: a `backend_config` value is refused on SHAPE, but only after the refusal has tried to
 * render it. Three ways that goes wrong, and all three end in the same place — the operator's log
 * and the model context core renders a thrown seam error into:
 *
 *  - rendering THROWS, so the plugin's labelled load error becomes a bare multi-line `TypeError`
 *    naming neither the key nor the plugin, or the caller's own text verbatim;
 *  - rendering ENUMERATES a container, so a credential nested anywhere inside it is printed;
 *  - rendering passes the caller's TEXT through, so it can forge line structure or run unbounded.
 *
 * One harness rather than one file per backend: the renderer is shared, so a guard written against
 * one plugin's validator covers none of the others, and five of them re-implemented this rendering
 * until it was lifted. A backend states its own label, keys and entry point; everything asserted
 * about them is the same everywhere.
 */
export function expectLabelledRefusal(plugin: string, spec: RefusalSpec): void {
  describe(`${plugin} refuses an unrenderable backend_config value under its own label`, () => {
    for (const key of spec.keys) {
      it.each(NEVER_RENDERABLE)(`${key} = %s is a labelled refusal`, (_label, value) => {
        const message = raisedBy(spec, key, value);
        expect(message).toMatch(spec.label(key));
        expect(message).not.toContain(RENDER_LEAK_SENTINEL);
        expect(message).not.toMatch(/[\n\r]/);
      });
    }
  });

  describe(`${plugin} discloses nothing a rejected value carries`, () => {
    for (const key of spec.keys) {
      it.each(WRAPPING_A_SECRET)(`${key} = %s is refused without it`, (_label, value) => {
        const message = raisedBy(spec, key, value);
        expect(message, 'a wrapped value must still be refused, or this row grades nothing').not.toBe(
          '',
        );
        expect(message).toMatch(spec.label(key));
        expect(message).not.toContain(PLANTED_SECRET);
        expect(message).not.toMatch(/[\n\r]/);
      });
    }

    for (const key of spec.credentialKeys ?? []) {
      it(`${key} = a bare secret string is never echoed back when it is refused`, () => {
        expect(raisedBy(spec, key, `scheme://parley:${PLANTED_SECRET}@host/x y`)).not.toContain(
          PLANTED_SECRET,
        );
      });
    }
  });

  if ((spec.textKeys ?? []).length > 0) {
    describe(`${plugin} bounds and flattens the text a rejected value carries`, () => {
      for (const key of spec.textKeys ?? []) {
        it.each(UNSAFE_TEXT)(`${key} = %s is one bounded, harmless line`, (_label, text) => {
          const message = raisedBy(spec, key, text);
          expect(message, 'a text value must still be refused, or this row grades nothing').not.toBe(
            '',
          );
          expect(message).not.toMatch(FORBIDDEN_IN_RENDER);
          expect(message).not.toMatch(/[\n\r]/);
          expect(message.length).toBeLessThan(MAX_ERROR_BODY + 1024);
        });
      }
    });
  }
}
