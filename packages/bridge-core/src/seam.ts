/**
 * The Seam — the backend plugin interface (DESIGN §4). THE PRODUCT.
 *
 * A backend plugin implements these six methods; everything hard (push delivery,
 * catch-up, routing, dedup) lives ABOVE this seam in @sharptrick/parley-core. Dependencies point
 * one way: plugins depend on core, never the reverse (CLAUDE.md prime directive #1).
 *
 * Conformance contract (what makes a backend correct):
 *   1. STABLE, UNIQUE `backendMsgId` per message — the dedup key.
 *   2. MONOTONIC, IN-ORDER, EXCLUSIVE-`since` cursor delivery — order is a PLUGIN guarantee.
 *      `fetchRecent` returns messages pre-sorted ascending by cursor; `subscribe`'s handler
 *      is invoked in ascending order. Core never compares cursor values (DESIGN §6).
 */
import type { BackendMsgId, Cursor, Handle, Message, Topic } from './message.js';

/**
 * Opaque per-backend configuration, passed verbatim from `config.backend_config`.
 * Core never inspects it; the plugin owns its shape (DESIGN §11).
 */
export interface BackendConfig {
  readonly [key: string]: unknown;
}

/** Result of mapping a logical handle to a backend identity (DESIGN §4). */
export interface BackendIdentity {
  /** The logical handle that was resolved. */
  handle: Handle;
  /**
   * Backend-native reference: a provisioned Matrix user / XMPP JID / NATS subject prefix,
   * or simply `=== handle` for local backends that treat the handle as a name convention.
   */
  backendRef: string;
}

/** Arguments to {@link BackendPlugin.fetchRecent}. */
export interface FetchRecentArgs {
  topic: Topic;
  /**
   * Monotonic position to resume after. Results are STRICTLY AFTER this cursor (exclusive).
   * Omit to get the backend's default recent window (DESIGN §6).
   */
  since?: Cursor;
  /** Max messages to return in this page. */
  limit?: number;
}

/** Result of {@link BackendPlugin.fetchRecent}. */
export interface FetchRecentResult {
  /** Messages with cursor strictly greater than `since`, ALREADY SORTED ascending by cursor. */
  messages: Message[];
  /** The cursor to persist and replay verbatim as the next `since`. */
  nextCursor: Cursor;
}

/** Live-path callback: fires once per inbound message, in ascending cursor order per topic. */
export type MessageHandler = (msg: Message) => void;

/**
 * A backend plugin MUST implement these capabilities (DESIGN §4). TypeScript is the
 * reference language. `subscribe` drives the live (push) path; `fetchRecent` drives
 * catch-up; `post` is the single durable write path serving replies/output for both.
 */
export interface BackendPlugin {
  /** Establish the live connection to the backend. */
  connect(config: BackendConfig): Promise<void>;
  /** Tear down the connection and ALL subscriptions (cancels the live path). */
  disconnect(): Promise<void>;

  /**
   * Register interest in a topic. `handler` fires once per inbound message on the live path,
   * IN ASCENDING CURSOR ORDER per topic. The plugin decides HOW the handler is driven
   * (poll loop for SQLite; blocking event source for Redis/Matrix/…); core decides WHAT
   * happens (emit a `<channel>` event). `disconnect()` tears down all subscriptions
   * (DESIGN §4/§9).
   */
  subscribe(topic: Topic, handler: MessageHandler): Promise<void>;

  /**
   * Single centralized durable write path. Writes `content` to `topic` as `identity`,
   * optionally threaded to `inReplyTo`. Returns the new message's stable backend id.
   * This is the single place write-notifications originate (DESIGN §4/§7).
   */
  post(
    topic: Topic,
    identity: Handle,
    content: string,
    opts?: { inReplyTo?: BackendMsgId },
  ): Promise<BackendMsgId>;

  /**
   * Durable catch-up for ONE topic since a monotonic cursor (the standard-MCP path).
   * Returns messages strictly after `since`, pre-sorted ascending, plus `nextCursor` to
   * persist. Called once per topic; core loops over N topics (DESIGN §4/§6/§7).
   */
  fetchRecent(args: FetchRecentArgs): Promise<FetchRecentResult>;

  /**
   * Map a logical handle to a backend identity. Real account lookup for Matrix/XMPP;
   * string-format convention for NATS/local (DESIGN §4).
   */
  resolveIdentity(handle: Handle): Promise<BackendIdentity>;
}
