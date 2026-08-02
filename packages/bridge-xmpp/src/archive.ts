import type { Topic } from '@sharptrick/parley-core';
import { randomUUID } from 'node:crypto';

import { XmppConnection } from './connection.js';
import * as wire from './stanzas.js';

export const MAM_TIMEOUT_MS = 15_000;
/** Default RSM page size for forward MAM paging (`backend_config.mam_page` overrides). */
export const MAM_PAGE = 200;
/** First archival-lag re-poll interval after a live-message wake; it doubles on each miss. */
const MAM_LAG_POLL_MS = 50;

export const MAM_MISSING_HINT =
  'this backend needs XEP-0313 MAM for MUC — enable mod_mam + muc_mam (Prosody) or mod_mam ' +
  '(ejabberd); without an archive there is no cursor, no catch-up and no live delivery';

/** One archive window: the rows the seam carries, and where in the archive the read actually got to. */
export interface ReadWindow {
  items: wire.BodiedItem[];
  /** Archive id of the last row the read SAW, admitted or not; `undefined` when it saw none. */
  tail?: string;
}
/** Why a long-poll waiter woke: only `message` implies the archive may still be lagging. */
export type WakeReason = 'message' | 'timeout' | 'cancel';

export class XmppArchive extends XmppConnection {
  protected mamPage = MAM_PAGE;

  /** MAM queryid -> collector for the streamed `<result>` items, bound to the room queried. */
  protected readonly mamCollectors = new Map<string, { room: string; items: wire.MamItem[] }>();
  /**
   * Long-poll wakeups: roomJid -> one-shot callbacks armed by a blocking `fetchRecent`. Independent
   * of `subscriptions` — a blocking fetch listens on the live MUC delivery the push path already
   * runs, it does not subscribe or join twice.
   */
  protected readonly waiters = new Map<string, Set<(reason: WakeReason) => void>>();

  /**
   * The window `args` asks for: the most recent `limit` messages when no cursor was given,
   * otherwise everything strictly after it. `blockMs` re-reads THIS, so that the argument changes
   * when a fetch returns and never which window it returns.
   */
  protected async readWindow(
    topic: Topic,
    since: string | undefined,
    limit: number,
  ): Promise<ReadWindow> {
    if (since === undefined) return this.lastPageMam(topic, limit);
    return this.exclusiveMam(topic, since, limit);
  }

  /**
   * The most recent `limit` messages the seam CARRIES, paged backwards from the archive tail with
   * RSM `<before>` (XEP-0059 §2.5) — an empty `<before/>` for the tail itself, then the id each
   * page starts at.
   *
   * `limit` counts seam messages, not archive rows. A MUC archives subject changes, corrections,
   * retractions and moderation tombstones, none of which carry a `<body>`, so one page of `limit`
   * rows yields fewer messages than asked for — or none at all, on a room whose recent history
   * happens to be made of them, which is also the window core builds its `parley_list_users` roster
   * from. Keep the fill-to-limit loop, so that what the tail of the archive is made of cannot decide
   * how much of the room a reader gets to see.
   *
   * Keep the FIRST page's last row as the window tail, so that a window admitting nothing still
   * reports the newest row it SAW; any older row rewinds the caller's cursor back over history it
   * has already read. Keep the strict-advance check for the reason {@link exclusiveMam} has one.
   */
  private async lastPageMam(topic: Topic, limit: number): Promise<ReadWindow> {
    const items: wire.BodiedItem[] = [];
    let before: string | undefined;
    let tail: string | undefined;
    while (items.length < limit) {
      const page = await this.mamQuery(topic, {
        lastPage: true,
        before,
        max: Math.min(this.mamPage, limit - items.length),
      });
      tail ??= page.items.at(-1)?.archId;
      items.unshift(...page.items.filter(wire.hasBody));
      const head = page.items[0]?.archId;
      if (page.complete || head === undefined) break;
      if (head === before) {
        throw new Error(
          `MAM paging on ${this.roomJid(topic)} did not advance: the page before '${before}' ` +
            'starts at that same archive id and is not marked complete, so the most recent window ' +
            'cannot be read',
        );
      }
      before = head;
    }
    return { items, tail };
  }

  /**
   * Forward, exclusive MAM catch-up strictly after `since`, paged up to `limit`. `since === ''` (the
   * empty archive's zero cursor) means "from the very beginning": the first page omits `<after/>`
   * (guarded in {@link wire.mamQueryIq}), later pages advance on real archive ids.
   *
   * Keep the page's UNFILTERED tail as the next `<after/>` and the loop's stop condition, so that a
   * page of items the seam does not carry advances past them; filtering first reads as "archive
   * exhausted" and withholds everything behind them forever.
   *
   * Keep the strict-advance check too: every other exit is the SERVER declaring progress, so a peer
   * that answers `<after>X</after>` with a page tailed by X again spins here forever, inside a seam
   * call nothing above times out.
   */
  private async exclusiveMam(topic: Topic, since: string, limit: number): Promise<ReadWindow> {
    const items: wire.BodiedItem[] = [];
    let cursor = since;
    let tail: string | undefined;
    while (items.length < limit) {
      const page = await this.mamQuery(topic, {
        after: cursor,
        max: Math.min(this.mamPage, limit - items.length),
      });
      items.push(...page.items.filter(wire.hasBody));
      const pageTail = page.items.at(-1)?.archId;
      if (pageTail !== undefined) tail = pageTail;
      if (page.complete || pageTail === undefined) break;
      if (pageTail === cursor) {
        throw new Error(
          `MAM paging on ${this.roomJid(topic)} did not advance: the page after '${cursor}' ends ` +
            'at that same archive id and is not marked complete, so catch-up cannot make progress',
        );
      }
      cursor = pageTail;
    }
    return { items, tail };
  }

