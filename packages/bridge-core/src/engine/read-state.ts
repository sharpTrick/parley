import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { asCursor, type Cursor, type Topic } from '../message.js';

/**
 * Per-instance read-state: a `{ [topic]: cursor }` map persisted as an atomic JSON file
 * (write-tmp + rename).
 *
 * Read-state is PER-INSTANCE, never shared (DESIGN §10) — different sessions legitimately
 * hold different read positions per topic, so the file path is namespaced by instanceId.
 * CORE owns this (identical across every backend); the plugin owns only the message store.
 * It is a JSON file, NOT the message DB: core must not depend on a backend driver, and atomic
 * rename prevents corruption.
 *
 * Exclusivity is a CONVENTION, not an enforced lock: `instance_id` defaults to the handle, so two
 * sessions sharing a handle land on one file. Each flush therefore writes only the topics THIS
 * store has set since its last flush, over a re-read of disk, through a process-unique temp name —
 * so the worst case is a single topic's cursor losing a race, not a whole session's read position,
 * and never a half-written file.
 */
export class ReadStateStore {
  private readonly state: Record<string, string>;
  private readonly pending = new Set<string>();

  constructor(private readonly filePath: string) {
    if (filePath.length === 0) {
      throw new Error('read-state path must not be empty (config `state_path`)');
    }
    this.state = ReadStateStore.load(filePath);
  }

