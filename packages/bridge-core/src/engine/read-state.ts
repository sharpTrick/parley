import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
 * It is a JSON file, NOT the message DB: a single instance writes its own file (no
 * contention), core must not depend on a backend driver, and atomic rename prevents
 * corruption.
 */
export class ReadStateStore {
  private readonly state: Record<string, string>;

  constructor(private readonly filePath: string) {
    this.state = ReadStateStore.load(filePath);
  }

  private static load(filePath: string): Record<string, string> {
    // Null-prototype backing map: `constructor`/`__proto__` topic names can neither leak a
    // prototype value out of get() nor turn set() into a silent no-op.
    const out: Record<string, string> = Object.create(null);
    try {
      const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
      // Reject arrays (an `[]` file would otherwise swallow string-keyed writes on flush) and
      // keep only own, string-valued entries (a non-string cursor would wedge catch-up).
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === 'string') out[k] = v;
        }
      }
    } catch {
      // Missing or corrupt file → start from an empty read position.
    }
    return out;
  }

  /** The persisted cursor for a topic, or undefined if this instance has never read it. */
  get(topic: Topic): Cursor | undefined {
    const value = this.state[topic];
    return value === undefined ? undefined : asCursor(value);
  }

  /** Persist a new read position for a topic (atomic). */
  set(topic: Topic, cursor: Cursor): void {
    this.state[topic] = cursor;
    this.flush();
  }

  private flush(): void {
    // SEC-16: create the state dir 0700 and the file 0600 so a co-tenant on a shared host can't
    // read this instance's cursor positions. `mode` is masked by the umask (only ever *removing*
    // bits, so the result is ≤ these), and renameSync preserves the tmp file's mode into place.
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.filePath);
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
