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
    try {
      const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
      if (parsed !== null && typeof parsed === 'object') {
        return parsed as Record<string, string>;
      }
    } catch {
      // Missing or corrupt file → start from an empty read position.
    }
    return {};
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
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
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
  return cleaned.length > 0 ? cleaned : 'default';
}
