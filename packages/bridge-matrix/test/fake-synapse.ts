import { MatrixPlugin } from '../src/index.js';

/**
 * In-memory fake Synapse: a `global.fetch` stub modelling ONE room's timeline plus Matrix
 * pagination tokens, alias directory, room creation, and injectable `/sync` failures. Shared by
 * every Matrix test file so a behavior proven here is proven against the real plugin code paths
 * (`fetchRecent` / `subscribe` / `backfill` / `ensureRoom`), not against a mock of them.
 *
 * Pagination-token model: a token `p<n>` is a boundary index into the timeline array.
 *   dir=f from p<n> → timeline[n], timeline[n+1], … ascending; end = p<n+count>
 *   dir=b from p<n> → timeline[n-1], timeline[n-2], … newest-first; end = p<n-count>
 *   /context/<id> → { start:p<i>, end:p<i> } (end re-includes the since event — the mid-stream case)
 *
 * The fake deliberately IGNORES the server-side `filter` on `/messages`, so client-side topic/type
 * filtering stays under test even though production offloads part of it to the homeserver.
 */

export const TOPIC_KEY = 'app.parley.topic';
export const ROOM_ID = '!room:fake';

export interface Ev {
  type: unknown;
  event_id: unknown;
  sender: unknown;
  origin_server_ts: unknown;
  content: unknown;
}

const jsonRes = (obj: unknown, status = 200): Response =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

export class FakeSynapse {
  timeline: Ev[] = [];
  private counter = 0;
  /** How many events an incremental /sync will return before it truncates with `limited:true`. */
  syncCap = 100;
  /** Number of `limited:true` incremental syncs emitted — proves the backfill path was exercised. */
  limitedEmitted = 0;
  /** False → `/directory/room/<alias>` 404s, forcing `POST /createRoom` (provisioning path). */
  aliasExists = true;
  /** Every `POST /createRoom` body, in order — an ATTEMPT is recorded even when it is refused. */
  readonly createRoomBodies: Record<string, unknown>[] = [];
  /** Remaining `POST /createRoom` calls to refuse with 429 — the per-user creation budget, spent. */
  createRoomLimited = 0;
  createRoomRetryAfterMs = 45_000;
  /** Every `PUT .../send/m.room.message/<txn>` body, in order. */
  readonly sentBodies: Record<string, unknown>[] = [];
  /** Remaining incremental-`/sync` calls to fail (`Infinity` = a permanent failure). */
  syncFailures = 0;
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
   * Called with each `/messages` request AFTER its response body has been computed and BEFORE that
   * body is returned; the returned ms hold the response in flight. Lets a case land an event in the
   * window where a reader has already snapshotted its (empty) result — the lost-wakeup shape — or
   * stall one specific read (the `limited`-burst backfill) without touching the others.
   */
  holdMessages: (url: URL, body: { chunk: Ev[] }) => number = () => 0;

  private ev(type: string, content: Record<string, unknown>): Ev {
    const e: Ev = {
      type,
      event_id: `$e${this.counter}:fake`,
      sender: '@parley:fake',
      origin_server_ts: 1_700_000_000_000 + this.counter,
      content,
    };
    this.counter++;
    this.timeline.push(e);
    return e;
  }

  /** Inject a message from a "foreign" client (simulates a post that landed between polls). */
  addMessage(topic: string, body: string): Ev {
    return this.ev('m.room.message', { msgtype: 'm.text', body, [TOPIC_KEY]: topic });
  }

  /** Inject a non-`m.room.message` event (reaction / membership churn). */
  addRaw(type: string): Ev {
    return this.ev(type, {});
  }

