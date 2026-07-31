import {
  asBackendMsgId,
  asCursor,
  type BackendConfig,
  type BackendIdentity,
  type BackendMsgId,
  type BackendPlugin,
  type FetchRecentArgs,
  type FetchRecentResult,
  type Handle,
  type MessageHandler,
  type Topic,
} from '@sharptrick/parley-core';
import { plaintextRemoteOrigin } from '@sharptrick/parley-net-util';
import { resolveConfig } from './config.js';
import { ZulipConnection } from './connection.js';
import { readWindow } from './history.js';
import { startPushLoop } from './push-loop.js';
import { blockingFetch } from './wake.js';
import { asArray, type RealmMember, requireSendableBody } from './wire.js';

export type { ZulipBackendConfig } from './config.js';
export { GAP_FILL_PAGE, TAIL_PROBE_PAGE } from './history.js';

/**
 * Zulip backend (DESIGN §6/§9) — self-hosted, and the closest native fit of any backend: Zulip's
 * data model is literally streams-and-topics, so the mapping is one configured Zulip *stream*
 * carrying all Parley traffic, with each Parley topic → a Zulip *topic* inside that stream.
 * Spoken over the raw REST API with global `fetch` — no SDK.
 *
 * The Zulip message `id` is a globally monotonic integer, hence per-topic monotonic — it serves as
 * BOTH `backendMsgId` (dedup key) AND `cursor` (order key); the zero cursor is `'0'`.
 *
 * Topic isolation is only as strong as the server's message-move policy — see README, "The one
 * inexactness: topics are mutable".
 */
export class ZulipPlugin implements BackendPlugin {
  private readonly conn = new ZulipConnection();

  /**
   * A `connect()` over a live connection tears that one down FIRST, against the config it was made
   * with. Keep the teardown here and the validation ahead of it, so that no per-connection registry
   * — subscribe loops, event queues, blocking-fetch waiters — can address the new connection with
   * the old one's state, and a rejected config leaves the live connection running.
   */
  async connect(config: BackendConfig): Promise<void> {
    const cfg = resolveConfig(config);
    if (this.conn.connected) await this.conn.close();
    this.conn.open(cfg);

    if (cfg.usesDefaultApiKey) {
      console.warn(
        '[parley-zulip] SECURITY: connecting with the built-in default API key ' +
          "('parley-api-key'). Set backend_config.api_key to a real secret; a network-reachable " +
          'Zulip bot provisioned with this key is world-readable/injectable.',
      );
    }
    const plaintext = plaintextRemoteOrigin(cfg.baseUrl);
    if (plaintext !== undefined) {
      console.warn(
        `[parley-zulip] SECURITY: site_url ${plaintext} is plaintext http:// to a non-loopback ` +
          'host, so the bot email and api_key travel the network as an unencrypted HTTP Basic ' +
          'header on every request. Use https://.',
      );
    }
  }

  async disconnect(): Promise<void> {
    await this.conn.close();
  }

  /**
   * `POST /api/v1/messages` (form-encoded — Zulip rejects JSON bodies) → the new message `id`.
   * `identity` is informational only: Zulip stamps the sender from the authenticated bot account
   * (see README "Multiple concurrent sessions"). `opts.inReplyTo` is ignored: Zulip threads by topic.
   */
  async post(
    topic: Topic, _identity: Handle, content: string, _opts?: { inReplyTo?: BackendMsgId },
  ): Promise<BackendMsgId> {
    const { conn } = this;
    conn.require();
    const generation = conn.generation;
    const body = requireSendableBody(content);
    const res = await conn.rest.request('POST', '/api/v1/messages', {
      form: { type: 'stream', to: conn.cfg.stream, topic: conn.claimWireTopic(topic), content: body },
    });
    const id = ((await res.json()) as { id?: number } | null)?.id;
    conn.assertGeneration(generation);
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
      throw new Error(
        `Zulip POST /api/v1/messages answered without a usable message id (got ${JSON.stringify(id)})`,
      );
    }
    return asBackendMsgId(String(id));
  }

  /**
   * `blockMs` is a ceiling on the WHOLE call, not just on the wait: every request the call makes
   * carries the budget that is left, so none of them can spend it on a rate-limit hint.
   */
  async fetchRecent(args: FetchRecentArgs): Promise<FetchRecentResult> {
    const { conn } = this;
    conn.require();
    const generation = conn.generation;
    const limit = args.limit ?? 100;
    const blockMs = args.blockMs ?? 0;
    const deadline = blockMs > 0 ? Date.now() + blockMs : undefined;
    let { messages } = await readWindow(conn, args.topic, args.since, limit, { generation, deadline });
    if (messages.length === 0 && args.since !== undefined && deadline !== undefined) {
      messages = await blockingFetch(conn, args.topic, args.since, limit, deadline, generation);
    }
    const nextCursor = messages.at(-1)?.cursor ?? args.since ?? asCursor('0');
    return { messages, nextCursor };
  }

  async subscribe(topic: Topic, handler: MessageHandler): Promise<void> {
    this.conn.require();
    await startPushLoop(this.conn, topic, handler);
  }

  /**
   * Real account lookup (DESIGN §4): `GET /api/v1/users` → `backendRef` = the Zulip `user_id`.
   * `email` is unique per realm; `full_name` is a self-service, NON-unique display name and is only
   * consulted when no active member carries the handle as an email. Both branches resolve only on
   * exactly ONE active match: a tie or a deactivated-only match degrades to the string convention
   * rather than letting whoever the server happens to list first answer for the handle, and any
   * error degrades the same way.
   */
  async resolveIdentity(handle: Handle): Promise<BackendIdentity> {
    this.conn.require();
    const generation = this.conn.generation;
    let members: RealmMember[] = [];
    try {
      const res = await this.conn.rest.request('GET', '/api/v1/users');
      members = asArray(((await res.json()) as { members?: RealmMember[] } | null)?.members);
    } catch {
      /* lookup is best-effort; fall through to the string convention */
    }
    this.conn.assertGeneration(generation);
    const active = members.filter((u) => u?.is_active !== false);
    const byEmail = active.filter((u) => u?.email === handle);
    if (byEmail.length === 1) return { handle, backendRef: String(byEmail[0]!.user_id) };
    if (byEmail.length === 0) {
      const byName = active.filter((u) => u?.full_name === handle);
      if (byName.length === 1) return { handle, backendRef: String(byName[0]!.user_id) };
    }
    return { handle, backendRef: handle };
  }
}
