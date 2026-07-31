import {
  asBackendMsgId,
  type BackendMsgId,
  type Cursor,
  type FetchRecentArgs,
  type FetchRecentResult,
  type Handle,
  type Topic,
} from '@sharptrick/parley-core';
import { CATCHUP_LEDGER_MAX, normalizeLimit } from './config.js';
import { mintCursor, parseCursor, rowToMessage } from './cursor.js';
import type { MessageRow } from './schema.js';
import { SqliteStore } from './store.js';

/** `post`, the catch-up read, and the hand-off point the live path resumes from. */
export abstract class SqliteCatchUp extends SqliteStore {
  protected readonly caughtUpThrough = new Map<Topic, bigint>();

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
    const limit = normalizeLimit(args.limit, args.topic);
    const storeId = this.require(this.storeId);
    const resumeAfter = args.since === undefined ? undefined : this.resumeAfter(args.since, args.topic);
    const rows =
      resumeAfter === undefined
        ? (this.require(this.selectRecentStmt).all(args.topic, limit) as MessageRow[]).reverse()
        : (this.require(this.selectAfterStmt).all(args.topic, resumeAfter, limit) as MessageRow[]);
    const servedThrough = rows.at(-1)?.id ?? resumeAfter ?? 0n;
    this.recordCatchUp(args.topic, BigInt(servedThrough));
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
   * Remember the rowid this topic's catch-up has accounted for — the row `nextCursor` names, which
   * is the caller's persisted read position. Only ever advances, so a caller that re-reads an
   * older page cannot pull a later {@link subscribe} back over messages catch-up already served.
   * Evicts least-recently-recorded first at {@link CATCHUP_LEDGER_MAX}.
   */
  private recordCatchUp(topic: Topic, rowid: bigint): void {
    const seen = this.caughtUpThrough.get(topic);
    if (seen !== undefined && rowid <= seen) return;
    this.caughtUpThrough.delete(topic);
    this.caughtUpThrough.set(topic, rowid);
    while (this.caughtUpThrough.size > CATCHUP_LEDGER_MAX) {
      const oldest = this.caughtUpThrough.keys().next().value;
      if (oldest === undefined) return;
      this.caughtUpThrough.delete(oldest);
    }
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
