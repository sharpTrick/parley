/**
 * The ONE gateway/REST harness every suite in this package drives the plugin through. It used to be
 * restated per file — four `reachReady` copies, three `fetch` stubs — so a change to the handshake
 * dance had to be found in four places and a missed copy hung that suite on `await pending` with no
 * indication which one was stale. `fixture-hygiene.test.ts` refuses a fifth copy.
 */
import type { MessageHandler, Topic } from '@sharptrick/parley-core';
import { vi } from 'vitest';
import type { DiscordPlugin } from '../src/index.js';
import { instances, REQUIRED_GATEWAY_QUERY, type FakeWs } from './fake-gateway.js';

/** Large enough that a socket's heartbeat interval never fires inside a case. */
export const HUGE_HB = 1_000_000;
/**
 * A handshake watchdog parked far out, for cases that drive close codes and backoff. Keep it beyond
 * any clock a case advances, so that a socket the case has not driven yet is never terminated
 * underneath it — that converts a scripted close into an extra, unscripted ladder step.
 */
export const NO_HANDSHAKE_TIMEOUT = 10_000_000;

/**
 * Open the shared socket and drive HELLO → IDENTIFY → READY on the socket `subscribe` just created.
 * Keep the timer tick BEFORE `await pending`, so that subscribe's channel check can read its stubbed
 * REST body: under fake timers the body stream is driven by a faked immediate, so awaiting first
 * hangs forever.
 */
export async function reachReady(
  plugin: DiscordPlugin,
  topic: Topic,
  opts?: { hb?: number; handler?: MessageHandler },
): Promise<FakeWs> {
  const before = instances.length;
  const pending = plugin.subscribe(topic, opts?.handler ?? (() => undefined));
  const ws = await openedSocket(before);
  ws.hello(opts?.hb ?? HUGE_HB);
  await vi.advanceTimersByTimeAsync(0);
  await pending;
  return ws;
}

/**
 * The socket the plugin opens beyond the `after`th, once it knows where to dial. A configured
 * `gateway_url` is dialed synchronously; a resolved one costs a `GET /gateway/bot` round trip, which
 * under fake timers only advances when the clock does.
 */
export async function openedSocket(after: number): Promise<FakeWs> {
  for (let tick = 0; tick < 50 && instances.length <= after; tick++) {
    await vi.advanceTimersByTimeAsync(1);
  }
  const ws = instances.at(-1);
  if (ws === undefined) throw new Error('the plugin opened no gateway socket');
  return ws;
}

/**
 * A dialed url with Discord's required connect params stripped, for the cases that ask WHICH edge
 * was dialed rather than how. The params themselves are enforced by the fakes (a socket dialed
 * without them is closed 4012) and asserted in `wire-contract.test.ts`.
 */
export function dialedBase(url: string): string {
  const parsed = new URL(url);
  for (const key of Object.keys(REQUIRED_GATEWAY_QUERY)) parsed.searchParams.delete(key);
  const path = parsed.pathname === '/' ? '' : parsed.pathname;
  return `${parsed.origin}${path}${parsed.search}`;
}

/** How `GET /gateway/bot` fails, for the cells that break URL resolution rather than the socket. */
export interface GatewayUrlFault {
  status?: number;
  headers?: Record<string, string>;
  /** `fetch` itself rejects (DNS/connection refused), rather than answering a status. */
  transport?: boolean;
}

export interface FetchStub {
  /** The page every `GET …/messages` answers, newest-first as Discord returns it. */
  page: unknown[];
  /** The url `GET /gateway/bot` hands out while {@link gatewayFault} is unset. */
  gatewayUrl: string;
  /** When set, `GET /gateway/bot` fails this way instead of answering a url. */
  gatewayFault?: GatewayUrlFault;
  /** Requests the stub has served, optionally filtered to paths containing `pathIncludes`. */
  count(pathIncludes?: string): number;
  /** Park the NEXT `…/messages` query until {@link release}, to pin a phase of the long-poll. */
  holdNextPage(): void;
  /** Queries parked by {@link holdNextPage} and not yet released. */
  parked(): number;
  /** Answer every parked query with the page it read at REQUEST time. */
  release(): void;
}

const jsonResponse = (status: number, body: unknown, headers?: Record<string, string>): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/**
 * Install a `fetch` stub over Discord's REST surface: the gateway-url lookup, the channel-pushable
 * check, and the message pages. Healthy by default — a case scripts only the leg it is about.
 *
 * Under fake timers the response body is read through a faked immediate, so a caller that awaits a
 * plugin call without advancing the clock hangs forever rather than failing.
 */
export function stubFetch(): FetchStub {
  const seen: string[] = [];
  const parked: Array<() => void> = [];
  let holdNext = false;

  const stub: FetchStub = {
    page: [],
    gatewayUrl: 'ws://fake',
    gatewayFault: undefined,
    count: (pathIncludes) =>
      pathIncludes === undefined
        ? seen.length
        : seen.filter((url) => url.includes(pathIncludes)).length,
    holdNextPage: () => {
      holdNext = true;
    },
    parked: () => parked.length,
    release: () => {
      for (const answer of parked.splice(0)) answer();
    },
  };

  vi.stubGlobal('fetch', (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    seen.push(url);

    if (url.includes('/gateway/bot')) {
      const fault = stub.gatewayFault;
      if (fault === undefined) return Promise.resolve(jsonResponse(200, { url: stub.gatewayUrl }));
      if (fault.transport === true) {
        return Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:443'));
      }
      return Promise.resolve(
        jsonResponse(fault.status ?? 500, { message: 'gateway lookup failed' }, fault.headers),
      );
    }

    if (url.includes('/messages')) {
      if ((init?.method ?? 'GET') === 'POST') {
        return Promise.resolve(jsonResponse(200, { id: '1', channel_id: '1' }));
      }
      // Snapshot at REQUEST time: a parked query answers the page it read, not one taken later.
      const answer = jsonResponse(200, stub.page);
      if (!holdNext) return Promise.resolve(answer);
      holdNext = false;
      return new Promise<Response>((resolve) => parked.push(() => resolve(answer)));
    }

    return Promise.resolve(jsonResponse(200, { id: '1', type: 0 }));
  });

  return stub;
}
