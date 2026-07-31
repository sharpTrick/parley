import { asCursor } from '@sharptrick/parley-core';
import type { Cursor, Message, Topic } from '@sharptrick/parley-core';
import type { StreamConfig, StreamInfo } from 'nats';
import { incarnationToken, UNKNOWN_INCARNATION } from './cursor.js';
import { isStreamMissing } from './jetstream.js';
import { assertCaptures, streamNameFor, subjectFor } from './naming.js';
import { dec, rowToMessage } from './payload.js';
import { NatsSession } from './session.js';

const NS_PER_DAY = 86_400_000_000_000;

/** The topic → stream mapping: what a topic is called, whether it exists, and which incarnation. */
export abstract class NatsStreams extends NatsSession {
  protected subject(topic: Topic): string {
    return subjectFor(this.subjectPrefix, topic);
  }
  protected streamName(topic: Topic): string {
    return streamNameFor(this.streamPrefix, topic);
  }

  protected noteIncarnation(stream: string, info: { created?: string }): void {
    this.incarnations.set(stream, incarnationToken(info.created));
  }

  protected incarnation(stream: string): string {
    return this.incarnations.get(stream) ?? UNKNOWN_INCARNATION;
  }

  /** The dedup key AND the order key, qualified by the incarnation that minted the sequence. */
  protected cursorAt(stream: string, seq: number): Cursor {
    return asCursor(`${this.incarnation(stream)}-${seq}`);
  }

  protected msgId(topic: Topic, seq: number): string {
    return String(this.cursorAt(this.streamName(topic), seq));
  }

  protected rowToMessage(topic: Topic, seq: number, data: Uint8Array): Message {
    return rowToMessage(topic, this.msgId(topic, seq), dec.decode(data));
  }

  /**
   * Run `op` against the topic's stream, re-provisioning the stream once if it vanished
   * out-of-band (`nats stream rm`, storage reset). `ensured` memoizes success, so without this a
   * removed stream stays broken for the life of the process.
   */
  protected async withStream<T>(topic: Topic, op: () => Promise<T>): Promise<T> {
    await this.ensureStream(topic);
    try {
      return await op();
    } catch (err) {
      if (!isStreamMissing(err)) throw err;
      this.ensured.delete(this.streamName(topic));
      await this.ensureStream(topic);
      return await op();
    }
  }

  /** Create the per-topic stream once (idempotent; tolerates concurrent creation). */
  protected ensureStream(topic: Topic): Promise<void> {
    const name = this.streamName(topic);
    let pending = this.ensured.get(name);
    if (pending === undefined) {
      pending = (async () => {
        const subject = this.subject(topic);
        try {
          const config: Partial<StreamConfig> = { name, subjects: [subject] };
          if (this.retentionDays !== undefined) {
            config.max_age = Math.round(this.retentionDays * NS_PER_DAY);
          }
          this.noteIncarnation(name, await this.requireJsm().streams.add(config));
        } catch (err) {
          // Keep this swallow narrow to "already exists", so that a real add failure still surfaces
          // instead of being cached as a stream that was never created.
          const msg = err instanceof Error ? err.message : String(err);
          if (/overlap/i.test(msg)) {
            throw new Error(
              `nats stream ${name} cannot capture ${subject} — another stream on this cluster already does: stream_prefix differs from the instance that created it while subject_prefix matches (${msg})`,
            );
          }
          if (!/already in use|already exists|name already/i.test(msg)) throw err;
          const info = await this.requireJsm().streams.info(name);
          assertCaptures(name, subject, info.config.subjects ?? []);
          this.noteIncarnation(name, info);
        }
      })().catch((err: unknown) => {
        // Keep the eviction, so that a transient failure does not poison the cache with a rejected
        // promise every later call re-awaits.
        this.ensured.delete(name);
        throw err;
      });
      this.ensured.set(name, pending);
    }
    return pending;
  }

  /** Stream state, re-provisioning the stream if it vanished out-of-band. */
  protected streamInfo(topic: Topic): Promise<StreamInfo> {
    return this.withStream(topic, () => this.requireJsm().streams.info(this.streamName(topic)));
  }

  protected async existingStream(topic: Topic): Promise<StreamInfo | undefined> {
    const name = this.streamName(topic);
    const subject = this.subject(topic);
    let info: StreamInfo;
    try {
      info = await this.requireJsm().streams.info(name);
    } catch (err) {
      if (!isStreamMissing(err)) throw err;
      await this.refuseRivalStream(name, subject);
      return undefined;
    }
    assertCaptures(name, subject, info.config.subjects ?? []);
    this.noteIncarnation(name, info);
    return info;
  }

  /**
   * No stream under THIS config's name — but a stream under another name may already carry the
   * topic's subject, which is a bridge pointed at the wrong stream rather than an empty topic.
   * Keep the check, so that a diverging `stream_prefix` reports the field the operator can change
   * on the read path too; `post` learns the same thing from the overlap its `streams.add` is
   * refused with, and a read must not create a stream to find out.
   */
  private async refuseRivalStream(name: string, subject: string): Promise<void> {
    const rival = await this.requireJsm()
      .streams.find(subject)
      .catch(() => undefined);
    if (rival === undefined || rival === name) return;
    throw new Error(
      `nats stream ${name} does not exist, but ${rival} already captures ${JSON.stringify(subject)} — stream_prefix differs from the instance that created it`,
    );
  }

  /** Sequence of the topic's own last message, when the server will name it. */
  protected async tailSequence(stream: string, topic: Topic): Promise<number | undefined> {
    return this.requireJsm()
      .streams.getMessage(stream, { last_by_subj: this.subject(topic) })
      .then((msg) => msg.seq as number | undefined)
      .catch(() => undefined);
  }
}
