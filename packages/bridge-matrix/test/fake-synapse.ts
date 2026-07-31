import { asTopic, safeName } from '@sharptrick/parley-core';
import { MatrixPlugin, type RoomPreset, sanitizeAlias } from '../src/index.js';

/**
 * In-memory fake Synapse: a `global.fetch` stub modelling an alias DIRECTORY of rooms — one
 * `room_id` and one timeline per alias — plus Matrix pagination tokens, room creation, and
 * injectable `/sync` failures. Shared by every Matrix test file so a behavior proven here is proven
 * against the real plugin code paths (`fetchRecent` / `subscribe` / `backfill` / `ensureRoom`), not
 * against a mock of them.
 *
 * Keep the room-per-alias directory, so that the topic → room mapping is under test: a fake with one
 * room certifies a plugin that resolves every topic to the same room, which in per-topic mode (the
 * production configuration) is a total topic-isolation bypass.
 *
 * Pagination-token model: a token `p<n>` is a boundary index into that ROOM's timeline array.
 *   dir=f from p<n> → timeline[n], timeline[n+1], … ascending; end = p<n+count>
 *   dir=b from p<n> → timeline[n-1], timeline[n-2], … newest-first; end = p<n-count>
 *   /context/<id> → { start:p<i>, end:p<i> } — an `end` that RE-INCLUDES the since event. Keep it
 *   re-including, so that the plugin's exclusivity handling stays graded: the spec pins no
 *   convention and Synapse's own `end` is exclusive, so matching Synapse would delete the only
 *   coverage of the other legal shape. A `from` that is not `p<n>` is rejected 400, as Synapse does.
 *
 * The fake deliberately IGNORES the server-side `filter` on `/messages`, so client-side topic/type
 * filtering stays under test even though production offloads part of it to the homeserver; what is
 * actually SENT is graded from {@link FakeSynapse.messagesRequests}.
 */

export const TOPIC_KEY = 'app.parley.topic';
export const SERVER_NAME = 'fake';
/** The `shared_room` localpart every shared-mode fixture folds its topics into. */
export const SHARED_LOCALPART = 'parley_conformance';

/**
 * The alias the plugin will ask for. Composed from the plugin's OWN exported fold, so a test naming
 * a room cannot drift from the code that resolves it — and a fold regression fails on the wire
 * assertions in `provisioning.fake.test.ts` rather than being mirrored here into a pass.
 */
export const aliasForTopic = (topic: string, shared = false): string =>
  `#${shared ? SHARED_LOCALPART : `parley_${safeName(asTopic(topic), sanitizeAlias)}`}:${SERVER_NAME}`;

export interface Ev {
  type: unknown;
  event_id: unknown;
  sender: unknown;
  origin_server_ts: unknown;
  content: unknown;
}

export interface FakeRoom {
  roomId: string;
  alias: string;
  timeline: Ev[];
}

const jsonRes = (obj: unknown, status = 200): Response =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

const notFound = (what: string): Response =>
  jsonRes({ errcode: 'M_NOT_FOUND', error: `unknown ${what}` }, 404);

