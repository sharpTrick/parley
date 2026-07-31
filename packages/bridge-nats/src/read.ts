import type { Cursor, FetchRecentArgs, FetchRecentResult, Message } from '@sharptrick/parley-core';
import type { StreamInfo } from 'nats';
import { absentTopicPage, normalizeLimit, parseCursor, type ParsedCursor } from './cursor.js';
import { delay, isStreamMissing } from './jetstream.js';
import { NatsPulls } from './pull.js';

const WIDEN_FACTOR = 4;
const ABSENT_STREAM_POLL_MS = 250;

export abstract class NatsReads extends NatsPulls {
  // Keep this `async`, so that a rejected `since` REJECTS: a synchronous throw out of a
  // Promise-returning seam method escapes every caller that only wrote `.catch()`.
  async fetchRecent(args: FetchRecentArgs): Promise<FetchRecentResult> {
    const limit = normalizeLimit(args.limit, args.topic);
    const since = parseCursor(args.since);
    // Keep the deadline out here: the wait for an absent stream and the read itself are two stages
    // of ONE budget, and a deadline minted inside either hands the other a fresh one.
    const deadline = Date.now() + (args.blockMs ?? 0);
    const info = await this.streamForRead(args, deadline);
    if (info === undefined) return absentTopicPage(args);
    try {
      return await this.readRecent(args, since, deadline, info, limit);
    } catch (err) {
      // A stream that vanished mid-read is the absent topic again, and a read must not put it back:
      // re-provisioning here is what let a caller-named topic spend the cluster's stream budget.
      if (!isStreamMissing(err)) throw err;
      return absentTopicPage(args);
    }
  }

  /**
   * The topic's stream if the server already has one, else `undefined` — a read NEVER creates one.
   * Keep every read path here rather than on {@link NatsStreams.ensureStream}, so that a topic
   * named by an untrusted inbound message cannot spend the cluster's stream and storage budget with
   * calls that write nothing. `post` and `subscribe` still provision: both are gated by the topic
   * allowlist. A blocking read polls instead of creating, so a long-poll issued before the peer's
   * first `post` still waits for the stream that post will make.
   */
  private async streamForRead(
    args: FetchRecentArgs,
    deadline: number,
  ): Promise<StreamInfo | undefined> {
    const blocking = (args.blockMs ?? 0) > 0;
    for (;;) {
      const info = await this.existingStream(args.topic);
      if (info !== undefined) return info;
      const remaining = deadline - Date.now();
      if (!blocking || remaining <= 0 || this.stopped) return undefined;
      await delay(Math.min(remaining, ABSENT_STREAM_POLL_MS));
    }
  }

  private async readRecent(
    args: FetchRecentArgs,
    since: ParsedCursor | undefined,
    deadline: number,
    info: StreamInfo,
    limit: number,
  ): Promise<FetchRecentResult> {
    const stream = this.streamName(args.topic);
    const lastSeq = info.state.last_seq;
    const firstSeq = info.state.first_seq;
    // A cursor minted by a DIFFERENT incarnation names a sequence of a stream that no longer
    // exists: re-provisioning restarts the sequences at 1, so that number says nothing about where
    // the new stream's history begins. Keep the fall back to the retained window, so that catch-up
    // neither goes deaf waiting on a sequence that will not come nor silently skips everything the
    // new incarnation holds below it. A legacy bare cursor names no incarnation, so it can only be
    // judged by the tail it sits above.
    const restarted =
      since !== undefined &&
      (since.incarnation === undefined
        ? since.seq > lastSeq
        : since.incarnation !== this.incarnation(stream));
    const emptyCursor =
      since === undefined || restarted ? this.cursorAt(stream, lastSeq) : (args.since as Cursor);
    const blockMs = args.blockMs ?? 0;
    const waitOrNothing = async (startSeq: number): Promise<FetchRecentResult> =>
      blockMs > 0
        ? this.blockingFetch(stream, args.topic, startSeq, limit, deadline, emptyCursor)
        : { messages: [], nextCursor: emptyCursor };
    // Keep the wait keyed on an EMPTY PAGE rather than on the pre-check that predicted one: every
    // counter the pre-check reads is stream-wide, so on a stream wider than the topic it computes a
    // window the filtered pull then answers with nothing — and a caller's `block_ms` would buy a
    // server-side consumer create-and-delete instead of the wait it asked for.
    const pageOrWait = async (messages: Message[], startSeq: number): Promise<FetchRecentResult> => {
      // A short read (expiry, slow link, filter mismatch) must resume immediately BEFORE the window
      // it failed to read: keep `startSeq - 1`, so that an empty page can never park the persisted
      // cursor at the tail and silently drop everything in between.
      const nextCursor =
        messages.at(-1)?.cursor ?? this.cursorAt(stream, Math.max(startSeq - 1, 0));
      return messages.length === 0 && blockMs > 0
        ? this.blockingFetch(stream, args.topic, startSeq, limit, deadline, nextCursor)
        : { messages, nextCursor };
    };

    if (info.state.messages === 0) return waitOrNothing(Math.max(lastSeq + 1, 1));

    // Every counter in `state` is STREAM-wide, and `last_seq` is a SEQUENCE where `limit` is a
    // COUNT: it moves for a message this topic deleted and for a message on a subject this topic
    // does not own, so a window sized down from it can hold nothing at all. Anchor on the last
    // message the topic itself has — and keep the fall back to `last_seq`, so that a topic with no
    // message of its own inside a wider stream (the one shape `last_by_subj` answers with a 404) is
    // still served by the widening below.
    const tailSeq = (await this.tailSequence(stream, args.topic)) ?? lastSeq;

    if (since !== undefined && !restarted) {
      // JetStream prunes from the front (`max_age`), and a pull below `first_seq` starts at the
      // first surviving sequence rather than stalling. Keep the clamp anyway, so that an empty read
      // of a pruned window resumes ABOVE the gap: without it the cursor of that page is the `since`
      // it was handed, and catch-up re-reads a range the server will never fill again.
      const startSeq = Math.max(since.seq + 1, firstSeq, 1);
      if (startSeq > tailSeq) return waitOrNothing(startSeq);
      const read = await this.pull(stream, args.topic, startSeq, Math.min(limit, tailSeq - startSeq + 1), tailSeq);
      return pageOrWait(read, startSeq);
    }

    // The since-less page is the NEWEST `limit` messages, and the window above `tailSeq` may hold
    // none of them (deletes, or a foreign publisher on a stream wider than this topic). Keep the
    // walk BACKWARDS in growing windows, so that a deep hole costs work proportional to the hole
    // rather than to the retained history: reading the whole range in one pull instead makes core's
    // cold start stream — and materialize — every message the topic ever had to return `limit`.
    const newest: Message[] = [];
    let startSeq = tailSeq + 1;
    for (let span = limit, top = tailSeq; newest.length < limit && top >= firstSeq; span *= WIDEN_FACTOR) {
      startSeq = Math.max(firstSeq, top - span + 1, 1);
      const read = await this.pull(stream, args.topic, startSeq, top - startSeq + 1, top, limit - newest.length);
      newest.unshift(...read);
      if (startSeq <= firstSeq) break;
      top = startSeq - 1;
    }
    return pageOrWait(newest, startSeq);
  }
}
