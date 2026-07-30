/**
 * HTTP-contract classes, driven against purpose-built in-process servers (not the conformance
 * FakeSlack) so the exact status, headers and raw request bytes are under the test's control:
 *
 *   - 429 backoff: an unusable `Retry-After` must fall to the default, a usable one must be waited
 *     out, and neither may become a burst.
 *   - Request encoding: every method must be form-encoded, or slack.com silently drops read-method
 *     args (`channel` / `oldest` / `cursor` / `email`).
 *   - Identity lookup: only "no such account" may pass through as a name convention; a provisioning
 *     failure must surface, not read back as a successful resolution.
 */
import { asCursor, asHandle, asTopic } from '@sharptrick/parley-core';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { MAX_HISTORY_PAGES, SlackPlugin } from '../src/index.js';

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

/**
 * CLASS: a server-stated backoff hint must be honoured or refused, never silently shortened into a
 * hammer loop — and an UNUSABLE hint must fall to the default, never to `delay(0)`. The table drives
 * the real plugin against a 429-then-succeed server and measures the gap actually observed on the
 * wire, so it grades the shipped path rather than a local re-declaration of the parser.
 */
const RETRY_AFTER_ROWS: Array<{ header?: string; minGapMs: number; maxGapMs: number }> = [
  { header: undefined, minGapMs: 400, maxGapMs: 1500 },
  { header: '', minGapMs: 400, maxGapMs: 1500 },
  { header: '0', minGapMs: 400, maxGapMs: 1500 },
  { header: '-1', minGapMs: 400, maxGapMs: 1500 },
  { header: 'abc', minGapMs: 400, maxGapMs: 1500 },
  { header: '1', minGapMs: 900, maxGapMs: 2000 },
  { header: '2', minGapMs: 1900, maxGapMs: 3000 },
  // Above the clamp on a self-chosen backoff, inside the call deadline: Slack's ordinary tiered
  // limit. The wait must be the server's own figure, not the 5s clamp.
  { header: '6', minGapMs: 5900, maxGapMs: 7500 },
];

// Past the deadline there is no wait that both honours the server and fits the call, so the call
// ends instead of retrying early — naming the figure, so an operator can raise `deadlineMs`.
const REFUSED_HINT = '9999';