export class FakeSynapse {
  private readonly byAlias = new Map<string, FakeRoom>();
  private readonly byId = new Map<string, FakeRoom>();
  private counter = 0;
  private roomCounter = 0;
  /** Alias of the most recent directory lookup / createRoom — where an unrouted injection lands. */
  private lastAlias?: string;
  /** Every alias `/directory/room/` was asked to resolve, in order. */
  readonly directoryLookups: string[] = [];
  /** Every `/messages` request URL, in order — the evidence for what went on the wire. */
  readonly messagesRequests: URL[] = [];
  /** Every request URL, in order — the evidence for which rooms a run actually touched. */
  readonly requestUrls: URL[] = [];
  /**
   * The `Authorization` header of each request, index-aligned with {@link requestUrls}. Keep the
   * credential observable, so that WHICH token went to WHICH homeserver is gradeable: a plugin that
   * carries one login's bearer token to another host is indistinguishable from a healthy one on the
   * URL alone.
   */
  readonly requestAuth: (string | undefined)[] = [];
  /**
   * How `POST /v3/login` answers: 200, an HTTP status, or a rejected fetch. Keep a failing login
   * expressible, so that the state a REJECTED `connect()` leaves behind is gradeable at all.
   */
  loginOutcome: number | 'network' = 200;
  /** How many events an incremental /sync will return before it truncates with `limited:true`. */
  syncCap = 100;
  /** Number of `limited:true` incremental syncs emitted — proves the backfill path was exercised. */
  limitedEmitted = 0;
  /**
   * By how many events a `limited` sync's `prev_batch` overlaps the batch it returned. Keep the
   * non-zero settings exercised, so that the backfill's de-duplication guard stays reachable at all:
   * Synapse's own `prev_batch` is exclusive, and a suite modelling only Synapse can never fire it.
   */
  prevBatchOverlap = 0;
  /** False → `/directory/room/<alias>` 404s, forcing `POST /createRoom` (provisioning path). */
  aliasExists = true;
  /** Every `POST /createRoom` body, in order — an ATTEMPT is recorded even when it is refused. */
  readonly createRoomBodies: Record<string, unknown>[] = [];
  /** Remaining `POST /createRoom` calls to refuse with 429 — the per-user creation budget, spent. */
  createRoomLimited = 0;
  createRoomRetryAfterMs = 45_000;
  /**
   * Status a `POST /createRoom` for an alias already taken answers with. Synapse says 409
   * `M_ROOM_IN_USE`; some deployments and some paths answer 400 instead, and the plugin treats both
   * as "somebody else got there first", so both are expressible here.
   */
  createRoomConflictStatus = 409;
  /**
   * Status `POST /rooms/<id>/join` answers with. 403 = the invite-only room this account was never
   * invited to (a second Matrix account against a room the first created); 404 = the room is gone.
   */
  joinStatus = 200;
  /** Every `PUT .../send/m.room.message/<txn>` body, in order. */
  readonly sentBodies: Record<string, unknown>[] = [];
  /** Remaining `PUT .../send/m.room.message/<txn>` calls to refuse with 429. */
  sendLimited = 0;
  sendRetryAfterMs = 60;
  /**
   * `<access token>|<txn id>` → the `event_id` that transaction already produced. Matrix makes a
   * `PUT .../send/<txnId>` IDEMPOTENT per access token, which is the entire reason the plugin mints a
   * fresh txn id per `post` and the entire reason `fetchWithRetry` may re-send one on a 429. Keep the
   * map, so that both directions are reachable offline: a fake that appends on every PUT certifies a
   * fixed txn id (total write loss against Synapse) and grades no retry as duplicate-free.
   */
  private readonly transactions = new Map<string, unknown>();
  /** Remaining incremental-`/sync` calls to fail (`Infinity` = a permanent failure). */
  syncFailures = 0;
  /**
   * Bodies the next incremental `/sync` calls answer with VERBATIM, one per call, in order. These
   * are the malformed-but-parseable shapes a homeserver, a proxy or a captive portal can put on the
   * wire — `null`, an array, a scalar, a `timeline.events` that is not a list. Keep them expressible,
   * so that the branch dereferencing a `/sync` body is graded against something `res.json()` accepts:
   * an HTTP status or a network reject never reaches it.
   */
  readonly syncBodyOverrides: ((roomId: string) => unknown)[] = [];
  /** How an injected `/sync` failure presents: an HTTP status, or a rejected fetch. */
  syncFailureMode: 'status' | 'network' = 'status';
  syncFailureStatus = 500;
  /** Remaining `/messages` calls to fail — the catch-up read path's fault injection. */
  messagesFailures = 0;
  messagesFailureMode: 'status' | 'network' = 'status';
  messagesFailureStatus = 500;
  /** Called before each request is served, so a case can arm a fault at a chosen phase. */
  onRequest: (method: string, path: string) => void = () => undefined;
  /** Wall-clock timestamps of incremental `/sync` attempts — the retry-pacing evidence. */
  readonly syncAttempts: number[] = [];
  /** Count of `timeout=0` positioning syncs served so far; the next one's 1-based ordinal is this + 1. */
  positioningSyncs = 0;
  /**
   * Which positioning sync to stall, by 1-based arrival ordinal. Keep this a per-request predicate
   * rather than a "stall the first N" counter, so that a case naming one participant's positioning
   * window cannot silently grade a different participant's.
   */
  stallPositioning: (ordinal: number) => boolean = () => false;
  stallPositioningMs = 600;
  /** Ordinals actually stalled — a case that stalled nobody is visible instead of quietly passing. */
  readonly stalledPositioning: number[] = [];
  /**
   * Called at the START of a stalled positioning sync — before its `next_batch` is read — so a case
   * can land an event inside the exact window it names rather than racing a wall-clock timer.
   */
  duringPositioningStall: (ordinal: number) => void = () => undefined;
  /**
   * Called once a positioning sync's body — its `next_batch` AND the timeline tip that goes with it
   * — has been computed, and BEFORE it is returned. An event landed here is strictly newer than the
   * position the subscriber is about to resume from, so it MUST be delivered live; it is the window
   * a boundary read one round-trip after the position silently swallows.
   */
  afterPositioningSync: (ordinal: number) => void = () => undefined;
  /**
   * Called with each `/messages` request AFTER its response body has been computed and BEFORE that
   * body is returned; the returned ms hold the response in flight. Lets a case land an event in the
   * window where a reader has already snapshotted its (empty) result — the lost-wakeup shape — or
   * stall one specific read (the `limited`-burst backfill) without touching the others.
   */
  holdMessages: (url: URL, body: { chunk: Ev[] }) => number = () => 0;

