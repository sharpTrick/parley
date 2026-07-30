/**
 * An in-process fake Zulip server on `node:http` — a semantic MODEL of the REST API, not a
 * permissive echo: it enforces the documented server constraints the plugin must respect
 * ({@link SERVER_CONSTRAINTS}) so a plugin that ignores one fails here instead of only against a
 * real server. Form-encoded writes (JSON bodies are REJECTED), a global monotonic message id,
 * anchor-based narrowed reads, and per-queue long-polled event delivery with heartbeats.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * The real-server constraints this fake models, each traced to upstream Zulip. Tests read this
 * table so a constraint added here becomes a failing plugin test until the plugin honours it.
 */
export const SERVER_CONSTRAINTS = {
  /** `zerver/views/message_fetch.py` MAX_MESSAGES_PER_FETCH — larger is a 400. */
  maxMessagesPerFetch: 5000,
  /** `zerver/lib/message.py` MAX_TOPIC_NAME_LENGTH — longer subjects are truncated on send. */
  maxTopicNameLength: 60,
  /** `zerver/actions/message_send.py` TOPIC_TRUNCATION_MESSAGE. */
  topicTruncationSuffix: '...',
  /** `zerver/lib/topic.py` `Q(subject__iexact=…)` — topics (and streams) compare case-folded. */
  foldsTopicCase: true,
  /** Every endpoint requires HTTP Basic credentials that match a real bot account. */
  requiresValidCredentials: true,
  /**
   * `zerver/lib/request.py` defaults: a client that does not opt out gets RENDERED HTML content
   * (`apply_markdown`), the anchor message included in a narrowed read (`include_anchor`), and a
   * blocking events poll (`dont_block`). The first two are the WRONG value for this bridge; the third
   * already IS the value it wants, which is why a flag cannot be graded by behaviour alone — a
   * default that coincides with the bridge's choice makes omitting the flag indistinguishable from
   * sending it, until the day the server flips the default.
   */
  requestFlagDefaults: { apply_markdown: 'true', include_anchor: 'true', dont_block: 'false' },
} as const;

/**
 * Zulip's Markdown rendering, modelled just far enough that a client which forgets
 * `apply_markdown=false` gets HTML instead of source text and cannot mistake one for the other.
 */