describe('slack 429 backoff honours the server-stated hint', () => {
  for (const row of RETRY_AFTER_ROWS) {
    it(`Retry-After: ${row.header ?? '(absent)'} → one wait of ${row.minGapMs}–${row.maxGapMs} ms, then success`, async () => {
      const arrivals: number[] = [];
      let calls = 0;
      const server = createServer((req, res) => {
        void (async () => {
          await readBody(req);
          arrivals.push(Date.now());
          calls++;
          if (calls === 1) {
            const headers: Record<string, string> = { 'Content-Type': 'application/json' };
            if (row.header !== undefined) headers['Retry-After'] = row.header;
            res.writeHead(429, headers);
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
        const id = await plugin.post(asTopic('C0TEST'), asHandle('writer'), 'hello');

        expect(String(id)).toBe('1700000000.000001');
        expect(calls).toBe(2); // one 429, one wait, one success — never a burst
        const gap = arrivals[1]! - arrivals[0]!;
        expect(gap).toBeGreaterThanOrEqual(row.minGapMs);
        expect(gap).toBeLessThan(row.maxGapMs);
      } finally {
        await plugin.disconnect();
        await stop(server);
      }
    });
  }

  it(`Retry-After: ${REFUSED_HINT} → refused, naming the figure, without a second request`, async () => {
    const arrivals: number[] = [];
    const server = createServer((req, res) => {
      void (async () => {
        await readBody(req);
        arrivals.push(Date.now());
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': REFUSED_HINT });
        res.end(JSON.stringify({ ok: false, error: 'ratelimited' }));
      })();
    });
    const url = await listen(server);
    const plugin = new SlackPlugin();
    try {
      await plugin.connect({ api_url: url, bot_token: 'xoxb-test' });
      await expect(plugin.post(asTopic('C0TEST'), asHandle('writer'), 'hello')).rejects.toThrow(
        /upstream asked for 9999000ms, past this call's \d+ms deadline/,
      );
      expect(arrivals).toHaveLength(1);
    } finally {
      await plugin.disconnect();
      await stop(server);
    }
  });
});

describe('Slack api() form-encodes every method (read-method args survive)', () => {
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
          // exactly as slack.com behaves.
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

  /**
   * CLASS: a bare `catch` on an identity/permission lookup converts a diagnosable failure into a
   * plausible-looking success. Only Slack's own "no such account" answer means "this handle is just
   * a name"; every other outcome is a provisioning or transport fault the operator must be able to
   * read, so it has to reach the caller with Slack's code in the message.
   */
  const LOOKUP_OUTCOMES: Array<{ name: string; reply: string; passthrough: boolean }> = [
    { name: 'users_not_found', reply: 'users_not_found', passthrough: true },
    { name: 'missing_scope', reply: 'missing_scope', passthrough: false },
    { name: 'invalid_auth', reply: 'invalid_auth', passthrough: false },
    { name: 'account_inactive', reply: 'account_inactive', passthrough: false },
  ];

  for (const outcome of LOOKUP_OUTCOMES) {
    it(`resolveIdentity on \`${outcome.name}\` ${outcome.passthrough ? 'passes through' : 'surfaces the error'}`, async () => {
      const server = createServer((req, res) => {
        void (async () => {
          await readBody(req);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: outcome.reply }));
        })();
      });
      const url = await listen(server);
      const plugin = new SlackPlugin();
      try {
        await plugin.connect({ api_url: url, bot_token: 'xoxb-test' });
        const call = plugin.resolveIdentity(asHandle('alice@example.com'));
        if (outcome.passthrough) {
          // The WHOLE identity, not one field of it: a seam method whose return value no row states
          // in full is one whose branches can be rewritten with the suite still green.
          expect(await call).toEqual({
            handle: 'alice@example.com',
            backendRef: 'alice@example.com',
          });
        } else {
          await expect(call).rejects.toThrow(new RegExp(outcome.reply));
        }
      } finally {
        await plugin.disconnect();
        await stop(server);
      }
    });
  }

  it('resolveIdentity surfaces a transport failure rather than resolving to the handle', async () => {
    const plugin = new SlackPlugin();
    try {
      // Nothing is listening on this port, so `fetch` rejects before any Slack envelope exists.
      await plugin.connect({ api_url: 'http://127.0.0.1:1/api', bot_token: 'xoxb-test' });
      await expect(plugin.resolveIdentity(asHandle('alice@example.com'))).rejects.toThrow();
    } finally {
      await plugin.disconnect();
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
        // → the plugin's silent try/catch passthrough.
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

/**
 * CLASS: a walk whose termination is delegated to the peer. `conversations.history` pages until the
 * server stops handing out a `next_cursor`, so a server that never does — or that hands out one
 * that does not advance — turns one `fetch_recent` into an unbounded request loop that `disconnect`
 * cannot stop. Every row below asserts the call SETTLES, that it settles by naming why, and how
 * many requests it cost; a walk that merely spun would time the row out instead of failing it, so
 * the request count is asserted too.
 */
interface Pager {
  name: string;
  /** Cursor to answer with, given the cursor that arrived (undefined = first page). */
  next: (arrived: string | undefined, hit: number) => string;
  messagesPerPage: number;
  since?: string;
  expect: RegExp;
  expectedRequests: number;
}

const PAGERS: Pager[] = [
  {
    name: 'a cursor that never changes',
    next: () => 'always-more',
    messagesPerPage: 0,
    expect: /repeated page cursor/,
    expectedRequests: 2,
  },
  {
    name: 'a cursor cycling A → B → A',
    next: (arrived) => (arrived === 'A' ? 'B' : 'A'),
    messagesPerPage: 0,
    expect: /repeated page cursor/,
    expectedRequests: 3,
  },
  {
    name: 'a fresh cursor forever, on empty pages',
    next: (_arrived, hit) => `c${hit}`,
    messagesPerPage: 0,
    expect: new RegExp(`exceeded ${MAX_HISTORY_PAGES} pages`),
    expectedRequests: MAX_HISTORY_PAGES,
  },
  {
    name: 'a fresh cursor forever, on pages that never empty, resuming after a cursor',
    next: (_arrived, hit) => `c${hit}`,
    messagesPerPage: 5,
    since: '0',
    expect: new RegExp(`exceeded ${MAX_HISTORY_PAGES} pages`),
    expectedRequests: MAX_HISTORY_PAGES,
  },
];

function pagingServer(pager: Pager, onHit?: (hit: number) => void): Server {
  let hit = 0;
  let minted = 0;
  return createServer((req, res) => {
    void (async () => {
      const arrived = new URLSearchParams(await readBody(req)).get('cursor') ?? undefined;
      hit++;
      onHit?.(hit);
      const messages = Array.from({ length: pager.messagesPerPage }, () => ({
        type: 'message',
        ts: `1700000000.${String(++minted).padStart(6, '0')}`,
        text: `m${minted}`,
        user: 'U0X',
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          messages,
          response_metadata: { next_cursor: pager.next(arrived, hit) },
        }),
      );
    })();
  });
}

describe('slack conversations.history paging terminates without the server’s help', () => {
  for (const pager of PAGERS) {
    it(`ends the walk on ${pager.name}, naming why`, async () => {
      let served = 0;
      const server = pagingServer(pager, (hit) => {
        served = hit;
      });
      const url = await listen(server);
      const plugin = new SlackPlugin();
      try {
        await plugin.connect({ api_url: url, bot_token: 'xoxb-test' });
        const args = { topic: asTopic('C0PAGE'), limit: 10 };
        await expect(
          plugin.fetchRecent(
            pager.since === undefined ? args : { ...args, since: asCursor(pager.since) },
          ),
        ).rejects.toThrow(pager.expect);
        expect(served).toBe(pager.expectedRequests);
      } finally {
        await plugin.disconnect();
        await stop(server);
      }
    });
  }

  /**
   * CLASS: a termination guard that also has to be RECOVERABLE. Each guard above ends the walk by
   * throwing, because a truncated walk must never publish a cursor above history it did not read — so
   * the cursor cannot advance, and the same call is made again next catch-up. That is only acceptable
   * if the guard is stateless: once the backlog fits, the very same `since` must make progress. A
   * guard that latched, memoized or poisoned anything would leave the topic wedged forever.
   */
  const RECOVERABLE: Array<{ name: string; capped: Pager['next'] }> = [
    { name: 'a repeated page cursor', capped: () => 'always-more' },
    { name: 'a fresh cursor past the page ceiling', capped: (_arrived, hit) => `c${hit}` },
  ];

  for (const row of RECOVERABLE) {
    it(`recovers with the same \`since\` once ${row.name} stops: the topic is not wedged`, async () => {
      let capped = true;
      let hit = 0;
      const server = createServer((req, res) => {
        void (async () => {
          const arrived = new URLSearchParams(await readBody(req)).get('cursor') ?? undefined;
          hit++;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              ok: true,
              messages: [
                { type: 'message', ts: '1700000000.000009', text: 'reachable', user: 'U0X' },
              ],
              response_metadata: { next_cursor: capped ? row.capped(arrived, hit) : '' },
            }),
          );
        })();
      });
      const url = await listen(server);
      const plugin = new SlackPlugin();
      const args = { topic: asTopic('C0RECOVER'), since: asCursor('0'), limit: 10 };
      try {
        await plugin.connect({ api_url: url, bot_token: 'xoxb-test' });
        await expect(plugin.fetchRecent(args)).rejects.toThrow(
          /repeated page cursor|exceeded \d+ pages/,
        );

        // Same plugin, same `since`: nothing about the failure may persist into the next catch-up.
        capped = false;
        const recovered = await plugin.fetchRecent(args);
        expect(recovered.messages.map((m) => m.content)).toEqual(['reachable']);
        expect(String(recovered.nextCursor)).toBe('1700000000.000009');
      } finally {
        await plugin.disconnect();
        await stop(server);
      }
    });
  }

  it('a disconnect mid-walk ends it, and no further page is requested', async () => {
    const plugin = new SlackPlugin();
    let served = 0;
    const server = pagingServer(
      { name: 'endless', next: (_a, hit) => `c${hit}`, messagesPerPage: 0, expect: /x/, expectedRequests: 0 },
      (hit) => {
        served = hit;
        if (hit === 5) void plugin.disconnect();
      },
    );
    const url = await listen(server);
    try {
      await plugin.connect({ api_url: url, bot_token: 'xoxb-test' });
      await expect(
        plugin.fetchRecent({ topic: asTopic('C0PAGE'), since: asCursor('0'), limit: 10 }),
      ).rejects.toThrow(/aborted — disconnected/);
      const atStop = served;
      await new Promise((r) => setTimeout(r, 200));
      expect(served).toBe(atStop);
      expect(served).toBeLessThan(MAX_HISTORY_PAGES);
    } finally {
      await plugin.disconnect();
      await stop(server);
    }
  });
});
