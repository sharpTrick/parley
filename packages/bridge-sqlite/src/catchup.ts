import {
  asBackendMsgId,
  assertBlockMsUnsupported,
  type BackendMsgId,
  type Cursor,
  type FetchRecentArgs,
  type FetchRecentResult,
  type Handle,
  type Topic,
} from '@sharptrick/parley-core';
import { normalizeLimit } from './config.js';
import { mintCursor, parseCursor, rowToMessage } from './cursor.js';
import type { MessageRow } from './schema.js';
import { SqliteStore } from './store.js';

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
    const rows =
      resumeAfter === undefined
        ? (this.require(this.selectRecentStmt).all(args.topic, limit) as MessageRow[]).reverse()
        : (this.require(this.selectAfterStmt).all(args.topic, resumeAfter, limit) as MessageRow[]);
    const servedThrough = rows.at(-1)?.id ?? resumeAfter ?? 0n;
    return {
      messages: rows.map((row) => rowToMessage(row, storeId)),
      nextCursor: mintCursor(storeId, servedThrough),
    };
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