  /**
   * Native long-poll: MUC-live-wait + MAM-reconcile. Each round REGISTERS the room waiter before
   * re-reading {@link readWindow}, so that a message reflected during the query's round trip fires
   * an already-registered waiter instead of firing into the void; its park timer only starts once
   * the query is back, so the park is the interval asked for rather than what a slow server left of
   * it. An empty return is safe: it carries the last window read, whose cursor never precedes `since`.
   *
   * Once a live message has been seen the archive is known to be behind the stream, so the re-poll
   * interval DOUBLES from {@link MAM_LAG_POLL_MS} instead of expiring back to the whole remaining
   * budget — which would withhold a message already in the archive until `blockMs` ran out.
   */
  protected async blockingMam(
    topic: Topic,
    since: string | undefined,
    limit: number,
    blockMs: number,
    firstRead: ReadWindow,
  ): Promise<ReadWindow> {
    const deadline = Date.now() + blockMs;
    const room = this.roomJid(topic);
    let latest = firstRead;
    let lagPoll = 0;
    for (;;) {
      if (this.stopped || Date.now() >= deadline) return latest;
      const waiter = this.armWaiter(room);
      try {
        latest = await this.readWindow(topic, since, limit);
        if (latest.items.length > 0 || this.stopped) return latest;
        const budget = deadline - Date.now();
        const park = lagPoll > 0 ? Math.min(budget, lagPoll) : budget;
        if (park <= 0) return latest;
        const reason = await waiter.park(park);
        if (reason === 'message') lagPoll = MAM_LAG_POLL_MS;
        else if (reason === 'timeout' && lagPoll > 0) lagPoll *= 2;
      } catch (err) {
        if (this.stopped) return latest;
        throw err;
      } finally {
        waiter.cancel();
      }
    }
  }

  /**
   * Register a one-shot long-poll waiter on `room`: it resolves on a live groupchat message for
   * that room ({@link fireWaiters}), on the `park(ms)` timer, or on `disconnect()`. `park` may be
   * called after the waiter has already fired, and then arms no timer; `cancel()` — also the fire
   * path — is idempotent and clears the timer and the registration.
   */
  protected armWaiter(room: string): {
    park: (ms: number) => Promise<WakeReason>;
    cancel: () => void;
  } {
    let resolveFired!: (reason: WakeReason) => void;
    const fired = new Promise<WakeReason>((r) => {
      resolveFired = r;
    });
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fire = (reason: WakeReason): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const set = this.waiters.get(room);
      set?.delete(fire);
      if (set?.size === 0) this.waiters.delete(room);
      resolveFired(reason);
    };
    const set = this.waiters.get(room) ?? new Set<(reason: WakeReason) => void>();
    this.waiters.set(room, set);
    set.add(fire);
    return {
      park: (ms) => {
        if (!settled) timer = setTimeout(() => fire('timeout'), ms);
        return fired;
      },
      cancel: () => fire('cancel'),
    };
  }

  /** Wake every long-poll fetch blocked on `room`; each fire self-clears (idempotent). */
  protected fireWaiters(room: string, reason: WakeReason): void {
    for (const fire of [...(this.waiters.get(room) ?? [])]) fire(reason);
  }

  /** Run one MAM page; the streamed `<result>` items are gathered by `queryid`. */
  protected async mamQuery(
    topic: Topic,
    opts: { after?: string; before?: string; lastPage?: boolean; max: number },
  ): Promise<{ items: wire.MamItem[]; complete: boolean }> {
    const room = this.roomJid(topic);
    const queryid = randomUUID();
    const collector: wire.MamItem[] = [];
    this.mamCollectors.set(queryid, { room, items: collector });
    try {
      const fin = await this.require().iqCaller.request(
        wire.mamQueryIq(room, queryid, opts),
        MAM_TIMEOUT_MS,
      );
      const complete = fin.getChild('fin', wire.NS_MAM)?.attrs.complete === 'true';
      return { items: collector.slice(), complete };
    } catch (err) {
      const condition = wire.conditionOf(err);
      if (condition === 'service-unavailable' || condition === 'feature-not-implemented') {
        throw new Error(`MAM query on ${room} answered ${condition} — ${MAM_MISSING_HINT}`);
      }
      throw err;
    } finally {
      this.mamCollectors.delete(queryid);
    }
  }
}