  /** Rooms that exist, in creation order. */
  get rooms(): FakeRoom[] {
    return [...this.byId.values()];
  }

  /** Every event in every room — for an absence check that must not name a room. */
  get allEvents(): Ev[] {
    return this.rooms.flatMap((r) => r.timeline);
  }

  roomIdFor(alias: string): string | undefined {
    return this.byAlias.get(alias)?.roomId;
  }

  timelineOf(alias: string): Ev[] {
    return this.byAlias.get(alias)?.timeline ?? [];
  }

  private room(alias: string): FakeRoom {
    const existing = this.byAlias.get(alias);
    if (existing !== undefined) return existing;
    const room: FakeRoom = {
      roomId: `!room${this.roomCounter++}:${SERVER_NAME}`,
      alias,
      timeline: [],
    };
    this.byAlias.set(alias, room);
    this.byId.set(room.roomId, room);
    return room;
  }

  /**
   * Where an injected event lands: the named alias, else the room the plugin last asked about. Keep
   * the throw, so that an injection with no room to land in fails the case instead of silently
   * grading nothing.
   */
  private target(alias?: string): FakeRoom {
    const chosen = alias ?? this.lastAlias;
    if (chosen === undefined)
      throw new Error(
        'FakeSynapse: no alias has been resolved yet — pass one to say which room to inject into',
      );
    return this.room(chosen);
  }

  private ev(type: string, content: Record<string, unknown>, room: FakeRoom): Ev {
    const e: Ev = {
      type,
      event_id: `$e${this.counter}:fake`,
      sender: '@parley:fake',
      origin_server_ts: 1_700_000_000_000 + this.counter,
      content,
    };
    this.counter++;
    room.timeline.push(e);
    return e;
  }

  /** Inject a message from a "foreign" client (simulates a post that landed between polls). */
  addMessage(topic: string, body: string, alias?: string): Ev {
    return this.ev(
      'm.room.message',
      { msgtype: 'm.text', body, [TOPIC_KEY]: topic },
      this.target(alias),
    );
  }

  /**
   * Inject an `m.room.message` carrying NO `app.parley.topic` tag — what a human in Element, or any
   * other native Matrix client, actually sends. Keep it distinct from {@link addMessage}, so that the
   * per-topic mode's delivery predicate (the room is the boundary; the tag is ignored) is gradeable:
   * every other injector tags its events, and a tagged event is delivered in BOTH modes.
   */
  addUntagged(body: string, alias?: string): Ev {
    return this.ev('m.room.message', { msgtype: 'm.text', body }, this.target(alias));
  }

  /** Inject a non-`m.room.message` event (reaction / membership churn). */
  addRaw(type: string, alias?: string): Ev {
    return this.ev(type, {}, this.target(alias));
  }

