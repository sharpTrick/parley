import type { Topic } from '@sharptrick/parley-core';
import { fetchWithRetry } from '@sharptrick/parley-net-util';
import { aliasOf, boundedLocalpart } from './alias.js';
import {
  DEFAULT_HOMESERVER_URL,
  DEFAULT_PASSWORD,
  DEFAULT_SERVER_NAME,
  type RoomPreset,
} from './config.js';
import {
  contentOf,
  isMessageEvent,
  type MatrixEvent,
  type MessageEvent,
  readRetryAfter,
  TOPIC_KEY,
} from './wire.js';

/**
 * Every park slice ends in a full canonical catch-up or an alias lookup, so keep this floor, so
 * that a small — but perfectly legal — `sync_timeout_ms` cannot turn one idle wait into thousands
 * of homeserver requests and spend the deployment's rate-limit budget on nothing.
 */
const MIN_PARK_SLICE_MS = 250;

/** The settings a `connect()` installs, the calls that carry them, and alias → room_id resolution. */
export abstract class MatrixSession {
  protected baseUrl = DEFAULT_HOMESERVER_URL;
  protected serverName = DEFAULT_SERVER_NAME;
  protected user = 'parley';
  protected password = DEFAULT_PASSWORD;
  protected syncTimeoutMs = 25_000;
  protected roomPreset: RoomPreset = 'private_chat';
  protected invite: string[] = [];
  /** Set → shared-room mode: alias localpart every topic resolves to; else per-topic rooms. */
  protected sharedLocalpart?: string;
  protected token?: string;
  protected userId?: string;
  protected stopped = false;
  /**
   * Bumped by every `connect()`; background work captures it and stands down once it no longer
   * matches. Keep it, so that a loop parked in a retry backoff across a `disconnect()` cannot be
   * resurrected by the next `connect()` clearing {@link stopped} and run on against a stale token.
   */
  protected generation = 0;
  /** room cache key → room_id, deduped so concurrent first-posts share one create/resolve. */
  protected readonly rooms = new Map<string, Promise<string>>();
  /** In-flight sync long-polls, aborted on disconnect so teardown is immediate. */
  protected readonly controllers = new Set<AbortController>();

  /** True once work started under `generation` must stand down: we disconnected, or reconnected. */
  protected isStale(generation: number): boolean {
    return this.stopped || this.generation !== generation;
  }

  /** Tag-gated in shared mode, where the tag is forgeable — see `backend_config.shared_room`. */
  protected belongs(e: MatrixEvent, topic: Topic): e is MessageEvent {
    if (!isMessageEvent(e)) return false;
    if (this.sharedLocalpart === undefined) return true; // per-topic room: every message is ours
    return contentOf(e)[TOPIC_KEY] === topic;
  }

  /** How long a park may sleep before it re-queries: never past `remaining`, never below the floor. */
  protected parkSlice(remaining: number): number {
    return Math.min(remaining, Math.max(this.syncTimeoutMs, MIN_PARK_SLICE_MS));
  }

