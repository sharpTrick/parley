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

/**
 * A settled promise, kept AS a settlement. Keep the union DISCRIMINATED, so that no case can read a
 * value or an error without first naming which settlement it expected: a helper that folds both
 * arms into one value lets a table grade latency, or a request count, while the call under it
 * rejects — and every such cell stays green whatever the plugin does.
 */
export type Settlement =
  | { status: 'resolved'; value: unknown }
  | { status: 'rejected'; error: unknown };

/** The ONE way this package observes a settlement; `fixture-hygiene.test.ts` refuses a second. */
export const settleOf = (call: Promise<unknown>): Promise<Settlement> =>
  call.then(
    (value): Settlement => ({ status: 'resolved', value }),
    (error: unknown): Settlement => ({ status: 'rejected', error }),
  );

/**
 * The ONE way this package reads a member the plugin does not export. Keep the presence check
 * AHEAD of the read, so that a probe whose target moved or was renamed is a named red rather than
 * a green assertion about `undefined` — `expect(probe(p, 'gatewayReady')).toBeUndefined()` passes
 * just as well when there is no such member at all, and takes the guard it stood for with it.
 */
export function probe<T>(target: object, key: string): T {
  let holder: object | null = target;
  while (holder !== null && !Object.hasOwn(holder, key)) holder = Object.getPrototypeOf(holder);
  if (holder === null) {
    throw new Error(
      `test probe reached for ${JSON.stringify(key)} on ${target.constructor.name}, which has no ` +
        'such member — the assertion under it grades nothing; re-point it or delete it',
    );
  }
  return (target as Record<string, unknown>)[key] as T;
}

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

/**
 * WHERE the gateway url comes from. A configured `gateway_url` is the fixture default across this
 * package, and it skips `GET /gateway/bot` — i.e. it skips the await the PRODUCTION dial runs
 * between "this session is alive" and "a socket exists". Keep the axis here rather than per table,
 * so that a suite about session lifetime can cross it without restating the connect dance.
 */
export const URL_SOURCES = [
  { label: 'a configured gateway_url', configured: true },
  { label: 'a url resolved per attempt', configured: false },
] as const;

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
  /**
   * Park the NEXT `GET /gateway/bot` until {@link release}, to pin a dial between resolving its url
   * and opening its socket — the window a configured `gateway_url` does not have.
   */
  holdNextGatewayUrl(): void;
  /** Requests parked by {@link holdNextPage} or {@link holdNextGatewayUrl}, not yet released. */
  parked(): number;
  /** Answer every parked request with the body it read at REQUEST time. */
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
  let holdNextLookup = false;

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
    holdNextGatewayUrl: () => {
      holdNextLookup = true;
    },
    parked: () => parked.length,
    release: () => {
      for (const answer of parked.splice(0)) answer();
    },
  };

  const park = (answer: Response): Promise<Response> =>
    new Promise<Response>((resolve) => parked.push(() => resolve(answer)));

  vi.stubGlobal('fetch', (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    seen.push(url);

    if (url.includes('/gateway/bot')) {
      const fault = stub.gatewayFault;
      if (fault === undefined) {
        const answer = jsonResponse(200, { url: stub.gatewayUrl });
        if (!holdNextLookup) return Promise.resolve(answer);
        holdNextLookup = false;
        return park(answer);
      }
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
      return park(answer);
    }

    return Promise.resolve(jsonResponse(200, { id: '1', type: 0 }));
  });

  return stub;
}