  /**
   * Inject an `m.room.message` whose fields carry arbitrary JSON. Synapse enforces no schema on
   * event content, so any room member can send these — they are what the plugin actually reads.
   */
  addHostile(fields: Partial<Ev>, alias?: string): Ev {
    const e = this.ev(
      'm.room.message',
      { msgtype: 'm.text', body: 'hostile' },
      this.target(alias),
    );
    Object.assign(e, fields);
    return e;
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    // Yield to the macrotask queue on every request so the subscribe() poll loop (no delay on its
    // success path) can never starve vitest's timer-based vi.waitFor.
    await new Promise((r) => setTimeout(r, 1));
    const url = new URL(typeof input === 'string' ? input : ((input as Request).url ?? String(input)));
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.pathname;
    const auth = new Headers(init?.headers).get('authorization') ?? undefined;
    this.requestUrls.push(url);
    this.requestAuth.push(auth);
    this.onRequest(method, path);

    if (path.endsWith('/v3/login')) {
      if (this.loginOutcome === 'network') throw new Error('fake network reset');
      if (this.loginOutcome !== 200) {
        return jsonRes({ errcode: 'M_FORBIDDEN', error: 'injected' }, this.loginOutcome);
      }
      // Mint the token from the HOST, so that a credential arriving at the wrong homeserver names
      // the one it was minted by instead of being indistinguishable from that host's own.
      return jsonRes({ access_token: tokenFor(url.host), user_id: '@parley:fake' });
    }

    const dirMatch = path.match(/\/v3\/directory\/room\/([^/]+)$/);
    if (dirMatch) {
      const alias = decodeURIComponent(dirMatch[1]!);
      this.directoryLookups.push(alias);
      this.lastAlias = alias;
      return this.aliasExists
        ? jsonRes({ room_id: this.room(alias).roomId })
        : jsonRes({ errcode: 'M_NOT_FOUND', error: 'room alias not found' }, 404);
    }
    if (path.endsWith('/v3/createRoom')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      this.createRoomBodies.push(body);
      if (this.createRoomLimited > 0) {
        this.createRoomLimited--;
        return jsonRes(
          { errcode: 'M_LIMIT_EXCEEDED', error: 'Too many requests', retry_after_ms: this.createRoomRetryAfterMs },
          429,
        );
      }
      const alias = `#${String(body.room_alias_name)}:${SERVER_NAME}`;
      // Aliases are unique on a real homeserver: the loser of a create race is REFUSED, and must
      // resolve and join the winner's room instead. Keep the refusal, so that the recovery branch is
      // reachable at all — a fake that hands the existing room back with a 200 certifies a plugin
      // that would throw against Synapse the first time two bridges first-post to one topic.
      if (this.byAlias.has(alias)) {
        return jsonRes(
          { errcode: 'M_ROOM_IN_USE', error: 'Room alias already taken' },
          this.createRoomConflictStatus,
        );
      }
      this.aliasExists = true;
      this.lastAlias = alias;
      return jsonRes({ room_id: this.room(alias).roomId });
    }

    const inRoom = ((): FakeRoom | undefined => {
      const m = path.match(/\/v3\/rooms\/([^/]+)/);
      return m === null ? undefined : this.byId.get(decodeURIComponent(m[1]!));
    })();

    if (path.endsWith('/join')) {
      if (this.joinStatus !== 200) {
        const errcode = this.joinStatus === 403 ? 'M_FORBIDDEN' : 'M_NOT_FOUND';
        return jsonRes({ errcode, error: 'You are not invited to this room.' }, this.joinStatus);
      }
      if (inRoom === undefined) return notFound('room');
      return jsonRes({ room_id: inRoom.roomId });
    }

    const send = /\/rooms\/[^/]+\/send\/m\.room\.message\/([^/]+)$/.exec(path);
    if (method === 'PUT' && send !== null) {
      if (this.sendLimited > 0) {
        this.sendLimited--;
        return jsonRes(
          { errcode: 'M_LIMIT_EXCEEDED', error: 'Too many requests', retry_after_ms: this.sendRetryAfterMs },
          429,
        );
      }
      if (inRoom === undefined) return notFound('room');
      const txnKey = `${auth ?? ''}|${decodeURIComponent(send[1]!)}`;
      const replayed = this.transactions.get(txnKey);
      if (replayed !== undefined) return jsonRes({ event_id: replayed });
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      this.sentBodies.push(body);
      const e = this.ev(
        'm.room.message',
        {
          msgtype: 'm.text',
          body: body.body,
          [TOPIC_KEY]: body[TOPIC_KEY],
          ...(body['m.relates_to'] !== undefined ? { 'm.relates_to': body['m.relates_to'] } : {}),
        },
        inRoom,
      );
      this.transactions.set(txnKey, e.event_id);
      return jsonRes({ event_id: e.event_id });
    }

    const ctx = path.match(/\/rooms\/[^/]+\/context\/([^/]+)$/);
    if (ctx) {
      if (inRoom === undefined) return notFound('room');
      const evId = decodeURIComponent(ctx[1]!);
      const idx = inRoom.timeline.findIndex((e) => e.event_id === evId);
      if (idx < 0) return jsonRes({ errcode: 'M_NOT_FOUND', error: 'event not found' }, 404);
      return jsonRes({ start: `p${idx}`, end: `p${idx}`, event: inRoom.timeline[idx] });
    }
    // An EMPTY cursor degenerates to `/context/` with no event id — Synapse answers 404 there, and
    // the plugin must never mint such a cursor (it decodes as "expired" and truncates the stream).
    if (/\/rooms\/[^/]+\/context\/?$/.test(path)) {
      return jsonRes({ errcode: 'M_NOT_FOUND', error: 'no event id' }, 404);
    }

    if (/\/rooms\/[^/]+\/messages$/.test(path)) {
      this.messagesRequests.push(url);
      if (this.messagesFailures > 0) {
        this.messagesFailures--;
        if (this.messagesFailureMode === 'network') throw new Error('fake network reset');
        return jsonRes({ errcode: 'M_UNKNOWN', error: 'injected' }, this.messagesFailureStatus);
      }
      if (inRoom === undefined) return notFound('room');
      const timeline = inRoom.timeline;
      const dir = url.searchParams.get('dir');
      const limit = Number(url.searchParams.get('limit') ?? '10');
      const from = url.searchParams.get('from');
      if (from !== null && !/^p\d+$/.test(from)) {
        return jsonRes({ errcode: 'M_UNKNOWN', error: "'from' parameter is invalid" }, 400);
      }
      const body = ((): { chunk: Ev[]; start: string; end: string } => {
        if (dir === 'f') {
          const b = from ? tokenPos(from) : 0;
          const chunk = timeline.slice(b, b + limit);
          return { chunk, start: `p${b}`, end: `p${b + chunk.length}` };
        }
        // dir=b (default for recentWindow — no `from` → newest-first from the tail).
        const b = from ? tokenPos(from) : timeline.length;
        const start = Math.max(0, b - limit);
        return { chunk: timeline.slice(start, b).reverse(), start: `p${b}`, end: `p${start}` };
      })();
      const hold = this.holdMessages(url, body);
      if (hold > 0) await new Promise((r) => setTimeout(r, hold));
      return jsonRes(body);
    }

    if (path.endsWith('/v3/sync')) {
      const since = url.searchParams.get('since');
      const filter = JSON.parse(url.searchParams.get('filter') ?? '{}') as {
        room?: { rooms?: string[]; timeline?: { limit?: number } };
      };
      const filterLimit = filter.room?.timeline?.limit ?? 0;
      const syncRoom = this.byId.get(filter.room?.rooms?.[0] ?? '');
      const timeline = syncRoom?.timeline ?? [];
      const joined = (payload: unknown): Response =>
        jsonRes(
          syncRoom === undefined
            ? { next_batch: `p${timeline.length}`, rooms: { join: {} } }
            : (payload as Record<string, unknown>),
        );
      const len = timeline.length;
      if (since === null) {
        // Initial positioning sync: a resume token plus the newest `filterLimit` events, snapshotted
        // TOGETHER the way a real homeserver does — an initial sync's timeline is what precedes its
        // own next_batch, so a case landing an event after this point lands it strictly after both.
        const ordinal = ++this.positioningSyncs;
        if (this.stallPositioning(ordinal)) {
          this.stalledPositioning.push(ordinal);
          this.duringPositioningStall(ordinal);
          await new Promise((r) => setTimeout(r, this.stallPositioningMs));
        }
        const at = timeline.length;
        const res = joined({
          next_batch: `p${at}`,
          rooms: {
            join: {
              [syncRoom?.roomId ?? '']: {
                timeline: {
                  events: timeline.slice(Math.max(0, at - filterLimit), at),
                  limited: filterLimit < at,
                },
              },
            },
          },
        });
        this.afterPositioningSync(ordinal);
        return res;
      }
      this.syncAttempts.push(Date.now());
      if (this.syncFailures > 0) {
        this.syncFailures--;
        if (this.syncFailureMode === 'network') throw new Error('fake network reset');
        return jsonRes({ errcode: 'M_FORBIDDEN', error: 'injected' }, this.syncFailureStatus);
      }
      const override = this.syncBodyOverrides.shift();
      if (override !== undefined) return jsonRes(override(syncRoom?.roomId ?? ''));
      const k = tokenPos(since);
      const cap = Math.min(filterLimit, this.syncCap);
      const newCount = len - k;
      const roomKey = syncRoom?.roomId ?? '';
      if (newCount <= 0) {
        return joined({
          next_batch: `p${k}`,
          rooms: { join: { [roomKey]: { timeline: { events: [], limited: false } } } },
        });
      }
      if (newCount <= cap) {
        return joined({
          next_batch: `p${len}`,
          rooms: { join: { [roomKey]: { timeline: { events: timeline.slice(k, len), limited: false } } } },
        });
      }
      // Burst larger than the effective per-sync cap: return only the newest `cap`, mark `limited`,
      // and expose a `prev_batch` that paginates BACKWARD over the omitted (older) events —
      // re-including `prevBatchOverlap` of the batch's own oldest events.
      this.limitedEmitted++;
      const startIdx = len - cap;
      return joined({
        next_batch: `p${len}`,
        rooms: {
          join: {
            [roomKey]: {
              timeline: {
                events: timeline.slice(startIdx, len),
                limited: true,
                prev_batch: `p${Math.min(startIdx + this.prevBatchOverlap, len)}`,
              },
            },
          },
        },
      });
    }

    return jsonRes({ errcode: 'M_UNRECOGNIZED', error: `unhandled ${method} ${path}` }, 404);
  };
}

