/**
 * The names a plugin's `backend_config` declares: every top-level key, plus the members of any
 * declared key whose value is itself an object. Core is handed the NAMES and never their meanings,
 * so this stays a seam-shaped helper rather than knowledge of any backend (DESIGN §11).
 *
 * Keep both halves derived from the plugin's own config interface — the `satisfies
 * Record<keyof Required<XBackendConfig>, 0>` form every backend uses — so that a key added to the
 * interface and not to the list is a compile error rather than a key `connect()` rejects.
 */
export interface BackendConfigKeys {
  readonly keys: readonly string[];
  readonly nested?: Readonly<Record<string, readonly string[]>>;
}

/**
 * True for an object literal — the only shape `backend_config` and its nested groups may take, and
 * the two prototypes a YAML/JSON parse produces. Every consumer uses this as the
 * enumerate-this-container gate, so anything it admits that `Object.entries` reads as EMPTY is a
 * config accepted with zero mappings by a loader whose whole job is to refuse one: a `Date`, a
 * `Buffer`, a boxed primitive and a class instance all enumerate to nothing while passing a bare
 * `typeof value === 'object'`.
 */
export const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/** What a value IS, for a diagnostic that must never carry what a value HOLDS. */
const typeName = (value: unknown): string =>
  Array.isArray(value)
    ? 'an array'
    : value === null
      ? 'null'
      : typeof value === 'object'
        ? 'an object'
        : `a ${typeof value}`;

/** A key name is caller-authored, and this message is core's to render. Longest name worth naming. */
const MAX_KEY_IN_REFUSAL = 128;

/**
 * The offending key as ONE bounded line. The name comes from the caller's YAML, and this refusal
 * reaches an operator's log and the model context core renders a seam error into — so it may not
 * forge line structure, carry a bidi override, or run unbounded. Kept core-local: the seam may not
 * depend on a backend-support package, and net-util's `sanitizeBody` lives in one.
 */
const boundedKey = (path: string): string => {
  const flat = path.replaceAll(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, '\uFFFD');
  return flat.length <= MAX_KEY_IN_REFUSAL ? flat : `${flat.slice(0, MAX_KEY_IN_REFUSAL)}[truncated]`;
};

function refuse(plugin: string, path: string, allowed: readonly string[], prefix: string): never {
  throw new Error(
    `parley-${plugin}: unknown backend_config key '${boundedKey(path)}' — expected one of ` +
      allowed.map((known) => `${prefix}${known}`).join(', '),
  );
}

/**
 * Refuse a `backend_config` key the plugin does not declare, before any value is read and before
 * anything is dialled. Every backend key is either a credential or an addressing decision: a
 * misspelled token connects anonymously, a misspelled channel/topic map addresses somewhere the
 * operator did not choose, and a misspelled narrowing knob leaves the built-in default in place
 * while the operator believes they replaced it. Keep this the FIRST thing `connect()` does, so that
 * a mistyped key is a load error rather than a running bridge doing the opposite of what was asked.
 *
 * The rejection names the offending key and lists the accepted set, so that the message is
 * actionable without the README — and lists them under the same prefix the offender was found at,
 * so that a nested miss reads as `tls.ca_flie`, not `ca_flie`.
 */
export function assertKnownConfigKeys(
  plugin: string,
  config: object,
  declared: BackendConfigKeys,
): void {
  const cfg = config as Record<string, unknown>;
  for (const key of Object.keys(cfg)) {
    if (!declared.keys.includes(key)) refuse(plugin, key, declared.keys, '');
  }
  for (const [key, members] of Object.entries(declared.nested ?? {})) {
    const value = cfg[key];
    if (value === undefined) continue;
    if (!isPlainObject(value)) {
      throw new Error(
        `parley-${plugin}: invalid backend_config.${key} — expected an object holding ` +
          `${members.map((member) => `${key}.${member}`).join(', ')}, not ${typeName(value)}`,
      );
    }
    for (const member of Object.keys(value)) {
      if (!members.includes(member)) refuse(plugin, `${key}.${member}`, members, `${key}.`);
    }
  }
}
