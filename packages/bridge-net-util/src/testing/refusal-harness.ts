import { describe, expect, it } from 'vitest';
import {
  FORBIDDEN_IN_RENDER,
  NEVER_RENDERABLE,
  PLANTED_SECRET,
  RENDER_LEAK_SENTINEL,
  SECRET_AS_TEXT,
  UNSAFE_TEXT,
  WRAPPING_A_SECRET,
} from './hostile-config-values.js';
import { RENDERED_BY_VALUE } from '../config-value.js';
import { MAX_ERROR_BODY } from '../redact.js';

/** What a backend hands the harness so it can drive that backend's own validator. */
export interface RefusalSpec {
  /** How this plugin labels a refusal of `key`. */
  label: (key: string) => RegExp;
  /** Every key the validator grades. */
  keys: readonly string[];
  /**
   * Keys whose value is a MAP of caller-chosen entries. The hostile value is nested one level in,
   * which is where the map's own per-entry refusal renders it — the container check never sees it.
   */
  mapKeys?: readonly string[];
  /**
   * Every key this plugin's `backend_config` declares, taken from the plugin's own
   * `satisfies Record<keyof Required<…>>` list, so the surface graded cannot drift from the surface
   * shipped. `'not backend_config'` for a spec grading another untrusted-value surface — a cursor,
   * a page size — which has no such list.
   */
  declared: readonly string[] | 'not backend_config';
  /** Declared keys this validator deliberately does not grade, each with the reason it does not. */
  ungraded?: Readonly<Record<string, string>>;
  /**
   * Corpus rows a key legitimately ACCEPTS, by row label, because the row's shape or text IS a
   * value that key takes — matrix's `invite` is an array of MXID strings, and a NATS subject prefix
   * may hold a bidi override. Each named row is asserted to be ACCEPTED, so an exemption that stops
   * being true reddens instead of quietly excusing a refusal that went missing.
   */
  accepts?: Readonly<Record<string, readonly string[]>>;
  /**
   * Keys whose value is, or can carry, a credential — each with a value carrying
   * {@link PLANTED_SECRET} that THIS backend refuses. A key the backend accepts every string for
   * has no refusal to grade, and naming one bought nothing until the harness began requiring the
   * refusal to have happened.
   */
  credentialKeys?: Readonly<Record<string, unknown>>;
  /** Keys a hostile STRING is refused under: the only path caller-authored text takes into a refusal. */
  textKeys?: readonly string[];
  /** Hand the validator one key/value pair. It is expected to throw. */
  validate: (key: string, value: unknown) => void;
}

/**
 * What a validator did with one value. A UNION rather than a message and a flag, so that no block
 * can read `.message` without first narrowing on `threw`: `expect('').not.toContain(secret)` holds
 * for every secret there is, and that is what the credential block asserted for the two backends
 * whose validator ACCEPTS a bare credential string under the key it was handed.
 */
export type Refusal = { threw: true; message: string } | { threw: false };

export const refusalOf = (spec: RefusalSpec, key: string, value: unknown): Refusal => {
  try {
    spec.validate(key, value);
  } catch (err) {
    return { threw: true, message: err instanceof Error ? err.message : String(err) };
  }
  return { threw: false };
};

/**
 * The message a backend refused `key = value` with. Every assertion below reads one through HERE,
 * so that no block can grade a validator that never threw: `expect('').not.toContain(secret)` holds
 * for every secret there is, and that is what the credential block asserted for the two backends
 * whose validator accepts a bare credential string under the key it was handed.
 */