  /**
   * Keep an UNREADABLE file distinguishable from an absent one, so that a truncated or half-written
   * state file cannot silently cold-start every topic and then erase the evidence: the load
   * discards it, the next `set` writes over what it discarded, and the operator's only signal that
   * every topic went back to the backend's recent window — the loss this whole convention exists to
   * prevent — is messages that never arrive.
   */
  private static load(filePath: string): Record<string, string> {
    // Null-prototype backing map: `constructor`/`__proto__` topic names can neither leak a
    // prototype value out of get() nor turn set() into a silent no-op.
    const out: Record<string, string> = Object.create(null);
    let raw;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch {
      return out; // never written, or removed: the cold start this instance is entitled to
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return ReadStateStore.quarantine(filePath, out);
    }
    // Reject arrays (an `[]` file would otherwise swallow string-keyed writes on flush) and
    // keep only own, string-valued entries (a non-string cursor would wedge catch-up).
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return ReadStateStore.quarantine(filePath, out);
    }
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  }

  private static quarantine(filePath: string, out: Record<string, string>): Record<string, string> {
    const kept = `${filePath}.corrupt`;
    let moved = false;
    try {
      renameSync(filePath, kept);
      moved = true;
    } catch {
      // Read-only directory, or another process moved it first — the diagnostic is what matters.
    }
    console.error(
      `[parley] read-state at ${filePath} is not a readable JSON object; every topic in it ` +
        'resumes from the backend’s recent window instead of where this instance last read, ' +
        `and anything older is unreachable. ${moved ? `The unreadable file is kept at ${kept}` : 'It could not be moved aside and the next write will replace it'}.`,
    );
    return out;
  }

  /** Where this instance's read-state lives on disk (surfaced in diagnostics). */
  get path(): string {
    return this.filePath;
  }

  /** The persisted cursor for a topic, or undefined if this instance has never read it. */
  get(topic: Topic): Cursor | undefined {
    const value = this.state[topic];
    return value === undefined ? undefined : asCursor(value);
  }

  /**
   * How far on-start catch-up has warmed the dedup set, per topic. DISTINCT from the read position
   * above: that one is the AGENT's, and only `parley_fetch_recent` may advance it, out of a page it
   * actually handed the agent. This one records what the driver has already paged over, so a
   * restart warms from the live boundary instead of re-reading the whole unread backlog every boot.
   *
   * Kept in a sibling file rather than a reserved key in this one, so that a topic named like the
   * key cannot reach it: topic strings are unvalidated and arrive from config.
   */
  private warmStore: ReadStateStore | undefined;

  /** Where the warm marker lives (named in the resume hint when a marker is what failed). */
  get warmPath(): string {
    return `${this.filePath}.warmed`;
  }

  warmedThrough(topic: Topic): Cursor | undefined {
    return (this.warmStore ??= new ReadStateStore(this.warmPath)).get(topic);
  }

  /**
   * Record catch-up progress. Never throws: this file is a CACHE of ground the driver has already
   * paged over, and a boot runs it before the bridge answers `initialize` — so a marker this
   * process cannot write must cost a re-page on the next boot, not the whole deployment.
   */
  markWarmed(topic: Topic, cursor: Cursor): void {
    try {
      (this.warmStore ??= new ReadStateStore(this.warmPath)).set(topic, cursor);
    } catch (err) {
      console.error(
        `[parley] could not record catch-up progress for topic ${JSON.stringify(topic)} in ` +
          `${this.warmPath}: ${err instanceof Error ? err.message : String(err)}. That file only ` +
          'caches how far on-start catch-up has already paged — no read position and no message ' +
          'is in it, and deleting it is always safe. The bridge is continuing; the cost is that ' +
          'the next boot re-pages this topic from ' +
          `${this.filePath} instead. Make the directory writable by this process to stop re-paging.`,
      );
    }
  }

  /** Persist a new read position for a topic (atomic). */
  set(topic: Topic, cursor: Cursor): void {
    // Screen with the same predicate load() applies. A plugin that hands back no `nextCursor` (or a
    // numeric one) would otherwise DELETE this topic's stored position on the next flush, silently
    // cold-restarting catch-up on the following boot instead of failing on the page that caused it.
    if (typeof cursor !== 'string' || cursor.length === 0) {
      throw new TypeError(
        `read-state cursor for topic ${JSON.stringify(topic)} must be a non-empty string ` +
          `(got ${JSON.stringify(cursor) ?? typeof cursor}); the backend returned no usable nextCursor`,
      );
    }
    this.state[topic] = cursor;
    this.pending.add(topic);
    this.flush();
  }

  private flush(): void {
    // Keep the state dir 0700 and the file 0600, so a co-tenant on a shared host can't
    // read this instance's cursor positions. `mode` is masked by the umask (only ever *removing*
    // bits, so the result is ≤ these), and renameSync preserves the tmp file's mode into place.
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    // Write only the topics this store actually advanced. Spreading the whole in-memory map would
    // republish every position this instance ever held, rolling another session on the same path
    // back to where THIS one last read — a persistent regression, not a lost race, and one that
    // re-drains and re-emits already-delivered messages after a restart.
    const merged = ReadStateStore.load(this.filePath);
    for (const topic of this.pending) merged[topic] = this.state[topic]!;
    // Keep the temp name process-unique, so that a concurrent flush cannot interleave into it and
    // leave a half-written file that load() would silently discard as corrupt.
    const tmp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, this.filePath);
      this.pending.clear(); // keep a failed write's topics pending, so that the next flush retries them
    } catch (err) {
      // Keep the failed attempt's temp file from surviving: the name is deliberately
      // process-unique, so nothing would ever collide with it, overwrite it, or clean it up, and a
      // retried catch-up page would deposit another one on every attempt.
      try {
        unlinkSync(tmp);
      } catch {
        // Nothing was written, or it is already gone — the directory is as we found it.
      }
      throw err;
    }
  }
}

/**
 * Default read-state path: `${XDG_STATE_HOME:-~/.local/state}/parley/<instanceId>/read-state.json`.
 * Override via config `state_path`. instanceId defaults to the instance's handle; two
 * concurrent sessions sharing one handle MUST set distinct instance_ids (DESIGN §10).
 */
export function defaultReadStatePath(instanceId: string): string {
  const base = process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state');
  return join(base, 'parley', sanitize(instanceId), 'read-state.json');
}

function sanitize(instanceId: string): string {
  // Keep the path component filesystem-safe without colliding distinct ids.
  const cleaned = instanceId.replace(/[^A-Za-z0-9._-]/g, '_');
  const traversal = cleaned === '.' || cleaned === '..';
  // Already filesystem-safe and non-traversal → return verbatim (backward compatible).
  if (cleaned.length > 0 && cleaned === instanceId && !traversal) return cleaned;
  // Sanitization altered the id (or it reduced to '.'/'..'/'') → the mapping is no longer
  // injective, so disambiguate with a short hash of the RAW id, and never emit a traversal token.
  const base = cleaned.length === 0 || traversal ? 'default' : cleaned;
  const hash = createHash('sha256').update(instanceId).digest('hex').slice(0, 8);
  return `${base}-${hash}`;
}