const tokenPos = (t: string): number => Number(t.slice(1));

/** The access token this fake mints for `host` — what a request bearing it names as its issuer. */
export const tokenFor = (host: string): string => `tok-${host}`;

/** The `Authorization` header value a request authenticated against `host` must carry. */
export const bearerFor = (host: string): string => `Bearer ${tokenFor(host)}`;

/** The homeserver every fixture points at unless a case names another one. */
export const HOMESERVER_URL = 'https://synapse.fake';
/** A SECOND homeserver, for cases about what one host's credential may reach on another. */
export const OTHER_HOMESERVER_URL = 'https://other.fake';

export interface ConnectOptions {
  shared?: boolean;
  roomPreset?: RoomPreset;
  invite?: string[];
  syncTimeoutMs?: number;
  homeserverUrl?: string;
}

export const fakeConfig = (opts: ConnectOptions = {}): Record<string, unknown> => ({
  // https, so the fake fixture is not itself a config `connect()` must warn about: a SECURITY line
  // every case emits is one no case can grade, and it buries the ones a case arms deliberately.
  homeserver_url: opts.homeserverUrl ?? HOMESERVER_URL,
  server_name: SERVER_NAME,
  user: 'parley',
  password: 'a-real-test-secret',
  sync_timeout_ms: opts.syncTimeoutMs ?? 50,
  ...(opts.shared === true ? { shared_room: SHARED_LOCALPART } : {}),
  ...(opts.roomPreset !== undefined ? { room_preset: opts.roomPreset } : {}),
  ...(opts.invite !== undefined ? { invite: opts.invite } : {}),
});

export async function connectFake(opts: ConnectOptions = {}): Promise<MatrixPlugin> {
  const p = new MatrixPlugin();
  await p.connect(fakeConfig(opts));
  return p;
}