export function renderMarkdown(source: string): string {
  const escaped = String(source).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<p>${escaped
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/@([\w.-]+)/g, '<span class="user-mention">@$1</span>')}</p>`;
}

interface WireMessage {
  id: number;
  type: 'stream';
  display_recipient: string;
  subject: string;
  content: string;
  sender_email: string;
  sender_full_name: string;
  timestamp: number;
}

interface QueueEvent {
  id: number;
  type: string;
  message?: WireMessage;
}

interface Queue {
  stream: string;
  topic: string;
  /** What the queue's `register` asked for — decides whether its events carry HTML or source. */
  applyMarkdown: boolean;
  eventSeq: number;
  events: QueueEvent[];
  waiter?: { res: ServerResponse; timer: NodeJS.Timeout };
}

export interface FakeMember {
  user_id: number;
  email: string;
  full_name: string;
  is_bot?: boolean;
  is_active?: boolean;
}

/** Default directory for `GET /api/v1/users` (resolveIdentity tests). */
const MEMBERS: FakeMember[] = [
  { user_id: 10, email: 'parley-bot@localhost', full_name: 'Parley Bot', is_bot: true },
  { user_id: 11, email: 'pat@example.com', full_name: 'Pat Sharp', is_bot: false },
];

/** One account per bot: a realm has many, and the sender is stamped from whichever authenticates. */
export interface FakeCredentials {
  email: string;
  apiKey: string;
}

const DEFAULT_CREDENTIALS: FakeCredentials[] = [
  { email: 'parley-bot@localhost', apiKey: 'parley-api-key' },
];

/**
 * A forced response for every request on a route, e.g. a revoked key (401) or an outage (500). The
 * status may be 200: a server answering a route with a well-formed HTTP 200 whose BODY is the wrong
 * shape is the hazard a status code cannot model.
 */
export interface RouteFailure {
  status: number;
  body?: Record<string, unknown>;
  /** Requests to answer this way before the route behaves normally again; omitted = until cleared. */
  times?: number;
}

/**
 * A run of 429s on a route. Zulip advertises its retry hint in BOTH the `Retry-After` header and a
 * `retry-after` JSON body field (seconds); either, both, or neither can be modelled here.
 */
export interface RateLimit {
  /** How many requests are rate limited before the route behaves normally. */
  times: number;
  headerSeconds?: number;
  bodySeconds?: number;
}

export interface FakeZulip {
  /** Base URL, e.g. `http://127.0.0.1:54321`. */
  url: string;
  /** Drop ALL event queues AND sever every parked poll (simulates a server restart). */
  gcQueues(): void;
  /**
   * Drop ALL event queues and answer every parked poll `BAD_EVENT_QUEUE_ID` — Zulip's ~10-min-idle
   * GC, which retires the queue but leaves the connection alive, so recovery starts from a clean
   * protocol error rather than a network failure.
   */
  expireQueues(): void;
  /** Make the next `GET /api/v1/messages` fail once with a 502 (a transient history-read blip). */
  failNextMessagesRead(): void;
  /** Make the next `n` `GET /api/v1/messages` reads fail with a 502, then behave normally. */
  failMessagesReads(n: number): void;
  /**
   * How many injected history-read failures the fake has actually SERVED. A test that arms one can
   * assert its fault was exercised rather than armed for a read the code under test never issues.
   */
  servedMessagesReadFailures(): number;
  /** Fail every request on `route` (e.g. `GET /api/v1/events`) until cleared. */
  failRoute(route: string, failure: RouteFailure): void;
  /**
   * Answer every `GET /api/v1/messages` with a FULL page — as many records as the request asked for
   * — whose every `id` is `edgeId`. A server whose pages do not move the anchor the client asked
   * from is what a read that navigates by the page's edge record can walk in circles on, and it is
   * NOT reachable by injecting records: the normal read filters strictly by id, so its pages always
   * advance however mangled the records in them are.
   */
  stallAnchor(edgeId: unknown): void;
  /** Accept every request on `route` and never answer it — an unreachable-but-open server. */
  hangRoute(route: string): void;
  /** Answer the next `times` requests on `route` with a 429 carrying the given retry hint(s). */
  rateLimit(route: string, limit: RateLimit): void;
  /**
   * Hold every answer on `route` for `ms` before writing it. The body is snapshotted when the
   * request is handled, so a message injected during the hold is NOT in that response — which is
   * what turns a handshake window into one a test can inject into deterministically.
   */
  holdResponse(route: string, ms: number): void;
  clearRouteFailures(): void;
  /** How many requests the fake has served for `route`. */
  requestCount(route: string): number;
  /**
   * The query and form parameters of every request received on `route`, in order — what the client
   * actually put on the wire, which is the only way to grade a flag whose server default happens to
   * equal the value the client wants.
   */
  sentParams(route: string): Array<Record<string, string>>;
  /** Called right after each request is answered — the injection point for handshake races. */
  setResponseHook(hook: ((route: string) => void) | undefined): void;
  /** Deliver a message without going through the plugin (a third party posting concurrently). */
  injectMessage(opts: { topic: string; content: string; stream?: string; sender?: string }): number;
  /**
   * Deliver a record whose FIELDS are not the wire types the plugin declares — a server version, a
   * proxy or a hostile realm member handing back a shape the type annotation promised could not
   * happen. It reaches the history read AND any queue narrowed to `topic`, so one injection grades
   * both the catch-up and the push path. Routing still uses `topic`, so the record lands where the
   * test expects however mangled its own fields are.
   */
  injectRaw(opts: { topic: string; fields: Record<string, unknown>; stream?: string }): void;
  close(): Promise<void>;
}

