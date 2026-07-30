import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { delay, fetchWithRetry, MAX_ERROR_BODY } from '@sharptrick/parley-net-util';

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
      opts: { deadlineMs?: number; maxBodyBytes?: number } = {},
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

    // A response that can only become an error message: the read must stop a few KB in, whatever the
    // upstream offers, and neither the outcome nor the time may depend on the offer.
    // A body BELOW the cap has nothing to truncate, so it ends the stream normally; the rows above
    // it never end, which is what makes the outcome shape decide the case rather than a threshold.
    it.each([
      [1024, 'end'],
      [4 * MB, 'stall'],
      [64 * MB, 'stall'],
    ] as const)(
      'ends a doomed body of %i bytes (%s) on the cap, not on the deadline',
      async (bytes, then) => {
        const run = await fetchBody(`status=500&bytes=${bytes}&then=${then}`, {
          deadlineMs: DEADLINE_MS,
        });
        const message = (run.outcome as { error: Error }).error.message;
        expect(run.outcome.kind).toBe('rejected');
        // A reader that waits for the stream to END can only get here on the deadline signal.
        expect(message.startsWith(`${LABEL} → 500: `)).toBe(true);
        expect(message.length).toBeLessThanOrEqual(MAX_ERROR_BODY + 200);
        // A FLOOR as well as a ceiling: a read that gave up before taking anything would satisfy
        // every bound here while telling the operator nothing about why the upstream failed.
        expect(message).toContain('A');
        expect(run.tookBytes).toBeGreaterThan(0);
        expect(run.tookBytes).toBeLessThan(BUFFER_SLACK);
        expect(run.elapsedMs).toBeLessThan(DEADLINE_MS);
        expect(run.rssGrowth).toBeLessThan(32 * MB);
      },
    );

    // A body the caller WILL parse cannot be silently truncated — half a JSON document is a corrupt
    // parse, not a smaller one — so past `maxBodyBytes` the call fails, still under the label.
    it('hands back a 2xx body inside maxBodyBytes in full', async () => {
      const run = await fetchBody('status=200&bytes=65536', { maxBodyBytes: 256 * 1024 });
      expect(run.outcome.kind).toBe('resolved');
      expect((run.outcome as { text: string }).text).toHaveLength(65_536);
      expect(run.tookBytes).toBe(65_536);
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
      expect(run.elapsedMs).toBeLessThan(DEADLINE_MS);
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
