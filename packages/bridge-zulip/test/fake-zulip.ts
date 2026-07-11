/**
 * An in-process fake Zulip server on `node:http` — just enough of the REST API for the
 * conformance suite: form-encoded writes (JSON bodies are REJECTED, mirroring real Zulip, to
 * keep the plugin honest), a global monotonic message id, anchor-based narrowed reads, and
 * per-queue long-polled event delivery with heartbeats.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

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
  eventSeq: number;
  events: QueueEvent[];
  waiter?: { res: ServerResponse; timer: NodeJS.Timeout };
}

/** Fixed directory for `GET /api/v1/users` (resolveIdentity tests). */
const MEMBERS = [
  { user_id: 10, email: 'parley-bot@localhost', full_name: 'Parley Bot', is_bot: true },
  { user_id: 11, email: 'pat@example.com', full_name: 'Pat Sharp', is_bot: false },
];

export interface FakeZulip {
  /** Base URL, e.g. `http://127.0.0.1:54321`. */
  url: string;
  /** Drop ALL event queues without notice (simulates Zulip's ~10-min-idle GC / a restart). */
  gcQueues(): void;
  /** Make the next `GET /api/v1/messages` fail once with a 502 (a transient history-read blip). */
  failNextMessagesRead(): void;
  /** Make the next `n` `GET /api/v1/messages` reads fail with a 502, then behave normally. */
  failMessagesReads(n: number): void;
  close(): Promise<void>;
}

export async function startFakeZulip(opts?: { heartbeatMs?: number }): Promise<FakeZulip> {
  const heartbeatMs = opts?.heartbeatMs ?? 10_000;
  let msgSeq = 0;
  let queueSeq = 0;
  let failMessagesReadsRemaining = 0; // GET /api/v1/messages fails (502) while > 0, then normal
  const messages: WireMessage[] = []; // ascending by id by construction
  const queues = new Map<string, Queue>();

  const dropWaiter = (q: Queue, destroy: boolean): void => {
    const w = q.waiter;
    if (w === undefined) return;
    q.waiter = undefined;
    clearTimeout(w.timer);
    if (destroy) w.res.destroy();
  };

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.writableEnded) json(res, 500, { result: 'error', msg: 'internal' });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://fake');
    const route = `${req.method} ${url.pathname}`;

    // Every real Zulip endpoint requires Basic auth; the sender is stamped from it.
    const auth = parseBasicAuth(req);
    if (auth === undefined) {
      json(res, 401, { result: 'error', msg: 'Unauthorized: HTTP Basic auth required' });
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

    switch (route) {
      case 'POST /api/v1/messages': {
        const to = form.get('to') ?? '';
        const topic = form.get('topic') ?? '';
        const msg: WireMessage = {
          id: ++msgSeq,
          type: 'stream',
          display_recipient: to,
          subject: topic,
          content: form.get('content') ?? '',
          sender_email: auth.email,
          sender_full_name: 'Parley Bot',
          timestamp: Math.floor(Date.now() / 1000),
        };
        messages.push(msg);
        // Fan out to matching queues; wake parked long-polls.
        for (const q of queues.values()) {
          if (q.stream !== to || q.topic !== topic) continue;
          q.events.push({ id: q.eventSeq++, type: 'message', message: msg });
          const w = q.waiter;
          if (w !== undefined) {
            q.waiter = undefined;
            clearTimeout(w.timer);
            json(w.res, 200, { result: 'success', events: q.events });
          }
        }
        json(res, 200, { result: 'success', id: msg.id });
        return;
      }

      case 'GET /api/v1/messages': {
        // Injected transient failure: a proxy 502 on the history read (gap-fill / fetchRecent).
        if (failMessagesReadsRemaining > 0) {
          failMessagesReadsRemaining--;
          json(res, 502, { result: 'error', msg: 'Bad gateway' });
          return;
        }
        const narrow = JSON.parse(url.searchParams.get('narrow') ?? '[]') as Array<{
          operator: string;
          operand: string;
        }>;
        const stream = narrow.find((n) => n.operator === 'stream')?.operand;
        const topic = narrow.find((n) => n.operator === 'topic')?.operand;
        const pool = messages.filter(
          (m) =>
            (stream === undefined || m.display_recipient === stream) &&
            (topic === undefined || m.subject === topic),
        );
        const anchorRaw = url.searchParams.get('anchor') ?? 'newest';
        const anchor = anchorRaw === 'newest' ? Number.POSITIVE_INFINITY : Number(anchorRaw);
        const includeAnchor = (url.searchParams.get('include_anchor') ?? 'true') === 'true';
        const numBefore = Number(url.searchParams.get('num_before') ?? '0');
        const numAfter = Number(url.searchParams.get('num_after') ?? '0');
        const before = numBefore > 0 ? pool.filter((m) => m.id < anchor).slice(-numBefore) : [];
        const at = includeAnchor ? pool.filter((m) => m.id === anchor) : [];
        const after = numAfter > 0 ? pool.filter((m) => m.id > anchor).slice(0, numAfter) : [];
        json(res, 200, { result: 'success', messages: [...before, ...at, ...after] });
        return;
      }

      case 'POST /api/v1/register': {
        const narrow = JSON.parse(form.get('narrow') ?? '[]') as Array<[string, string]>;
        const stream = narrow.find((n) => n[0] === 'stream')?.[1] ?? '';
        const topic = narrow.find((n) => n[0] === 'topic')?.[1] ?? '';
        const queueId = `fq-${++queueSeq}`;
        queues.set(queueId, { stream, topic, eventSeq: 0, events: [] });
        json(res, 200, { result: 'success', queue_id: queueId, last_event_id: -1 });
        return;
      }

      case 'GET /api/v1/events': {
        const queueId = url.searchParams.get('queue_id') ?? '';
        const lastEventId = Number(url.searchParams.get('last_event_id') ?? '-1');
        const q = queues.get(queueId);
        if (q === undefined) {
          json(res, 400, {
            result: 'error',
            code: 'BAD_EVENT_QUEUE_ID',
            queue_id: queueId,
            msg: `Bad event queue id: ${queueId}`,
          });
          return;
        }
        q.events = q.events.filter((e) => e.id > lastEventId); // ack/prune
        if (q.events.length > 0) {
          json(res, 200, { result: 'success', events: q.events });
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
        json(res, 200, { result: 'success', members: MEMBERS });
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
    failNextMessagesRead: () => {
      failMessagesReadsRemaining = 1;
    },
    failMessagesReads: (n: number) => {
      failMessagesReadsRemaining = n;
    },
    close: async () => {
      for (const q of queues.values()) dropWaiter(q, true);
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    },
  };
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