export function expectRefusalMessage(spec: RefusalSpec, key: string, value: unknown): string {
  const refusal = refusalOf(spec, key, value);
  expect(
    refusal.threw,
    `${key} was ACCEPTED — there is no refusal here, so this row grades nothing`,
  ).toBe(true);
  const message = refusal.threw ? refusal.message : '';
  expect(message, `${key} was refused with an empty message, which grades nothing`).not.toBe('');
  return message;
}

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
  const graded = [...spec.keys, ...(spec.mapKeys ?? [])];
  const declared = spec.declared;
  const wrap = (key: string, value: unknown): unknown =>
    (spec.mapKeys ?? []).includes(key) ? { 'a-topic': value } : value;

  describe(`${plugin} grades the backend_config surface it declares`, () => {
    it('grades only keys its backend_config declares', () => {
      const stray = declared === 'not backend_config' ? [] : graded.filter((k) => !declared.includes(k));
      expect(stray, 'this spec drives keys the plugin does not declare').toEqual([]);
    });

    it('leaves no declared key ungraded without a stated reason', () => {
      const skipped =
        declared === 'not backend_config'
          ? []
          : declared.filter((k) => !graded.includes(k) && spec.ungraded?.[k] === undefined);
      expect(
        skipped,
        'a declared key no corpus is crossed over is a config surface nothing has ever driven',
      ).toEqual([]);
    });

    /**
     * A refusal an operator reads out of a merged log, or a model reads out of a seam error, has to
     * say WHICH plugin refused. This block is titled for that property and its regex was the only
     * thing asserting it — so a spec whose pattern names no plugin (nats's `^invalid <key> ` was
     * exactly that) turned the whole block into a check of the message's first word.
     */
    it('labels every refusal with the plugin it came from', () => {
      const unlabelled = graded.filter((key) => !new RegExp(plugin, 'i').test(spec.label(key).source));
      expect(
        unlabelled,
        `this label pattern would match a message that names no plugin at all, so "${plugin} ` +
          'refuses ... under its own label" grades something else',
      ).toEqual([]);
    });

    it('states no reason for a key it does grade, or does not declare', () => {
      const stale = Object.keys(spec.ungraded ?? {}).filter(
        (k) => graded.includes(k) || (declared !== 'not backend_config' && !declared.includes(k)),
      );
      expect(stale, 'this exemption names a key it does not exempt').toEqual([]);
    });
  });

  const accepted = (key: string, label: string): boolean =>
    (spec.accepts?.[key] ?? []).includes(label);

  describe(`${plugin} refuses an unrenderable backend_config value under its own label`, () => {
    it('names only corpus rows that exist among the values it excuses', () => {
      const labels = new Set(
        [...NEVER_RENDERABLE, ...WRAPPING_A_SECRET, ...UNSAFE_TEXT].map(([label]) => label),
      );
      const unknown = Object.values(spec.accepts ?? {})
        .flat()
        .filter((label) => !labels.has(label));
      expect(unknown, 'this exemption names a corpus row that is no longer there').toEqual([]);
    });

    for (const key of graded) {
      it.each(NEVER_RENDERABLE)(`${key} = %s is a labelled refusal`, (label, value) => {
        if (accepted(key, label)) {
          expect(() => spec.validate(key, wrap(key, value))).not.toThrow();
          return;
        }
        const message = expectRefusalMessage(spec, key, wrap(key, value));
        expect(message).toMatch(spec.label(key));
        expect(message).not.toContain(RENDER_LEAK_SENTINEL);
        expect(message).not.toMatch(/[\n\r]/);
      });
    }
  });

  describe(`${plugin} discloses nothing a rejected value carries`, () => {
    for (const key of graded) {
      it.each(WRAPPING_A_SECRET)(`${key} = %s is refused without it`, (label, value) => {
        if (accepted(key, label)) {
          expect(() => spec.validate(key, wrap(key, value))).not.toThrow();
          return;
        }
        const message = expectRefusalMessage(spec, key, wrap(key, value));
        expect(message).toMatch(spec.label(key));
        expect(message).not.toContain(PLANTED_SECRET);
        expect(message).not.toMatch(/[\n\r]/);
      });
    }

    for (const key of graded) {
      it(`${key} = ${SECRET_AS_TEXT[0]} is echoed only where the policy says it may`, () => {
        const refusal = refusalOf(spec, key, wrap(key, SECRET_AS_TEXT[1]));
        const echoed = refusal.threw && refusal.message.includes(PLANTED_SECRET);
        expect(
          echoed && !Object.hasOwn(RENDERED_BY_VALUE, key),
          `${key} refuses a plain string by printing it, and no entry in RENDERED_BY_VALUE says ` +
            `why printing this key's value is safe`,
        ).toBe(false);
      });
    }

    for (const [key, value] of Object.entries(spec.credentialKeys ?? {})) {
      it(`${key} = a value whose own text IS the secret is refused without it`, () => {
        expect(
          String(value),
          'this value does not carry the secret, so the assertion below grades nothing',
        ).toContain(PLANTED_SECRET);
        const message = expectRefusalMessage(spec, key, value);
        expect(message).toMatch(spec.label(key));
        expect(message).not.toContain(PLANTED_SECRET);
      });
    }
  });

  if ((spec.textKeys ?? []).length > 0) {
    describe(`${plugin} bounds and flattens the text a rejected value carries`, () => {
      for (const key of spec.textKeys ?? []) {
        it.each(UNSAFE_TEXT)(`${key} = %s is one bounded, harmless line`, (label, text) => {
          if (accepted(key, label)) {
            expect(() => spec.validate(key, wrap(key, text))).not.toThrow();
            return;
          }
          const message = expectRefusalMessage(spec, key, wrap(key, text));
          expect(message).not.toMatch(FORBIDDEN_IN_RENDER);
          expect(message).not.toMatch(/[\n\r]/);
          expect(message.length).toBeLessThan(MAX_ERROR_BODY + 1024);
        });
      }
    });
  }
}
