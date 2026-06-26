import {
  asBackendMsgId,
  asCursor,
  type BackendMsgId,
  type Handle,
  type Message,
  type Topic,
} from '../message.js';
import { parseMentions } from '../mentions.js';
import type {
  BackendConfig,
  BackendIdentity,
  BackendPlugin,
  FetchRecentArgs,
  FetchRecentResult,
  MessageHandler,
} from '../seam.js';

interface Row {
  seq: number;
  msg: Message;
}

/**
 * In-memory BackendPlugin for CORE unit tests only (not shipped to users). It mirrors the
 * SQLite semantics that make a backend conformant:
 *   - a global monotonic `seq` is the cursor (monotonic within every topic),
 *   - stable, unique `backendMsgId`,
 *   - `fetchRecent` returns rows strictly after `since`, pre-sorted ascending,
 *   - `subscribe` delivers new posts live (synchronously) in ascending order, history-skipped.
 *
 * This lets us exercise the catch-up driver, dedup, mention-filter, and the dual-role server
 * without standing up a real backend — and doubles as a sanity check that the conformance
 * suite is backend-shaped, not SQLite-shaped.
 */
export class FakePlugin implements BackendPlugin {
  private seq = 0;
  private readonly rows: Row[] = [];
  private readonly subs = new Map<Topic, Set<MessageHandler>>();
  connected = false;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async connect(_config: BackendConfig): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.subs.clear();
  }

  async subscribe(topic: Topic, handler: MessageHandler): Promise<void> {
    let set = this.subs.get(topic);
    if (set === undefined) {
      set = new Set<MessageHandler>();
      this.subs.set(topic, set);
    }
    set.add(handler);
  }

  async post(
    topic: Topic,
    identity: Handle,
    content: string,
    _opts?: { inReplyTo?: BackendMsgId },
  ): Promise<BackendMsgId> {
    const seq = ++this.seq;
    const id = asBackendMsgId(String(seq));
    const msg: Message = {
      topic,
      senderHandle: identity,
      content,
      // Deterministic; timestamp is informational only and never used for order/dedup.
      timestamp: new Date(seq * 1000).toISOString(),
      backendMsgId: id,
      cursor: asCursor(String(seq)),
      mentions: parseMentions(content),
    };
    this.rows.push({ seq, msg });
    for (const handler of this.subs.get(topic) ?? []) handler(msg);
    return id;
  }

  async fetchRecent(args: FetchRecentArgs): Promise<FetchRecentResult> {
    const sinceSeq = args.since === undefined ? 0 : Number(args.since);
    const limit = args.limit ?? 100;
    const matched = this.rows
      .filter((r) => r.msg.topic === args.topic && r.seq > sinceSeq)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit);
    const last = matched.at(-1);
    const nextCursor = last !== undefined ? last.msg.cursor : (args.since ?? asCursor('0'));
    return { messages: matched.map((r) => r.msg), nextCursor };
  }

  async resolveIdentity(handle: Handle): Promise<BackendIdentity> {
    return { handle, backendRef: handle };
  }
}
