/**
 * L2 verifier drive-tests for work item 01 (shared-http-retry-util):
 *   - BUG-41: a Slack 429 with NO `Retry-After` header must back off the 500 ms default,
 *     never `delay(0)` (the old inline parser's 0 ms tight loop).
 *   - BUG-25: Slack `api()` must form-encode every method so read-method args
 *     (`channel`/`oldest`/`cursor`/`email`) survive — the old `application/json` body was
 *     silently ignored by slack.com for read methods.
 *
 * These stand up purpose-built in-process HTTP fakes (not the conformance FakeSlack) so we can
 * return a header-less 429 and capture the exact Content-Type + raw bytes the plugin sends, and
 * DRIVE the real SlackPlugin.post/fetchRecent/resolveIdentity code paths.
 */
import { asCursor, asHandle, asTopic } from '@sharptrick/parley-core';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { SlackPlugin } from '../src/index.js';

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return `http://127.0.0.1:${port}/api`;
}

const stop = (server: Server): Promise<void> =>
  new Promise<void>((r) => server.close(() => r()));

describe('BUG-41 — header-less 429 backs off the 500 ms default (no 0 ms hot loop)', () => {
  it('documents the fix delta: old inline parser → 0 ms; guarded contract → 500 ms', () => {
    // Old (buggy) inline logic: Number(null) === 0, Number.isFinite(0) === true, so it took the
    // honor-the-header branch → Math.min(0 * 1000, 5000) === 0 → delay(0) → tight loop.
    const oldBuggy = (h: number): number =>
      Number.isFinite(h) ? Math.min(h * 1000, 5000) : 500;
    expect(oldBuggy(Number(null))).toBe(0); // absent header
    expect(oldBuggy(Number(''))).toBe(0); // empty header

    // New unified-contract guard (mirrors src readRetryAfter): only honor a positive finite value.
    const guarded = (h: number): number =>
      Number.isFinite(h) && h > 0 ? Math.min(h * 1000, 5000) : 500;
    expect(guarded(Number(null))).toBe(500);
    expect(guarded(Number(''))).toBe(500);
    expect(guarded(2)).toBe(2000); // a real positive header is still honored
    expect(guarded(9999)).toBe(5000); // still capped at 5 s
  });

  it('waits ~500 ms between retries when the 429 carries no Retry-After header', async () => {
    const arrivals: number[] = [];
    let calls = 0;
    const server = createServer((req, res) => {
      void (async () => {
        await readBody(req);
        arrivals.push(Date.now());
        calls++;
        if (calls <= 2) {
          // 429 with DELIBERATELY no Retry-After header — the BUG-41 trigger.
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'ratelimited' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ts: '1700000000.000001' }));
      })();
    });
    const url = await listen(server);
    const plugin = new SlackPlugin();
    try {
      await plugin.connect({ api_url: url, bot_token: 'xoxb-test' });
      const t0 = Date.now();
      const id = await plugin.post(asTopic('C0TEST'), asHandle('writer'), 'hello');
      const total = Date.now() - t0;

      expect(String(id)).toBe('1700000000.000001');
      expect(calls).toBe(3); // two header-less 429s, then success

      const gap1 = arrivals[1] - arrivals[0];
      const gap2 = arrivals[2] - arrivals[1];
      // A delay(0) hot loop would gap ~0–5 ms; the guarded default gaps ~500 ms.
      expect(gap1).toBeGreaterThanOrEqual(400);
      expect(gap2).toBeGreaterThanOrEqual(400);
      // ...and it's the 500 ms default, not the 5 s cap.
      expect(gap1).toBeLessThan(1500);
      expect(gap2).toBeLessThan(1500);
      expect(total).toBeGreaterThanOrEqual(800);
    } finally {
      await plugin.disconnect();
      await stop(server);
    }
  });
});

describe('BUG-25 — Slack api() form-encodes every method (read-method args survive)', () => {
  it('fetchRecent → conversations.history is form-encoded with channel/oldest args', async () => {
    let captured: { contentType?: string; raw: string } | undefined;
    const server = createServer((req, res) => {
      void (async () => {
        const raw = await readBody(req);
        const method = (req.url ?? '').slice('/api/'.length);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (method === 'conversations.history') {
          captured = { contentType: req.headers['content-type'], raw };
          const p = new URLSearchParams(raw);
          // A regression to a JSON body → URLSearchParams finds no `channel` → invalid_arguments,
          // exactly as slack.com behaves — which is what makes BUG-25 CI-observable.
          if (p.get('channel') === null) {
            res.end(JSON.stringify({ ok: false, error: 'invalid_arguments' }));
            return;
          }
          res.end(
            JSON.stringify({
              ok: true,
              messages: [{ type: 'message', ts: '1700000000.000002', text: 'hi', user: 'U0X' }],
              response_metadata: { next_cursor: '' },
            }),
          );
          return;
        }
        res.end(JSON.stringify({ ok: false, error: 'unknown_method' }));
      })();
    });
    const url = await listen(server);
    const plugin = new SlackPlugin();
    try {
      await plugin.connect({ api_url: url, bot_token: 'xoxb-test' });
      const result = await plugin.fetchRecent({
        topic: asTopic('C0ROOM'),
        since: asCursor('1699999999.000000'),
        limit: 10,
      });

      expect(captured).toBeDefined();
      expect(captured?.contentType).toContain('application/x-www-form-urlencoded');
      const parsed = new URLSearchParams(captured!.raw);
      expect(parsed.get('channel')).toBe('C0ROOM'); // the arg that JSON-body would have dropped
      expect(parsed.get('oldest')).toBe('1699999999.000000'); // exclusive `since`, survived
      // The bytes on the wire are form-encoded, NOT JSON — proving no application/json path remains.
      expect(() => JSON.parse(captured!.raw) as unknown).toThrow();
      expect(result.messages.map((m) => m.content)).toEqual(['hi']);
    } finally {
      await plugin.disconnect();
      await stop(server);
    }
  });

  it('resolveIdentity → users.lookupByEmail form-encodes `email` → resolves the real id', async () => {
    let sawEmailArg = false;
    const server = createServer((req, res) => {
      void (async () => {
        const raw = await readBody(req);
        const p = new URLSearchParams(raw);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // Only a form-parsed `email` resolves; a JSON body yields no `email` here → users_not_found
        // → the plugin's silent try/catch passthrough (the BUG-25 mis-resolution casualty).
        if (p.get('email') === 'alice@example.com') {
          sawEmailArg = true;
          res.end(JSON.stringify({ ok: true, user: { id: 'U0ALICE' } }));
        } else {
          res.end(JSON.stringify({ ok: false, error: 'users_not_found' }));
        }
      })();
    });
    const url = await listen(server);
    const plugin = new SlackPlugin();
    try {
      await plugin.connect({ api_url: url, bot_token: 'xoxb-test' });
      const identity = await plugin.resolveIdentity(asHandle('alice@example.com'));
      // Form path: `email` reached the server → real id. The old JSON path would have dropped the
      // arg → users_not_found → backendRef === handle (silent mis-resolution).
      expect(sawEmailArg).toBe(true);
      expect(identity.backendRef).toBe('U0ALICE');
    } finally {
      await plugin.disconnect();
      await stop(server);
    }
  });
});
