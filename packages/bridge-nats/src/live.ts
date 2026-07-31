import type { MessageHandler, Topic } from '@sharptrick/parley-core';
import type { ConsumerMessages } from 'nats';
import { closeOnConsumerLoss, delay, EphemeralConsumer, fromSequence } from './jetstream.js';
import { NatsReads } from './read.js';

const RESUBSCRIBE_BACKOFF_MS = 1000;

export abstract class NatsLive extends NatsReads {
  /**
   * Live path = an ephemeral `consume()` consumer resuming at the last delivered sequence + 1
   * (DESIGN §9 — genuine events; history is owned by catch-up). `lastSeq` is seeded from the stream
   * tail at subscribe time so the FIRST consumer, like every rebuilt one, backfills whatever landed
   * while it was absent. ANY iterator exit rebuilds — a connection drop ends `consume()` with no
   * status event at all — and so does a break in the consumer's delivery sequence, which is the only
   * evidence left of an `AckPolicy.None` message the server sent into a link that was already gone.
   * The outer loop honors `disconnect()`: the registered closer plus the epoch it captured stop it
   * without a rebuild, as does a permanently closed connection. The epoch is what makes teardown
   * final — `disconnect()` retires every loop, so one still parked in its backoff cannot wake into a
   * later `connect()`'s live handles and deliver to a handler its owner already dropped.
   */
  async subscribe(topic: Topic, handler: MessageHandler): Promise<void> {
    const epoch = this.epoch;
    const running = (): boolean => this.epoch === epoch && this.live();
    const retired = (): boolean => this.epoch !== epoch || this.stopped;
    // Keep the handle captured at entry, as `pull()` does: `disconnect()` clears `this.jsm` as soon
    // as its closers return, and reading it inside the loop instead skips the delete and leaks the
    // consumer for its whole `inactive_threshold`.
    const jsm = this.requireJsm();
    const stream = this.streamName(topic);
    const filterSubject = this.subject(topic);
    const seeded = await this.streamInfo(topic);
    let lastSeq = seeded.state.last_seq;
    let created = seeded.created;
    let current: ConsumerMessages | undefined;
    let ephemeral = new EphemeralConsumer(jsm, stream);
    this.subscriptions.push({
      close: async () => {
        await current?.close();
        await ephemeral.reap();
      },
    });

    void (async () => {
      let rebuild = false;
      while (running()) {
        let iter: ConsumerMessages;
        try {
          if (rebuild) await delay(RESUBSCRIBE_BACKOFF_MS);
          if (!running()) break;
          rebuild = true;
          // A recreated stream restarts its sequences, so a position carried over from the old one
          // would skip the new stream's messages (or ask for a sequence past its tail forever).
          const info = await this.streamInfo(topic);
          this.noteIncarnation(stream, info);
          if (info.created !== created) {
            created = info.created;
            lastSeq = 0;
          }
          if (!running()) break;
          // Keep the new reaper and its `add` in ONE synchronous step: the closer above reads this
          // slot, so a teardown that interleaved between them would watch the wrong consumer.
          ephemeral = new EphemeralConsumer(jsm, stream);
          const name = await ephemeral.add(fromSequence(filterSubject, lastSeq + 1));
          const consumer = await this.requireJs().consumers.get(stream, name);
          current = await consumer.consume();
          iter = current;
        } catch {
          await ephemeral.reap();
          if (!running()) break;
          continue; // backend momentarily unreachable — retry the consumer after the backoff
        }

        const statusTask = closeOnConsumerLoss(iter);

        try {
          let nextDelivery = 1;
          let stale = false;
          for await (const m of iter) {
            // Keep draining a closed iterator instead of breaking out: nats.js runs the teardown
            // that stops the status listeners as a QUEUED item, so an abandoned iterator leaves
            // `statusTask` below awaiting forever.
            if (stale) continue;
            // Keep the delivery-sequence check, counted from 1 so the FIRST delivery is checked
            // too: with `AckPolicy.None` the server counts a message as delivered the moment it
            // writes it to the link, so a gap here — or a first message that is not delivery 1 —
            // is a message no reconnect will resend; only rebuilding from `lastSeq + 1` gets it
            // back, and any primed-state exemption hides the hole that opened before it arrived.
            if (retired() || m.info.deliverySequence !== nextDelivery) {
              stale = true;
              void iter.close().catch(() => undefined);
              continue;
            }
            nextDelivery = m.info.deliverySequence + 1;
            lastSeq = m.seq;
            try {
              handler(this.rowToMessage(topic, m.seq, m.data));
            } catch {
              /* handler is best-effort (DESIGN §6) */
            }
          }
        } catch {
          /* iterator closed on disconnect or consumer loss */
        }
        await statusTask;
        await ephemeral.reap();
        if (retired()) break; // only a clean disconnect ends the loop; every other exit rebuilds
      }
    })();
  }
}
