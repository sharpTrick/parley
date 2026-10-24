import {
  type PlaintextCredentialRisk,
  plaintextRemoteOrigin,
  sanitizeBody,
} from '@sharptrick/parley-net-util';

/**
 * Diagnostics go to stderr — stdout is the MCP JSON-RPC channel (see cli.ts). Keep every line the
 * plugin and its store emit going through here, so that one prefix names the source of all of them.
 */
export function note(message: string): void {
  process.stderr.write(`parley-telegram: ${message}\n`);
}

export function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Text this plugin did not author — a caller's topic or cursor, a `chat_map` spelling, a rejected
 * `backend_config` value — made safe to put in a log line or in an `Error` core renders into model
 * context. Every one of those arrives over a bare `z.string()` from an MCP client, so keep this on
 * each of them: unbounded and unflattened, a topic spelled with a newline and this plugin's own
 * `parley-telegram:` prefix writes a second diagnostic of its own choosing. Nothing is redacted
 * here — the caller wrote the text, so there is no secret of ours in it to lose.
 */
export const fromCaller = (text: string): string => sanitizeBody(text);

/**
 * Every failure CLASS this plugin throttles. Keep it a closed union, so that text a CALLER chose
 * cannot become a throttle key of its own: a class parameterized by caller input passes that input
 * as {@link Diagnostics.report}'s separate `instance`, which is where the bound below applies.
 */
type DiagnosticKind =
  | 'bookkeeping-line'
  | 'compaction'
  | 'high-water-mark'
  | 'ingest'
  | 'ingest-hold'
  | 'ingest-shape'
  | 'poll-failure'
  | 'store-refused'
  | 'store-unwritable'
  | 'unresolved-topic';

/** One line a minute per class, and per caller-named instance of a class. */
const THROTTLE_MS = 60_000;

/**
 * How many caller-named instances of a class hold a throttle of their own at once. The topic space
 * is caller-chosen — core's allowlist admits `post_topics` regex patterns — so without a bound this
 * map is state one unresolvable topic per request grows forever, and nothing releases. Past the
 * bound a further instance shares its CLASS's single throttle; keep it that way rather than
 * evicting a resident one, so that a caller recycling names cannot buy back the withheld lines.
 */
export const CALLER_KIND_MEMORY = 256;

/**
 * A throttled stderr surface. `kind` names a failure CLASS and holds it to one line a minute;
 * classes throttle independently, so a chattering poll failure cannot silence a store write that is
 * losing messages. `instance` names one caller-chosen occurrence WITHIN a class — bounded, and kept
 * apart from the class's own throttle so that a sweep of caller-named instances cannot spend the
 * protection a class the plugin itself spells is holding. `redact` is applied to every message, so
 * that a new diagnostic cannot put a credential into model context or the operator's logs.
 */
export class Diagnostics {
  /** Last report per class this plugin spells — a closed set, so it cannot outgrow the source. */
  private readonly ownKinds = new Map<DiagnosticKind, number>();
  /** Last report per caller-named instance, bounded by {@link CALLER_KIND_MEMORY}. */
  private readonly callerKinds = new Map<string, number>();

  constructor(private readonly redact: (text: string) => string = (text) => text) {}

  report(message: string, kind?: DiagnosticKind, instance?: string): void {
    if (kind !== undefined && !this.due(kind, instance)) return;
    note(this.redact(message));
  }

  /**
   * Release the caller-named throttles. A caller's topics belong to ONE connection, like the chat
   * memos they were named through, so keep this on the teardown path — this instance outlives
   * `disconnect()` and would otherwise hold a caller's names for the life of the process.
   */
  forgetCallerKinds(): void {
    this.callerKinds.clear();
  }

  private due(kind: DiagnosticKind, instance: string | undefined): boolean {
    if (instance === undefined) return this.fresh(this.ownKinds, kind);
    // Bound the KEY as well as the map: a topic arrives as a bare `z.string()`, so 256 of them at
    // their full length is the same unbounded growth, one entry at a time.
    const key = `${kind} ${fromCaller(instance)}`;
    if (this.callerKinds.has(key)) return this.fresh(this.callerKinds, key);
    if (this.callerKinds.size >= CALLER_KIND_MEMORY) this.dropElapsed();
    return this.callerKinds.size < CALLER_KIND_MEMORY
      ? this.fresh(this.callerKinds, key)
      : this.fresh(this.ownKinds, kind);
  }

  private fresh<K>(seen: Map<K, number>, key: K): boolean {
    const now = Date.now();
    if (now - (seen.get(key) ?? 0) < THROTTLE_MS) return false;
    seen.set(key, now);
    return true;
  }

  /** Reclaim instances whose window has passed: one already reports again, so it holds nothing. */
  private dropElapsed(): void {
    const cutoff = Date.now() - THROTTLE_MS;
    for (const [key, at] of this.callerKinds) {
      if (at <= cutoff) this.callerKinds.delete(key);
    }
  }
}

/** A config shape that widens this backend's trust boundary, as the fact rather than the sentence. */
export type ConfigRisk = PlaintextCredentialRisk<'api_url', 'token'>;

/**
 * The risks a `connect` to `apiUrl` warns about. Names the ORIGIN only, so that a secret smuggled
 * into userinfo or a path is not what the warning itself prints.
 */
export function configRisks(apiUrl: string): ConfigRisk[] {
  const origin = plaintextRemoteOrigin(apiUrl);
  return origin === undefined ? [] : [{ key: 'api_url', origin, exposes: ['token'] }];
}

/** The operator's stderr line for a risk. Rendered from the risk, so it cannot describe another. */
export const describeRisk = (risk: ConfigRisk): string =>
  `backend_config.${risk.key} ${risk.origin} is plaintext http:// to a non-loopback ` +
  `host. This API carries ${risk.exposes.map((k) => `backend_config.${k}`).join(' and ')} in ` +
  `the URL PATH, so every request line puts it on the network in the clear and into the logs of ` +
  `every proxy on the way. Use https://.`;