  /** Sleep, but no longer than the next `disconnect()` (which aborts every registered controller). */
  protected async interruptibleDelay(ms: number): Promise<void> {
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        controller.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    } finally {
      this.controllers.delete(controller);
    }
  }

  /** In shared mode all topics collapse onto one room → one cache key, one resolve. */
  private roomKey(topic: Topic): string {
    // Keep this an escape, never a literal NUL byte, so that the file stays text to file(1) and
    // greppable by ripgrep.
    return this.sharedLocalpart !== undefined ? '\u0000shared' : (topic as string);
  }

  private roomLocalpart(topic: Topic): string {
    return this.sharedLocalpart ?? boundedLocalpart(topic, this.serverName);
  }

  /** Resolve (or create) the room for `topic`, memoized so concurrent first-posts don't double-create. */
  protected ensureRoom(topic: Topic): Promise<string> {
    const key = this.roomKey(topic);
    const existing = this.rooms.get(key);
    if (existing !== undefined) return existing;
    const pending = this.resolveOrCreateRoom(this.roomLocalpart(topic)).catch((err) => {
      // Don't poison the cache on transient failure — let the next call retry.
      this.rooms.delete(key);
      throw err;
    });
    this.rooms.set(key, pending);
    return pending;
  }

  /**
   * Keep every READ path on this rather than {@link ensureRoom}, so that a topic name chosen by an
   * untrusted inbound message cannot spend the homeserver's per-user room-creation budget (Synapse:
   * ~2-room burst, then ~1 room / 45s) and starve the `post` that legitimately needs it.
   */
  protected async existingRoom(topic: Topic, generation: number): Promise<string | undefined> {
    const key = this.roomKey(topic);
    const cached = this.rooms.get(key);
    if (cached !== undefined) return cached;
    if (this.isStale(generation)) return undefined;
    const alias = aliasOf(this.roomLocalpart(topic), this.serverName);
    const roomId = await this.lookupAlias(alias);
    // Keep a gate on BOTH sides of the join, so that a teardown landing mid-resolve or mid-JOIN can
    // neither talk to the homeserver with a cleared token nor repopulate {@link rooms} for the next
    // generation.
    if (roomId === undefined || this.isStale(generation)) return undefined;
    try {
      await this.adoptRoom(roomId, alias);
    } catch (err) {
      // A teardown landing inside the join or the state read leaves this resolve without the
      // credential those calls need. Keep it reported as "no room", so that the READ above it still
      // answers with the position its caller handed it instead of surfacing our own shutdown as a
      // read failure. Anything that failed under a LIVE generation is still the caller's to see.
      if (this.isStale(generation)) return undefined;
      throw err;
    }
    if (this.isStale(generation)) return undefined;
    this.rooms.set(key, Promise.resolve(roomId));
    return roomId;
  }

  /**
   * {@link existingRoom}, re-polled until `deadline`. Keep the wait, so that a blocking read on a
   * topic whose first message has not landed yet waits for the peer's `post` to provision the room
   * instead of turning an agent's long-poll into a spin. Keep it gated on `generation` and
   * interruptible, so that the poll stands down AT the `disconnect()` rather than one
   * `sync_timeout_ms` later — and never under the next `connect()`.
   */
  protected async roomForRead(
    topic: Topic,
    deadline: number,
    generation: number,
  ): Promise<string | undefined> {
    for (;;) {
      if (this.isStale(generation)) return undefined;
      const roomId = await this.existingRoom(topic, generation);
      if (roomId !== undefined) return roomId;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return undefined;
      await this.interruptibleDelay(this.parkSlice(remaining));
    }
  }

  private async resolveOrCreateRoom(localpart: string): Promise<string> {
    const alias = aliasOf(localpart, this.serverName);
    const existing = await this.lookupAlias(alias);
    if (existing !== undefined) {
      await this.adoptRoom(existing, alias);
      return existing;
    }
    // Create. If we lost the race (another instance created it first), resolve the alias instead.
    // SEC: `visibility: 'private'` only hides the room from the directory — the JOIN RULE is what
    // keeps an uninvited account off a guessable alias, and that comes from `preset` alone.
    const res = await this.http('POST', '/_matrix/client/v3/createRoom', {
      body: {
        room_alias_name: localpart,
        preset: this.roomPreset,
        visibility: 'private',
        ...(this.invite.length > 0 ? { invite: this.invite } : {}),
      },
      allowStatuses: [400, 409],
    });
    if (res.ok) {
      const json = (await res.json()) as { room_id: string };
      return json.room_id;
    }
    // M_ROOM_IN_USE (or alias taken) → resolve the now-existing alias.
    const raced = await this.lookupAlias(alias);
    if (raced !== undefined) {
      await this.adoptRoom(raced, alias);
      return raced;
    }
    const body = await res.text();
    throw new Error(`createRoom failed (${res.status}) and alias unresolved: ${body}`);
  }

  private async lookupAlias(alias: string): Promise<string | undefined> {
    const res = await this.http(
      'GET',
      `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
      { allowStatuses: [404] },
    );
    if (!res.ok) return undefined;
    const json = (await res.json()) as { room_id: string };
    return json.room_id;
  }

  /** Join rules an adopted room may carry: those the `preset` this config asks for would produce. */
  private get acceptedJoinRules(): string[] {
    return this.roomPreset === 'public_chat' ? ['invite', 'public'] : ['invite'];
  }

  /** Accounts whose room this config is willing to use: this one, and the peers it invites. */
  private get trustedCreators(): string[] {
    return [...(this.userId === undefined ? [] : [this.userId]), ...this.invite];
  }

  /**
   * Take over a room the alias resolved to rather than one this call created, holding it to the same
   * trust bar `createRoom` would have given it. Keep the check ahead of every use of the room, so
   * that an account which claimed the topic's guessable alias first cannot have this session's
   * output posted into its room, nor its own messages delivered into the agent as `<channel>`
   * events. The join comes first because a non-member cannot read room state.
   */
  private async adoptRoom(roomId: string, alias: string): Promise<void> {
    await this.joinRoom(roomId, alias);
    const { creator, joinRule } = await this.roomProvenance(roomId);
    if (creator === undefined || !this.trustedCreators.includes(creator)) {
      throw new Error(
        `[parley-matrix] refusing the existing room ${alias} (${roomId}): it was created by ` +
          `${creator ?? 'an account the homeserver would not name'}, which is neither ` +
          `${this.userId ?? this.user} nor ` +
          'any MXID in backend_config.invite. The alias is deterministic, so any account can claim ' +
          'it before this bridge does. Add that MXID to backend_config.invite if it is a peer of ' +
          'yours; otherwise retire the room or use a different topic.',
      );
    }
    if (joinRule === undefined || !this.acceptedJoinRules.includes(joinRule)) {
      throw new Error(
        `[parley-matrix] refusing the existing room ${alias} (${roomId}): its join rule is ` +
          `${joinRule ?? 'unreadable'}, and backend_config.room_preset ${this.roomPreset} accepts ` +
          `only ${this.acceptedJoinRules.join(', ')}. Anyone who can join reads this topic's ` +
          'history and writes into the agent session. Fix the room, or set room_preset to the one ' +
          'that matches it.',
      );
    }
  }

  /**
   * Read `m.room.create` and `m.room.join_rules` off the whole state, so that the creator comes from
   * the event's SENDER: the per-event `/state/<type>` endpoint returns content alone, and
   * `m.room.create`'s `creator` field is both absent from newer room versions and unconstrained by
   * the auth rules, so a hostile homeserver can name anyone it likes in it.
   */
  private async roomProvenance(
    roomId: string,
  ): Promise<{ creator?: string; joinRule?: string }> {
    const res = await this.http(
      'GET',
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state`,
    );
    const body = (await res.json()) as unknown;
    const events: Record<string, unknown>[] = Array.isArray(body)
      ? body.filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
      : [];
    const stateOf = (type: string): Record<string, unknown> | undefined =>
      events.find((e) => e.type === type && e.state_key === '');
    const creator = stateOf('m.room.create')?.sender;
    const joinRule = (stateOf('m.room.join_rules')?.content as { join_rule?: unknown } | undefined)
      ?.join_rule;
    return {
      creator: typeof creator === 'string' ? creator : undefined,
      joinRule: typeof joinRule === 'string' ? joinRule : undefined,
    };
  }

  /**
   * Idempotent — 200 with the room_id even when already joined. Keep the 403 a THROW, so that an
   * account this room never invited fails here, naming the fix, instead of "succeeding" and
   * surfacing later as an opaque 403 out of `/send` and `/messages` — or, on the live path, as a
   * `/sync` that simply never yields the room.
   */
  private async joinRoom(roomId: string, alias: string): Promise<void> {
    const res = await this.http(
      'POST',
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
      { body: {}, allowStatuses: [403] },
    );
    if (res.status === 403) {
      throw new Error(
        `Matrix join refused (403) for ${alias} (${roomId}) as ` +
          `${this.userId ?? this.user}: the room admits only invited members. Add this account to ` +
          "the creating config's backend_config.invite, or have a member of the room invite it.",
      );
    }
  }

  /**
   * Adds auth, JSON encodes, retries 429 (`M_LIMIT_EXCEEDED`) honoring `retry_after_ms`, and throws
   * on any other non-2xx the caller did not list in `allowStatuses`.
   *
   * Keep a credential-less call a THROW unless it declared `unauthenticated`, so that no request
   * this plugin makes can reach a homeserver anonymously — not after a `connect()` whose login
   * rejected, not after the `disconnect()` that dropped the token, and not from work still in flight
   * across either. A permissive homeserver, a guest-access deployment or a captive portal answers
   * such a request, and the plugin would serve that answer as though it were connected.
   */
  protected async http(
    method: string,
    path: string,
    opts?: {
      body?: unknown;
      signal?: AbortSignal;
      allowStatuses?: number[];
      deadlineMs?: number;
      /** The ONE call that legitimately holds no credential: the login that mints one. */
      unauthenticated?: boolean;
    },
  ): Promise<Response> {
    const generation = this.generation;
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {};
    if (this.token === undefined && opts?.unauthenticated !== true) {
      throw new Error(
        `[parley-matrix] refusing ${method} ${path}: this plugin holds no access token for ` +
          `${this.baseUrl} — it is disconnected, or its last connect() did not complete its ` +
          'login. Call connect() and let it resolve before using this plugin.',
      );
    }
    if (this.token !== undefined) headers.Authorization = `Bearer ${this.token}`;
    if (opts?.body !== undefined) headers['Content-Type'] = 'application/json';

    return fetchWithRetry(
      url,
      {
        method,
        headers,
        body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: opts?.signal,
      },
      {
        label: `Matrix ${method} ${path}`,
        // Stop retrying once disconnected — don't compete for the rate-limit budget post-teardown.
        isStopped: () => this.isStale(generation),
        retryAfterOf: readRetryAfter,
        allowStatuses: opts?.allowStatuses,
        deadlineMs: opts?.deadlineMs,
      },
    );
  }
}
