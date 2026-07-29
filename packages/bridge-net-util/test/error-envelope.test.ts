import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { delay, fetchWithRetry } from '@sharptrick/parley-net-util';

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

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const status = Number(url.searchParams.get('status') ?? '200');
    const behaviour = (url.searchParams.get('body') ?? 'complete') as BodyBehaviour;
    res.writeHead(status, { 'content-type': 'text/plain' });
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
