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
  BackendCapabilities,
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
 *
 * Every seam method refuses while the plugin is disconnected, exactly as
 * packages/conformance/test/reference-plugin.ts and every shipped backend do. Keep that clause, so
 * that a core test grading teardown ORDERING cannot pass against a fake that still serves calls a
 * real backend would have already refused.
 */
export class FakePlugin implements BackendPlugin {
  private seq = 0;
  private readonly rows: Row[] = [];
  private readonly subs = new Map<Topic, Set<MessageHandler>>();
  connected = false;

  /**
   * What this fake declares on the seam. A shipped backend states its capabilities and core reads
   * them; a fake that could not state any left every core test on the default arm, which is how the
   * whole of `blockingFetch: false` — the arm eight backends take — went unexercised.
   */
  constructor(readonly capabilities?: BackendCapabilities) {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async connect(_config: BackendConfig): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.subs.clear();
  }

  async subscribe(topic: Topic, handler: MessageHandler): Promise<void> {
    this.require();
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
    this.require();
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
    this.require();
    const sinceSeq = args.since === undefined ? 0 : Number(args.since);
    const limit = args.limit ?? 100;
    const ordered = this.rows
      .filter((r) => r.msg.topic === args.topic && r.seq > sinceSeq)
      .sort((a, b) => a.seq - b.seq);
    // Keep the since-less branch on the NEWEST page, so that this fake stands in for the clause
    // every shipped backend implements (seam.ts: "the backend's default recent window"). Taking the
    // oldest instead makes every core test that reads without a cursor — cold-start
    // catch-up — grade the opposite end of history from production.
    const matched = args.since === undefined ? ordered.slice(-limit) : ordered.slice(0, limit);
    const last = matched.at(-1);
    const nextCursor = last !== undefined ? last.msg.cursor : (args.since ?? asCursor('0'));
    return { messages: matched.map((r) => r.msg), nextCursor };
  }

  async resolveIdentity(handle: Handle): Promise<BackendIdentity> {
    this.require();
    return { handle, backendRef: handle };
  }

  /**
   * Out-of-band inspection of what was durably recorded, answerable while disconnected because it
   * is not a seam call. A test that wants to know what a torn-down bridge managed to post reads
   * this; reading it through `fetchRecent` instead would need a connection the bridge has closed.
   */
  recorded(topic: Topic): Message[] {
    return this.rows
      .filter((r) => r.msg.topic === topic)
      .sort((a, b) => a.seq - b.seq)
      .map((r) => r.msg);
  }

  private require(): void {
    if (!this.connected) throw new Error('fake plugin is disconnected');
  }
}

/** A {@link FakePlugin} already connected, the state core's composition root leaves it in. */
export async function connectedFake(): Promise<FakePlugin> {
  const plugin = new FakePlugin();
  await plugin.connect({});
  return plugin;
}
