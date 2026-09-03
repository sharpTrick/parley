import type { Topic } from '@sharptrick/parley-core';
import { randomUUID } from 'node:crypto';

import { XmppConnection } from './connection.js';
import * as wire from './stanzas.js';

export const MAM_TIMEOUT_MS = 15_000;
/** Default RSM page size for forward MAM paging (`backend_config.mam_page` overrides). */
export const MAM_PAGE = 200;

export const MAM_MISSING_HINT =
  'this backend needs XEP-0313 MAM for MUC — enable mod_mam + muc_mam (Prosody) or mod_mam ' +
  '(ejabberd); without an archive there is no cursor, no catch-up and no live delivery';

/** One archive window: the rows the seam carries, and where in the archive the read actually got to. */
export interface ReadWindow {
  items: wire.BodiedItem[];
  /** Archive id of the last row the read SAW, admitted or not; `undefined` when it saw none. */
  tail?: string;
}
export class XmppArchive extends XmppConnection {
  protected mamPage = MAM_PAGE;

  /** MAM queryid -> collector for the streamed `<result>` items, bound to the room queried. */
  protected readonly mamCollectors = new Map<string, { room: string; items: wire.MamItem[] }>();
  /**
   * The window `args` asks for: the most recent `limit` messages when no cursor was given,
   * otherwise everything strictly after it.
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
   * happens to be made of them. Keep the fill-to-limit loop, so that what the tail of the archive is
   * made of cannot decide how much of the room a reader gets to see.
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