export async function startFakeZulip(opts?: {
  heartbeatMs?: number;
  members?: FakeMember[];
  /** Accounts the server accepts. A single object is the one-bot realm the other tests boot. */
  credentials?: FakeCredentials | FakeCredentials[];
}): Promise<FakeZulip> {
  const heartbeatMs = opts?.heartbeatMs ?? 10_000;
  const members = opts?.members ?? MEMBERS;
  const accounts = toArray(opts?.credentials) ?? DEFAULT_CREDENTIALS;
  let msgSeq = 0;
  let queueSeq = 0;
  let failMessagesReadsRemaining = 0; // GET /api/v1/messages fails (502) while > 0, then normal
  let failMessagesReadsServed = 0;
  const routeFailures = new Map<string, RouteFailure>();
  const rateLimits = new Map<string, RateLimit>();
  const routeDelays = new Map<string, number>();
  const hangRoutes = new Set<string>();
  let anchorStall: { edgeId: unknown } | undefined;
  const requestCounts = new Map<string, number>();
  const requestParams = new Map<string, Array<Record<string, string>>>();
  let responseHook: ((route: string) => void) | undefined;
  const messages: WireMessage[] = []; // ascending by id by construction
  const queues = new Map<string, Queue>();

  // Keep the coercion, so that a deliberately mangled routing field cannot make the FAKE throw and
  // report a plugin defect that is really a fixture defect.
  const fold = (s: string): string => String(s).toLowerCase();

  const dropWaiter = (q: Queue, destroy: boolean): void => {
    const w = q.waiter;
    if (w === undefined) return;
    q.waiter = undefined;
    clearTimeout(w.timer);
    if (destroy) w.res.destroy();
  };

  const wire = (m: WireMessage, applyMarkdown: boolean): WireMessage =>
    applyMarkdown ? { ...m, content: renderMarkdown(m.content) } : m;

  const eventsFor = (q: Queue): QueueEvent[] =>
    q.events.map((e) =>
      e.message === undefined ? e : { ...e, message: wire(e.message, q.applyMarkdown) },
    );

  const badQueue = (res: ServerResponse, queueId: string): void =>
    json(res, 400, {
      result: 'error',
      code: 'BAD_EVENT_QUEUE_ID',
      queue_id: queueId,
      msg: `Bad event queue id: ${queueId}`,
    });

  const append = (
    m: Omit<WireMessage, 'id' | 'type' | 'timestamp'>,
    fields?: Record<string, unknown>,
  ): number => {
    const routing = { stream: m.display_recipient, topic: m.subject };
    const msg = {
      ...m,
      id: ++msgSeq,
      type: 'stream',
      timestamp: Math.floor(Date.now() / 1000),
      ...fields,
    } as WireMessage;
    messages.push(msg);
    for (const q of queues.values()) {
      if (fold(q.stream) !== fold(routing.stream)) continue;
      if (fold(q.topic) !== fold(routing.topic)) continue;
      q.events.push({ id: q.eventSeq++, type: 'message', message: msg });
      const w = q.waiter;
      if (w !== undefined) {
        q.waiter = undefined;
        clearTimeout(w.timer);
        json(w.res, 200, { result: 'success', events: eventsFor(q) });
      }
    }
    return msg.id;
  };

  const server = createServer((req, res) => {
    const route = `${req.method} ${new URL(req.url ?? '/', 'http://fake').pathname}`;
    requestCounts.set(route, (requestCounts.get(route) ?? 0) + 1);
    const held = routeDelays.get(route);
    if (held !== undefined) holdWrites(res, held);
    void handle(req, res)
      .catch(() => {
        if (!res.writableEnded) json(res, 500, { result: 'error', msg: 'internal' });
      })
      .finally(() => responseHook?.(route));
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://fake');
    const route = `${req.method} ${url.pathname}`;
    const sent: Record<string, string> = Object.fromEntries(url.searchParams);
    requestParams.set(route, [...(requestParams.get(route) ?? []), sent]);

    // Every real Zulip endpoint requires Basic auth for a REAL account; the sender is stamped from it.
    const auth = parseBasicAuth(req);
    if (!accounts.some((a) => a.email === auth?.email && a.apiKey === auth.apiKey)) {
      json(res, 401, { result: 'error', msg: 'Invalid API key' });
      return;
    }

    if (hangRoutes.has(route)) return; // never answered — the socket just stays open

    const limit = rateLimits.get(route);
    if (limit !== undefined && limit.times > 0) {
      limit.times--;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (limit.headerSeconds !== undefined) headers['Retry-After'] = String(limit.headerSeconds);
      const body: Record<string, unknown> = { result: 'error', code: 'RATE_LIMIT_HIT' };
      if (limit.bodySeconds !== undefined) body['retry-after'] = limit.bodySeconds;
      if (!res.writableEnded && !res.destroyed) {
        res.writeHead(429, headers);
        res.end(JSON.stringify(body));
      }
      return;
    }

    const forced = routeFailures.get(route);
    if (forced !== undefined && (forced.times === undefined || forced.times > 0)) {
      if (forced.times !== undefined) forced.times--;
      json(res, forced.status, forced.body ?? { result: 'error', msg: `forced ${forced.status}` });
      return;
    }

    // Real Zulip rejects JSON request bodies — so does the fake, to keep the plugin honest.
    const contentType = req.headers['content-type'] ?? '';
    if (contentType.includes('application/json')) {
      json(res, 400, {
        result: 'error',
        msg: 'JSON bodies are not supported; use application/x-www-form-urlencoded',
      });
      return;
    }
    const form = new URLSearchParams(await readBody(req));
    Object.assign(sent, Object.fromEntries(form));

    switch (route) {
      case 'POST /api/v1/messages': {
        const id = append({
          display_recipient: form.get('to') ?? '',
          subject: truncateTopic(form.get('topic') ?? ''), // the server rewrites over-long topics
          content: form.get('content') ?? '',
          sender_email: auth.email,
          sender_full_name: 'Parley Bot',
        });
        json(res, 200, { result: 'success', id });
        return;
      }

      case 'GET /api/v1/messages': {
        // Injected transient failure: a proxy 502 on the history read (gap-fill / fetchRecent).
        if (failMessagesReadsRemaining > 0) {
          failMessagesReadsRemaining--;
          failMessagesReadsServed++;
          json(res, 502, { result: 'error', msg: 'Bad gateway' });
          return;
        }
        const numBefore = Number(url.searchParams.get('num_before') ?? '0');
        const numAfter = Number(url.searchParams.get('num_after') ?? '0');
        if (numBefore + numAfter > SERVER_CONSTRAINTS.maxMessagesPerFetch) {
          json(res, 400, {
            result: 'error',
            code: 'BAD_REQUEST',
            msg: `Too many messages requested (maximum ${SERVER_CONSTRAINTS.maxMessagesPerFetch}).`,
          });
          return;
        }
        const narrow = JSON.parse(url.searchParams.get('narrow') ?? '[]') as Array<{
          operator: string;
          operand: string;
        }>;
        const stream = narrow.find((n) => n.operator === 'stream')?.operand;
        const topic = narrow.find((n) => n.operator === 'topic')?.operand;
        if (anchorStall !== undefined) {
          const page = numBefore + numAfter;
          json(res, 200, {
            result: 'success',
            messages: Array.from({ length: page }, () => ({
              id: anchorStall?.edgeId,
              type: 'stream',
              display_recipient: stream ?? 'parley',
              subject: topic ?? '',
              content: 'stalled',
              sender_email: 'someone@example.com',
              sender_full_name: 'Someone Else',
              timestamp: Math.floor(Date.now() / 1000),
            })),
          });
          return;
        }
        const pool = messages.filter(
          (m) =>
            (stream === undefined || fold(m.display_recipient) === fold(stream)) &&
            (topic === undefined || fold(m.subject) === fold(topic)),
        );
        const anchorRaw = url.searchParams.get('anchor') ?? 'newest';
        const anchor = anchorRaw === 'newest' ? Number.POSITIVE_INFINITY : Number(anchorRaw);
        const includeAnchor = (url.searchParams.get('include_anchor') ?? 'true') === 'true';
        const before = numBefore > 0 ? pool.filter((m) => m.id < anchor).slice(-numBefore) : [];
        const at = includeAnchor ? pool.filter((m) => m.id === anchor) : [];
        const after = numAfter > 0 ? pool.filter((m) => m.id > anchor).slice(0, numAfter) : [];
        const applyMarkdown = flagIsTrue(url.searchParams.get('apply_markdown'), 'apply_markdown');
        json(res, 200, {
          result: 'success',
          messages: [...before, ...at, ...after].map((m) => wire(m, applyMarkdown)),
        });
        return;
      }

      case 'POST /api/v1/register': {
        const narrow = JSON.parse(form.get('narrow') ?? '[]') as Array<[string, string]>;
        const stream = narrow.find((n) => n[0] === 'stream')?.[1] ?? '';
        const topic = narrow.find((n) => n[0] === 'topic')?.[1] ?? '';
        const queueId = `fq-${++queueSeq}`;
        queues.set(queueId, {
          stream,
          topic,
          applyMarkdown: flagIsTrue(form.get('apply_markdown'), 'apply_markdown'),
          eventSeq: 0,
          events: [],
        });
        json(res, 200, { result: 'success', queue_id: queueId, last_event_id: -1 });
        return;
      }

      case 'GET /api/v1/events': {
        const queueId = url.searchParams.get('queue_id') ?? '';
        const lastEventId = Number(url.searchParams.get('last_event_id') ?? '-1');
        const q = queues.get(queueId);
        if (q === undefined) {
          badQueue(res, queueId);
          return;
        }
        q.events = q.events.filter((e) => e.id > lastEventId); // ack/prune
        if (q.events.length > 0) {
          json(res, 200, { result: 'success', events: eventsFor(q) });
          return;
        }
        // `dont_block=true` returns whatever is queued RIGHT NOW — a client that sends it gets an
        // empty answer at once instead of push, which is a spin, not a long-poll.
        if (flagIsTrue(url.searchParams.get('dont_block'), 'dont_block')) {
          json(res, 200, { result: 'success', events: [] });
          return;
        }
        // Park until a message wakes us or the heartbeat interval elapses.
        const timer = setTimeout(() => {
          q.waiter = undefined;
          json(res, 200, {
            result: 'success',
            events: [{ id: q.eventSeq++, type: 'heartbeat' }],
          });
        }, heartbeatMs);
        dropWaiter(q, true); // at most one parked poll per queue
        q.waiter = { res, timer };
        res.on('close', () => {
          if (q.waiter?.res === res) {
            clearTimeout(q.waiter.timer);
            q.waiter = undefined;
          }
        });
        return;
      }

      case 'DELETE /api/v1/events': {
        const queueId = url.searchParams.get('queue_id') ?? form.get('queue_id') ?? '';
        const q = queues.get(queueId);
        if (q !== undefined) dropWaiter(q, true);
        queues.delete(queueId);
        json(res, 200, { result: 'success' });
        return;
      }

      case 'GET /api/v1/users': {
        json(res, 200, { result: 'success', members });
        return;
      }

      default:
        json(res, 404, { result: 'error', msg: `no such route: ${route}` });
    }
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    gcQueues: () => {
      // Silently drop queues AND sever parked polls — like a server restart. The client's next
      // poll gets BAD_EVENT_QUEUE_ID and must re-register + gap-fill.
      for (const q of queues.values()) dropWaiter(q, true);
      queues.clear();
    },
    expireQueues: () => {
      for (const q of queues.values()) {
        const w = q.waiter;
        dropWaiter(q, false);
        if (w !== undefined) badQueue(w.res, '(expired)');
      }
      queues.clear();
    },
    failNextMessagesRead: () => {
      failMessagesReadsRemaining = 1;
    },
    failMessagesReads: (n: number) => {
      failMessagesReadsRemaining = n;
    },
    servedMessagesReadFailures: () => failMessagesReadsServed,
    failRoute: (route, failure) => {
      routeFailures.set(route, { ...failure });
      for (const q of queues.values()) dropWaiter(q, true);
    },
    hangRoute: (route) => hangRoutes.add(route),
    stallAnchor: (edgeId) => {
      anchorStall = { edgeId };
    },
    rateLimit: (route, limit) => rateLimits.set(route, { ...limit }),
    holdResponse: (route, ms) => routeDelays.set(route, ms),
    clearRouteFailures: () => {
      routeFailures.clear();
      rateLimits.clear();
      routeDelays.clear();
      hangRoutes.clear();
      anchorStall = undefined;
    },
    requestCount: (route) => requestCounts.get(route) ?? 0,
    sentParams: (route) => [...(requestParams.get(route) ?? [])],
    setResponseHook: (hook) => {
      responseHook = hook;
    },
    injectMessage: ({ topic, content, stream, sender }) =>
      append({
        display_recipient: stream ?? 'parley',
        subject: truncateTopic(topic),
        content,
        sender_email: sender ?? 'someone@example.com',
        sender_full_name: 'Someone Else',
      }),
    injectRaw: ({ topic, fields, stream }) => {
      append(
        {
          display_recipient: stream ?? 'parley',
          subject: truncateTopic(topic),
          content: 'well-formed',
          sender_email: 'someone@example.com',
          sender_full_name: 'Someone Else',
        },
        fields,
      );
    },
    close: async () => {
      for (const q of queues.values()) dropWaiter(q, true);
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    },
  };
}

function toArray(v: FakeCredentials | FakeCredentials[] | undefined): FakeCredentials[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

/** A request flag read the way Zulip reads it: absent means the documented server DEFAULT. */
function flagIsTrue(raw: string | null, flag: keyof typeof SERVER_CONSTRAINTS.requestFlagDefaults): boolean {
  return (raw ?? SERVER_CONSTRAINTS.requestFlagDefaults[flag]) === 'true';
}

/** Zulip stores at most 60 characters of subject, replacing the tail with an ellipsis. */
function truncateTopic(topic: string): string {
  const chars = [...topic];
  if (chars.length <= SERVER_CONSTRAINTS.maxTopicNameLength) return topic;
  const suffix = SERVER_CONSTRAINTS.topicTruncationSuffix;
  return chars.slice(0, SERVER_CONSTRAINTS.maxTopicNameLength - suffix.length).join('') + suffix;
}

/**
 * Buffer this response's status and body and flush them `ms` later, so the answer is computed at
 * request time but delivered late — the only way a test can inject into a window the client is
 * already inside.
 */
function holdWrites(res: ServerResponse, ms: number): void {
  const writeHead = res.writeHead.bind(res);
  const end = res.end.bind(res);
  let head: { status: number; headers: Record<string, string> } | undefined;
  res.writeHead = ((status: number, headers?: Record<string, string>) => {
    head = { status, headers: headers ?? {} };
    return res;
  }) as typeof res.writeHead;
  res.end = ((body?: unknown) => {
    setTimeout(() => {
      if (res.destroyed) return;
      if (head !== undefined) writeHead(head.status, head.headers);
      end(body as string);
    }, ms);
    return res;
  }) as typeof res.end;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function parseBasicAuth(req: IncomingMessage): { email: string; apiKey: string } | undefined {
  const header = req.headers.authorization;
  if (header === undefined || !header.startsWith('Basic ')) return undefined;
  const [email, apiKey] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
  if (email === undefined || apiKey === undefined) return undefined;
  return { email, apiKey };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