  /**
   * Inject an `m.room.message` whose fields carry arbitrary JSON. Synapse enforces no schema on
   * event content, so any room member can send these — they are what the plugin actually reads.
   */
  addHostile(fields: Partial<Ev>): Ev {
    const e = this.ev('m.room.message', { msgtype: 'm.text', body: 'hostile' });
    Object.assign(e, fields);
    return e;
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // Yield to the macrotask queue on every request so the subscribe() poll loop (no delay on its
    // success path) can never starve vitest's timer-based vi.waitFor.
    await new Promise((r) => setTimeout(r, 1));
    const url = new URL(typeof input === 'string' ? input : ((input as Request).url ?? String(input)));
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.pathname;
    this.onRequest(method, path);

    if (path.endsWith('/v3/login')) return jsonRes({ access_token: 'tok', user_id: '@parley:fake' });
    if (path.includes('/v3/directory/room/')) {
      return this.aliasExists
        ? jsonRes({ room_id: ROOM_ID })
        : jsonRes({ errcode: 'M_NOT_FOUND', error: 'room alias not found' }, 404);
    }
    if (path.endsWith('/v3/createRoom')) {
      this.createRoomBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      if (this.createRoomLimited > 0) {
        this.createRoomLimited--;
        return jsonRes(
          { errcode: 'M_LIMIT_EXCEEDED', error: 'Too many requests', retry_after_ms: this.createRoomRetryAfterMs },
          429,
        );
      }
      this.aliasExists = true;
      return jsonRes({ room_id: ROOM_ID });
    }
    if (path.endsWith('/join')) return jsonRes({ room_id: ROOM_ID });

    if (method === 'PUT' && /\/rooms\/[^/]+\/send\/m\.room\.message\//.test(path)) {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      this.sentBodies.push(body);
      const e = this.ev('m.room.message', {
        msgtype: 'm.text',
        body: body.body,
        [TOPIC_KEY]: body[TOPIC_KEY],
        ...(body['m.relates_to'] !== undefined ? { 'm.relates_to': body['m.relates_to'] } : {}),
      });
      return jsonRes({ event_id: e.event_id });
    }

    const ctx = path.match(/\/rooms\/[^/]+\/context\/([^/]+)$/);
    if (ctx) {
      const evId = decodeURIComponent(ctx[1]!);
      const idx = this.timeline.findIndex((e) => e.event_id === evId);
      if (idx < 0) return jsonRes({ errcode: 'M_NOT_FOUND', error: 'event not found' }, 404);
      return jsonRes({ start: `p${idx}`, end: `p${idx}`, event: this.timeline[idx] });
    }
    // An EMPTY cursor degenerates to `/context/` with no event id — Synapse answers 404 there, and
    // the plugin must never mint such a cursor (it decodes as "expired" and truncates the stream).
    if (/\/rooms\/[^/]+\/context\/?$/.test(path)) {
      return jsonRes({ errcode: 'M_NOT_FOUND', error: 'no event id' }, 404);
    }

    if (/\/rooms\/[^/]+\/messages$/.test(path)) {
      if (this.messagesFailures > 0) {
        this.messagesFailures--;
        if (this.messagesFailureMode === 'network') throw new Error('fake network reset');
        return jsonRes({ errcode: 'M_UNKNOWN', error: 'injected' }, this.messagesFailureStatus);
      }
      const dir = url.searchParams.get('dir');
      const limit = Number(url.searchParams.get('limit') ?? '10');
      const from = url.searchParams.get('from');
      const body = ((): { chunk: Ev[]; start: string; end: string } => {
        if (dir === 'f') {
          const b = from ? tokenPos(from) : 0;
          const chunk = this.timeline.slice(b, b + limit);
          return { chunk, start: `p${b}`, end: `p${b + chunk.length}` };
        }
        // dir=b (default for recentWindow — no `from` → newest-first from the tail).
        const b = from ? tokenPos(from) : this.timeline.length;
        const start = Math.max(0, b - limit);
        return { chunk: this.timeline.slice(start, b).reverse(), start: `p${b}`, end: `p${start}` };
      })();
      const hold = this.holdMessages(url, body);
      if (hold > 0) await new Promise((r) => setTimeout(r, hold));
      return jsonRes(body);
    }

    if (path.endsWith('/v3/sync')) {
      const since = url.searchParams.get('since');
      const filter = JSON.parse(url.searchParams.get('filter') ?? '{}') as {
        room?: { timeline?: { limit?: number } };
      };
      const filterLimit = filter.room?.timeline?.limit ?? 0;
      const len = this.timeline.length;
      if (since === null) {
        // Initial positioning sync (timeline limit 0) — skip history, just hand back a resume token.
        const ordinal = ++this.positioningSyncs;
        if (this.stallPositioning(ordinal)) {
          this.stalledPositioning.push(ordinal);
          this.duringPositioningStall(ordinal);
          await new Promise((r) => setTimeout(r, this.stallPositioningMs));
        }
        const at = this.timeline.length;
        return jsonRes({ next_batch: `p${at}`, rooms: { join: { [ROOM_ID]: { timeline: { events: [], limited: false } } } } });
      }
      this.syncAttempts.push(Date.now());
      if (this.syncFailures > 0) {
        this.syncFailures--;
        if (this.syncFailureMode === 'network') throw new Error('fake network reset');
        return jsonRes({ errcode: 'M_FORBIDDEN', error: 'injected' }, this.syncFailureStatus);
      }
      const k = tokenPos(since);
      const cap = Math.min(filterLimit, this.syncCap);
      const newCount = len - k;
      if (newCount <= 0) {
        return jsonRes({ next_batch: `p${k}`, rooms: { join: { [ROOM_ID]: { timeline: { events: [], limited: false } } } } });
      }
      if (newCount <= cap) {
        const events = this.timeline.slice(k, len);
        return jsonRes({ next_batch: `p${len}`, rooms: { join: { [ROOM_ID]: { timeline: { events, limited: false } } } } });
      }
      // Burst larger than the effective per-sync cap: return only the newest `cap`, mark `limited`,
      // and expose a `prev_batch` that paginates BACKWARD over the omitted (older) events.
      this.limitedEmitted++;
      const startIdx = len - cap;
      const events = this.timeline.slice(startIdx, len);
      return jsonRes({
        next_batch: `p${len}`,
        rooms: { join: { [ROOM_ID]: { timeline: { events, limited: true, prev_batch: `p${startIdx}` } } } },
      });
    }

    return jsonRes({ errcode: 'M_UNRECOGNIZED', error: `unhandled ${method} ${path}` }, 404);
  };
}

const tokenPos = (t: string): number => Number(t.slice(1));

export interface ConnectOptions {
  shared?: boolean;
  roomPreset?: 'private_chat' | 'trusted_private_chat' | 'public_chat';
  invite?: string[];
  syncTimeoutMs?: number;
}

export const fakeConfig = (opts: ConnectOptions = {}): Record<string, unknown> => ({
  homeserver_url: 'http://synapse.fake',
  server_name: 'fake',
  user: 'parley',
  password: 'a-real-test-secret',
  sync_timeout_ms: opts.syncTimeoutMs ?? 50,
  ...(opts.shared === true ? { shared_room: 'parley_conformance' } : {}),
  ...(opts.roomPreset !== undefined ? { room_preset: opts.roomPreset } : {}),
  ...(opts.invite !== undefined ? { invite: opts.invite } : {}),
});

export async function connectFake(opts: ConnectOptions = {}): Promise<MatrixPlugin> {
  const p = new MatrixPlugin();
  await p.connect(fakeConfig(opts));
  return p;
}
