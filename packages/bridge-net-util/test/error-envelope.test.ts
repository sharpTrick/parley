import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  delay,
  fetchWithRetry,
  MAX_ERROR_BODY,
  MAX_RESPONSE_BYTES,
  statusOf,
} from '@sharptrick/parley-net-util';

/**
 * A REAL server, not a `Response` stub. Every stub in this package hands back a fully-buffered
 * body, which is exactly why a body that arrives late — or not at all — is invisible to them: the
 * headers and the body are two separate events on the wire and only the first is under the
 * helper's error envelope in a stubbed world.
 */
type BodyBehaviour = 'complete' | 'stalls' | 'errors mid-stream';

let server: Server;
let origin: string;
let host: string;

/** Bytes FLUSHED to the socket per `tag` — i.e. roughly what the client actually took. */
const served = new Map<string, number>();
const CHUNK = 64 * 1024;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const status = Number(url.searchParams.get('status') ?? '200');
    const behaviour = (url.searchParams.get('body') ?? 'complete') as BodyBehaviour;
    const bytes = Number(url.searchParams.get('bytes') ?? '0');
    const tag = url.searchParams.get('tag') ?? '';
    res.writeHead(status, { 'content-type': 'text/plain' });
    if (bytes > 0) {
      // Backpressure-aware, so `served` tracks what the client CONSUMED (plus one socket buffer)
      // rather than what this handler queued — which is what discriminates a bounded read.
      const chunk = Buffer.alloc(CHUNK, 0x41);
      let queued = 0;
      let flushed = 0;
      const pump = (): void => {
        while (queued < bytes) {
          const n = Math.min(CHUNK, bytes - queued);
          queued += n;
          const more = res.write(chunk.subarray(0, n), () => {
            flushed += n;
            served.set(tag, flushed);
          });
          if (!more) {
            res.once('drain', pump);
            return;
          }
        }
        // `then=stall` never ends the body. Keep it, so that the bound below is CATEGORICAL: a
        // reader that waits for the stream to finish can only end on the deadline, whatever
        // threshold a byte count is compared against.
        if (url.searchParams.get('then') !== 'stall') res.end();
      };
      pump();
      return;
    }
    if (behaviour === 'complete') {
      res.end(`body-for-${status}`);
      return;
    }
    res.write('partial');
    if (behaviour === 'errors mid-stream') setTimeout(() => req.socket.destroy(), 20);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  host = `127.0.0.1:${addr.port}`;
  origin = `http://${host}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const LABEL = 'MyLabel GET /x';

type Outcome = { kind: 'resolved'; text: string } | { kind: 'rejected'; error: Error };

async function call(path: string, deadlineMs: number): Promise<Outcome> {
  try {
    const res = await fetchWithRetry(
      `${origin}${path}`,
      {},
      { label: LABEL, isStopped: () => false, deadlineMs, maxAttempts: 2 },
    );
    return { kind: 'resolved', text: await res.text() };
  } catch (err) {
    return { kind: 'rejected', error: err as Error };
  }
}

describe('nothing leaves this module outside the label + redact + sanitize envelope', () => {
  const statuses = [200, 404, 429, 500];
  const behaviours: BodyBehaviour[] = ['complete', 'stalls', 'errors mid-stream'];
  const rows = statuses.flatMap((status) => behaviours.map((body) => [status, body] as const));

  it.each(rows)('status %i with a body that %s', async (status, body) => {
    const outcome = await call(`/x?status=${status}&body=${body}`, 300);
    if (outcome.kind === 'rejected') {
      expect(outcome.error.message.startsWith(`${LABEL} → `)).toBe(true);
      expect(outcome.error.message).not.toContain(host);
      expect(outcome.error.message).not.toContain('127.0.0.1');
    } else {
      expect(status).toBe(200);
      expect(outcome.text).toBe('body-for-200');
    }
  });

  // The caller's OWN body read is where the deadline signal used to strike: it stayed armed after
  // fetchWithRetry had already returned a 200, so every consuming plugin's `res.json()` could
  // reject with a bare, unlabeled DOMException carrying none of the guarantees above.
  it('a returned 2xx can still be read long after the deadline has passed', async () => {
    const res = await fetchWithRetry(
      `${origin}/x?status=200&body=complete`,
      {},
      { label: LABEL, isStopped: () => false, deadlineMs: 60 },
    );
    await delay(200);
    await expect(res.text()).resolves.toBe('body-for-200');
  });

  /**
   * The cap used to be applied AFTER `res.text()` had buffered whatever the upstream sent, so a
   * hostile or broken server spent hundreds of megabytes of RSS and most of the deadline producing a
   * 2 KB message. Parameterized over the offered volume and asserted on RESOURCES, not only on the
   * message length: the message was always bounded, which is exactly why nothing went red.
   */
  describe('an untrusted body is bounded while it is read, not after', () => {
    const MB = 1024 * 1024;
    let seq = 0;

    const fetchBody = async (
      query: string,
      opts: { deadlineMs?: number; maxBodyBytes?: number; allowStatuses?: number[] } = {},
    ): Promise<{ outcome: Outcome; tookBytes: number; elapsedMs: number; rssGrowth: number }> => {
      const tag = `t${++seq}`;
      served.set(tag, 0);
      const rssBefore = process.memoryUsage().rss;
      const startedAt = Date.now();
      const outcome = await fetchWithRetry(
        `${origin}/x?${query}&tag=${tag}`,
        {},
        { label: LABEL, isStopped: () => false, maxAttempts: 1, ...opts },
      ).then<Outcome, Outcome>(
        async (res) => ({ kind: 'resolved', text: await res.text() }),
        (err: Error) => ({ kind: 'rejected', error: err }),
      );
      return {
        outcome,
        tookBytes: served.get(tag) ?? 0,
        elapsedMs: Date.now() - startedAt,
        rssGrowth: process.memoryUsage().rss - rssBefore,
      };
    };

    const DEADLINE_MS = 1_000;
    // Loopback plus the kernel send buffer absorb a few MB before the writer feels backpressure, so
    // this is the coarse memory bound; the CATEGORICAL one is the outcome shape against `then=stall`.
    const BUFFER_SLACK = 8 * MB;

    /**
     * The statuses the caller is NEVER handed, and whether the body becomes the error message. A
     * 429's body is only ever `retryAfterOf`'s input, so the rate limit's own diagnostic is what the
     * caller reads — but the read is bounded exactly as an error body's is.
     *
     * Crossed with the volume axis, because a status-specific exemption from the cap is invisible to
     * a table whose every row is one status: `keeps()` used to treat a 429 as a response the caller
     * might read, so the one status a hostile upstream controls and repeats pulled `maxBodyBytes`
     * (16 MiB by default) on every one of up to 8 attempts.
     */
    const DOOMED_STATUSES: [number, boolean][] = [
      [404, true],
      [429, false],
      [500, true],
    ];

    // A body BELOW the cap has nothing to truncate, so it ends the stream normally; the rows above
    // it never end, which is what makes the outcome shape decide the case rather than a threshold.
    const VOLUMES: [number, string][] = [
      [1024, 'end'],
      [4 * MB, 'stall'],
      [64 * MB, 'stall'],
    ];

    // A response that can only become an error message: the read must stop a few KB in, whatever the
    // upstream offers, and neither the outcome nor the time may depend on the offer.
    it.each(
      DOOMED_STATUSES.flatMap(([status, echoesBody]) =>
        VOLUMES.map(([bytes, then]) => [status, bytes, then, echoesBody] as const),
      ),
    )(
      'ends a doomed %i body of %i bytes (%s) on the cap, not on the deadline',
      async (status, bytes, then, echoesBody) => {
        const run = await fetchBody(`status=${status}&bytes=${bytes}&then=${then}`, {
          deadlineMs: DEADLINE_MS,
        });
        const message = (run.outcome as { error: Error }).error.message;
        expect(run.outcome.kind).toBe('rejected');
        // A reader that waits for the stream to END can only get here on the deadline signal.
        expect(message.startsWith(`${LABEL} → ${status}: `)).toBe(true);
        expect(message.length).toBeLessThanOrEqual(MAX_ERROR_BODY + 200);
        // A FLOOR as well as a ceiling: a read that gave up before taking anything would satisfy
        // every bound here while telling the operator nothing about why the upstream failed. A 429
        // takes the other side of it — its body reaches nobody, so it may not reach the message.
        if (echoesBody) expect(message).toContain('A');
        else expect(message).not.toContain('AAAA');
        expect(run.tookBytes).toBeGreaterThan(0);
        expect(run.tookBytes).toBeLessThan(BUFFER_SLACK);
        // Absolute, not `DEADLINE_MS`: a bound stated as the budget the call was handed says only
        // that the call ended, and moves whenever the budget does.
        expect(run.elapsedMs).toBeLessThan(2_000);
        expect(run.rssGrowth).toBeLessThan(32 * MB);
      },
    );

    // The other side of the same split: a status the caller DOES get back is read to `maxBodyBytes`,
    // including a 429 the caller declared expected — which the loop must hand over rather than
    // treat as its own retry material.
    it.each([200, 429])('reads a %i the caller is handed up to maxBodyBytes', async (status) => {
      const run = await fetchBody(`status=${status}&bytes=65536`, {
        maxBodyBytes: 256 * 1024,
        allowStatuses: [429],
      });
      expect(run.outcome.kind).toBe('resolved');
      expect((run.outcome as { text: string }).text).toHaveLength(65_536);
      expect(run.tookBytes).toBe(65_536);
    });

    // A body the caller WILL parse cannot be silently truncated — half a JSON document is a corrupt
    // parse, not a smaller one — so past `maxBodyBytes` the call fails, still under the label.
    it('hands back a 2xx body inside maxBodyBytes in full', async () => {
      const run = await fetchBody('status=200&bytes=65536', { maxBodyBytes: 256 * 1024 });
      expect(run.outcome.kind).toBe('resolved');
      expect((run.outcome as { text: string }).text).toHaveLength(65_536);
      expect(run.tookBytes).toBe(65_536);
    });

    /**
     * The DEFAULT ceiling — the one every consumer actually runs, since no shipped backend passes
     * `maxBodyBytes`. Every row above states its own, so cutting `MAX_RESPONSE_BYTES` to 1 KB left
     * this package green while failing 262 cases across 26 others: an ordinary Matrix `/sync` or
     * Slack `conversations.history` page stopped fitting. The volumes are ABSOLUTE — a plausible
     * catch-up page, and a body no page could be — so the default moving in either direction reddens
     * a row here instead of downstream.
     */
    const PLAUSIBLE_PAGE = 2 * MB;
    const PAST_ANY_PAGE = 24 * MB;

    it('the default straddles the two volumes below, so both of them grade it', () => {
      expect(PLAUSIBLE_PAGE).toBeLessThan(MAX_RESPONSE_BYTES);
      expect(PAST_ANY_PAGE).toBeGreaterThan(MAX_RESPONSE_BYTES);
    });

    it('hands back a plausible catch-up page in full with no maxBodyBytes set', async () => {
      const run = await fetchBody(`status=200&bytes=${PLAUSIBLE_PAGE}`, { deadlineMs: 10_000 });
      expect(run.outcome.kind).toBe('resolved');
      expect((run.outcome as { text: string }).text).toHaveLength(PLAUSIBLE_PAGE);
    });

    it('fails a body past the default maxBodyBytes under the label', async () => {
      const run = await fetchBody(`status=200&bytes=${PAST_ANY_PAGE}&then=stall`, {
        deadlineMs: 10_000,
      });
      expect(run.outcome.kind).toBe('rejected');
      expect((run.outcome as { error: Error }).error.message).toBe(
        `${LABEL} → body: response body exceeded ${MAX_RESPONSE_BYTES} bytes`,
      );
    });

    it.each([4 * MB, 64 * MB])('fails a 2xx body of %i bytes past maxBodyBytes under the label', async (bytes) => {
      const run = await fetchBody(`status=200&bytes=${bytes}&then=stall`, {
        maxBodyBytes: 256 * 1024,
        deadlineMs: DEADLINE_MS,
      });
      expect(run.outcome.kind).toBe('rejected');
      expect((run.outcome as { error: Error }).error.message).toBe(
        `${LABEL} → body: response body exceeded 262144 bytes`,
      );
      expect(run.tookBytes).toBeLessThan(BUFFER_SLACK);
      expect(run.elapsedMs).toBeLessThan(2_000);
    });
  });

  /**
   * The class the `<label> → <status>: <body>` envelope only covers one shape of: once a status has
   * been received, EVERY way the call can still fail must report it through `statusOf`. A caller
   * branching on 429 — Telegram's fatal-status branch, any backoff — silently stops firing the
   * moment one rejection shape drops the status, and the rejections that drop it are the ones an
   * upstream can produce at will: an oversized body and a body that dies mid-stream.
   */
  describe('a rejection after the status is known reports that status', () => {
    const OVERSIZED = [200, 404, 429];
    const MID_STREAM = [404, 429, 500];

    it.each([
      ...OVERSIZED.map((status) => ['an oversized body', status] as const),
      ...MID_STREAM.map((status) => ['a body that dies mid-stream', status] as const),
    ])('%s on a %i', async (shape, status) => {
      const query =
        shape === 'an oversized body'
          ? `status=${status}&bytes=1048576&then=stall`
          : `status=${status}&body=errors mid-stream`;
      const err = await fetchWithRetry(
        `${origin}/x?${query}`,
        {},
        {
          label: LABEL,
          isStopped: () => false,
          maxAttempts: 1,
          deadlineMs: 2_000,
          maxBodyBytes: 4096,
          allowStatuses: [404, 429],
        },
      ).then(
        () => undefined,
        (e: unknown) => e as Error,
      );
      expect(err, 'expected a rejection').toBeDefined();
      expect((err as Error).message.startsWith(`${LABEL} → `)).toBe(true);
      expect(statusOf(err)).toBe(status);
    });
  });

  it('preserves status, statusText and headers on the response it hands back', async () => {
    const res = await fetchWithRetry(
      `${origin}/x?status=200&body=complete`,
      {},
      { label: LABEL, isStopped: () => false, allowStatuses: [404] },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain');

    const missing = await fetchWithRetry(
      `${origin}/x?status=404&body=complete`,
      {},
      { label: LABEL, isStopped: () => false, allowStatuses: [404] },
    );
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe('body-for-404');
  });
});
