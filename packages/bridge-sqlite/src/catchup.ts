import {
  asBackendMsgId,
  assertBlockMsUnsupported,
  type BackendMsgId,
  type Cursor,
  type FetchRecentArgs,
  type FetchRecentResult,
  type Handle,
  type Message,
  type Topic,
} from '@sharptrick/parley-core';
import { errMessage } from './classify.js';
import { normalizeLimit } from './config.js';
import { mintCursor, parseCursor, rowToMessage } from './cursor.js';
import type { MessageRow } from './schema.js';
import { SqliteStore } from './store.js';

/**
 * A row a peer wrote outside `post()` can carry a value this converter refuses — TEXT affinity
 * does not convert a BLOB. It costs that row, as on the live path, and not the page around it.
 */
function convertible(
  rows: readonly MessageRow[],
  storeId: string,
  skipped: Array<{ id: number; err: unknown }>,
): Message[] {
  return rows.flatMap((row) => {
    try {
      return [rowToMessage(row, storeId)];
    } catch (err) {
      skipped.push({ id: row.id, err });
      return [];
    }
  });
}

/** `post` and the catch-up read. */
export abstract class SqliteCatchUp extends SqliteStore {
  async post(
    topic: Topic,
    identity: Handle,
    content: string,
    opts?: { inReplyTo?: BackendMsgId },
  ): Promise<BackendMsgId> {
    const stmt = this.require(this.insertStmt);
    const ts = new Date().toISOString();
    const info = stmt.run(topic, identity, content, ts, opts?.inReplyTo ?? null);
    return asBackendMsgId(String(info.lastInsertRowid));
  }

  async fetchRecent(args: FetchRecentArgs): Promise<FetchRecentResult> {
    assertBlockMsUnsupported('parley-sqlite', args.blockMs);
    const limit = normalizeLimit(args.limit, args.topic);
    const storeId = this.require(this.storeId);
    const resumeAfter = args.since === undefined ? undefined : this.resumeAfter(args.since, args.topic);
    const after = (id: number | bigint): MessageRow[] =>
      this.require(this.selectAfterStmt).all(args.topic, id, limit) as MessageRow[];
    let rows =
      resumeAfter === undefined
        ? (this.require(this.selectRecentStmt).all(args.topic, limit) as MessageRow[]).reverse()
        : after(resumeAfter);
    let servedThrough = rows.at(-1)?.id ?? resumeAfter ?? 0n;
    const skipped: Array<{ id: number; err: unknown }> = [];
    let messages = convertible(rows, storeId, skipped);
    // Keep reading past a full page that converted to nothing, so that an empty page still means
    // the topic is exhausted: that is how every caller reads one, and the rows above it would
    // otherwise be stranded behind a page a peer filled with records this converter refuses.
    while (messages.length === 0 && rows.length === limit) {
      rows = after(servedThrough);
      servedThrough = rows.at(-1)?.id ?? servedThrough;
      messages = convertible(rows, storeId, skipped);
    }
    const first = skipped[0];
    if (first !== undefined) {
      process.stderr.write(
        `parley-sqlite: skipped ${skipped.length} unconvertible row(s) on topic "${args.topic}" ` +
          `(first: id ${first.id}): ${errMessage(first.err)}\n`,
      );
    }
    return { messages, nextCursor: mintCursor(storeId, servedThrough) };
  }

  protected maxId(topic: Topic): number {
    const row = this.require(this.maxIdStmt).get(topic) as { maxId: number } | undefined;
    return row?.maxId ?? 0;
  }

  /**
   * The rowid a `since` cursor resumes strictly after. A cursor carrying a different store id —
   * a recreated file, a `:memory:` process, another backend's numeric cursor reaching this plugin
   * through mis-namespaced read-state — resumes from 0 and replays the topic, because its rowids
   * name nothing in this store and `id > <foreign>` would silently drop everything below it. So
   * does a cursor of this store that sits above the `AUTOINCREMENT` high-water mark, which is what
   * a restore from an older backup produces.
   */
  private resumeAfter(since: Cursor, topic: Topic): bigint {
    const parsed = parseCursor(since);
    if (parsed === undefined) {
      throw new Error(
        `parley-sqlite: malformed cursor '${since}' for topic ${topic} — ` +
          `expected '<storeId>.<rowid>' minted by this backend`,
      );
    }
    if (parsed.storeId !== this.require(this.storeId)) return 0n;
    return parsed.rowid > this.highWater() ? 0n : parsed.rowid;
  }

  private highWater(): bigint {
    const row = this.require(this.seqStmt).get() as { seq: number | bigint } | undefined;
    return row === undefined ? 0n : BigInt(row.seq);
  }
}
