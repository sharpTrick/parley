import type { Cursor, FetchRecentResult, Message, Topic } from '@sharptrick/parley-core';
import type { ConsumerMessages } from 'nats';
import {
  delay,
  DRAIN_TIMEOUT_MS,
  EphemeralConsumer,
  fromSequence,
  pullPatience,
  type Closeable,
} from './jetstream.js';
import { NatsStreams } from './streams.js';

/**
 * Keep every step from `consumers.add` on inside the try, so that a throw still reaches the
 * finally's delete — an ephemeral consumer nobody deletes lingers for `inactive_threshold`.
 */
export abstract class NatsPulls extends NatsStreams {
  /**
   * One ephemeral pull from `startSeq`, ended by `want` messages, `tailSeq`, or a quiet link.
   * Keep `keep` bounding what is RETAINED: a window is a range of sequences, so `want` messages may
   * be far more than the page needs, and holding them all makes a page's memory proportional to the
   * history rather than to `limit`.
   */
  protected async pull(
    stream: string,
    topic: Topic,
    startSeq: number,
    want: number,
    tailSeq: number,
    keep = want,
  ): Promise<Message[]> {
    // Keep the handle captured at entry: `disconnect()` clears `this.jsm` as soon as its closers
    // return, and reading it later instead skips the delete and leaks the consumer.
    const jsm = this.requireJsm();
    const ephemeral = new EphemeralConsumer(jsm, stream);
    const messages: Message[] = [];
    let batch: ConsumerMessages | undefined;
    let idle: ReturnType<typeof setTimeout> | undefined;
    let wentQuiet = false;
    const closer: Closeable = {
      close: async () => {
        void batch?.close();
        await ephemeral.reap();
      },
    };
    this.subscriptions.push(closer);
    try {
      const setupStarted = Date.now();
      const name = await ephemeral.add(fromSequence(this.subject(topic), startSeq));
      const consumer = await this.requireJs().consumers.get(stream, name);
      const patience = pullPatience(Date.now() - setupStarted);
      batch = await consumer.fetch({ max_messages: want, expires: patience.expires });
      // Keep the idle close: `want` is an upper bound over a range that may be sparse — a deleted or
      // pruned message anywhere in it otherwise holds the pull for its whole `expires` on every call.
      const live = batch;
      const armIdleClose = (): void => {
        clearTimeout(idle);
        idle = setTimeout(() => {
          wentQuiet = true;
          void live.close();
        }, patience.idleMs);
      };
      armIdleClose();
      try {
        let read = 0;
        for await (const m of batch) {
          armIdleClose();
          // Keep the tail EXCLUSIVE of what follows it: a window is one step of a walk, and a
          // message above its top belongs to the step already taken — taking it again duplicates it.
          if (m.seq > tailSeq) break;
          messages.push(this.rowToMessage(topic, m.seq, m.data));
          if (messages.length > keep) messages.splice(0, messages.length - keep);
          read += 1;
          if (read >= want || m.seq >= tailSeq) break;
        }
      } catch (err) {
        if (!wentQuiet) throw err;
      }
    } finally {
      clearTimeout(idle);
      this.unregister(closer);
      void batch?.close();
      await ephemeral.reap();
    }
    return messages;
  }

  /**
   * Long-poll half of `fetchRecent`: the exclusive `since` query was empty, so wait on an ephemeral
   * JetStream pull from `startSeq` — the pull's `expires` IS the bounded wait — and return on the
   * first message, at the deadline, or on `disconnect()`. `fallback` is the cursor of an empty page.
   */
  protected async blockingFetch(
    stream: string,
    topic: Topic,
    startSeq: number,
    limit: number,
    deadline: number,
    fallback: Cursor,
  ): Promise<FetchRecentResult> {
    const remaining = deadline - Date.now();
    if (remaining <= 0 || this.stopped) return { messages: [], nextCursor: fallback };

    const jsm = this.requireJsm();
    const ephemeral = new EphemeralConsumer(jsm, stream);
    const messages: Message[] = [];
    let batch: ConsumerMessages | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    let polling = false;
    let cleanedUp = (): void => undefined;
    const cleanup = new Promise<void>((resolve) => {
      cleanedUp = () => resolve();
    });
    // Keep the closer registered BEFORE the consumer is asked for and waiting on this read's own
    // cleanup: `disconnect()` drops its handles the moment its closers return, so one registered
    // late leaves a consumer created inside the teardown window, and one that returns on
    // `batch.close()` alone leaves the consumer this read is still about to delete.
    const closer: Closeable = {
      close: async () => {
        void batch?.close();
        if (polling) await Promise.race([cleanup, delay(DRAIN_TIMEOUT_MS)]);
        await ephemeral.reap();
      },
    };
    this.subscriptions.push(closer);
    try {
      const name = await ephemeral.add(fromSequence(this.subject(topic), startSeq));
      const consumer = await this.requireJs().consumers.get(stream, name);
      // Keep the 1000ms floor: nats.js rejects a shorter `expires`, and the timer below — not
      // `expires` — is what honours a sub-second `blockMs`.
      batch = await consumer.fetch({ max_messages: limit, expires: Math.max(remaining, 1000) });
      polling = true;

      const live = batch;
      // Keep the timer armed off the LIVE clock, so that setup round-trips cannot push the return
      // past the caller's `blockMs`.
      timer = setTimeout(() => {
        expired = true;
        void live.close();
      }, Math.max(deadline - Date.now(), 0));

      for await (const m of batch) {
        if (this.stopped) break;
        messages.push(this.rowToMessage(topic, m.seq, m.data));
        // Keep the single-message return, so that a long-poll wakes its caller at once; the
        // remainder of a burst stays in the stream and core polls it.
        break;
      }
    } catch (err) {
      // Keep this narrow to the two terminations we caused ourselves, so that a long-poll fails the
      // way the same read without `block_ms` does instead of reporting every backend fault as
      // "nothing new" forever.
      if (!expired && !this.stopped) throw err;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.unregister(closer);
      void batch?.close();
      await ephemeral.reap();
      cleanedUp();
    }
    const last = messages.at(-1);
    return { messages, nextCursor: last !== undefined ? last.cursor : fallback };
  }
}
