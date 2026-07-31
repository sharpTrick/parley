import { asBackendMsgId } from '@sharptrick/parley-core';
import type { BackendIdentity, BackendMsgId, BackendPlugin, Handle, Topic } from '@sharptrick/parley-core';
import type { StoredMsg } from 'nats';
import { isMessageMissing } from './jetstream.js';
import { NatsLive } from './live.js';
import { dec, enc, encodeRecord } from './payload.js';

export { captures } from './naming.js';
export { plaintextRemoteServer, redactUserinfo, type NatsBackendConfig } from './config.js';

/**
 * NATS JetStream backend (DESIGN §6/§9) — the fabric backend. One JetStream STREAM per topic, so
 * the stream sequence number is a strictly increasing per-topic order key; `cursor` and
 * `backendMsgId` both qualify that sequence with the stream's incarnation, because a re-provisioned
 * stream restarts at 1.
 * `post` = `js.publish` (→ seq); `fetchRecent` = an ephemeral consumer from `opt_start_seq`
 * (exclusive `since`). Core never compares cursor values — NATS delivers in seq order.
 */
export class NatsPlugin extends NatsLive implements BackendPlugin {
  async post(
    topic: Topic,
    identity: Handle,
    content: string,
    opts?: { inReplyTo?: BackendMsgId },
  ): Promise<BackendMsgId> {
    const payload = encodeRecord(identity, content, opts?.inReplyTo ?? '');
    const stream = this.streamName(topic);
    let published: string | undefined;
    const seq = await this.withStream(topic, async () => {
      published = this.incarnations.get(stream);
      const ack = await this.requireJs().publish(this.subject(topic), enc.encode(payload));
      return ack.seq;
    });
    // Read the incarnation the id will carry AFTER the ack and OUTSIDE `withStream`'s retry: keep
    // both, so that a stream re-provisioned without this plugin ever seeing a 503 is caught by the
    // sequence read-back, and so that a failure here re-publishes nothing — the message has already
    // landed, so this stays best-effort rather than telling the caller to post it twice.
    try {
      this.noteIncarnation(stream, await this.requireJsm().streams.info(stream));
    } catch {
      /* the ack stands; the cached incarnation is the best available */
    }
    if (this.incarnations.get(stream) !== published) {
      await this.confirmSequence(stream, seq, payload);
    }
    return asBackendMsgId(this.msgId(topic, seq));
  }

  /**
   * A `PubAck` carries a stream and a sequence but no incarnation, so a stream re-provisioned around
   * the publish leaves half of the id unproven. Keep this confirmation, so that a message acked by
   * an incarnation that is already gone is reported as lost rather than handed back under an id the
   * surviving incarnation will mint again for a DIFFERENT message — which core's dedup then drops.
   */
  private async confirmSequence(stream: string, seq: number, payload: string): Promise<void> {
    let stored: StoredMsg;
    try {
      stored = await this.requireJsm().streams.getMessage(stream, { seq });
    } catch (err) {
      // Keep this narrow to a definite "no message there": an inconclusive read leaves the observed
      // incarnation the best available, and rejecting a post whose message DID land tells the caller
      // to send it twice.
      if (!isMessageMissing(err)) return;
      throw ackIncarnationUnknown(stream, seq);
    }
    if (dec.decode(stored.data) !== payload) throw ackIncarnationUnknown(stream, seq);
  }

  async resolveIdentity(handle: Handle): Promise<BackendIdentity> {
    return { handle, backendRef: handle };
  }
}

const ackIncarnationUnknown = (stream: string, seq: number): Error =>
  new Error(
    `nats stream ${stream} was re-provisioned around this publish — sequence ${seq} does not hold the posted message in the incarnation now on the server, so it has no unambiguous id`,
  );
