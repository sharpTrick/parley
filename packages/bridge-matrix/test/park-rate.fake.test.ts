import { asCursor, asHandle, asTopic } from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MatrixPlugin } from '../src/index.js';
import { aliasForTopic, connectFake, FakeSynapse } from './fake-synapse.js';

/**
 * CLASS: a timing knob whose small-but-legal values collapse a wait into a request storm. Every park
 * in this plugin sleeps for a slice derived from `sync_timeout_ms` and then re-runs a full canonical
 * catch-up (`/context` + `/messages`) or an alias lookup, and the subscribe loop re-issues `/sync`
 * the instant the last one answers. Against a homeserver that does not long-poll — or with
 * `sync_timeout_ms` set low — that is thousands of requests per idle wait, and in production one
 * `parley_fetch_recent` carries `catchup.block_max_ms` = 60s of budget to spend that way.
 *
 * Graded as a RATE, with a floor as well as a ceiling: a park that issued nothing, or one that gave
 * up, would satisfy any ceiling — so each row measures the idle cost AND then proves the same park
 * still surfaces a message that lands in it. The outright degenerate values (0, negative, NaN) are
 * refused at load instead; see `config-validation.test.ts`.
 */

const WRITER = asHandle('writer');
const TOPIC = asTopic('paced');
const UNPROVISIONED = asTopic('never-posted');
/** Idle window each driver is measured over. */
const IDLE_MS = 600;
/**
 * Requests an idle `IDLE_MS` may cost. Tens is the shape of a paced park; the unpaced one issued
 * hundreds of `/messages` alone in less time than this.
 */
const RATE_CEILING = 100;
/** A landed message must still be surfaced this promptly by the same park. */
const PROMPT_MS = 1500;

let fake: FakeSynapse;
let requests: string[];
beforeEach(() => {
  fake = new FakeSynapse();
  requests = [];
  fake.onRequest = (method, path) => void requests.push(`${method} ${path}`);
  vi.stubGlobal('fetch', fake.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Run {
  idleCost: number;
  saw: string[];
  elapsed: number;
}

/** Each driver idles for `IDLE_MS`, records what that cost, then sees a message land in the park. */
const DRIVERS: Record<string, (p: MatrixPlugin) => Promise<Run>> = {
  'a blocking fetchRecent': async (p) => {
    await p.post(TOPIC, WRITER, 'seed');
    const tail = (await p.fetchRecent({ topic: TOPIC, limit: 10 })).nextCursor;
    const before = requests.length;
    await p.fetchRecent({ topic: TOPIC, since: tail, blockMs: IDLE_MS });
    const idleCost = requests.length - before;

    const started = Date.now();
    const pending = p.fetchRecent({ topic: TOPIC, since: tail, blockMs: 4000 });
    const lands = setTimeout(() => void fake.addMessage(String(TOPIC), 'fresh'), 50);
    const woke = await pending;
    clearTimeout(lands);
    return { idleCost, saw: woke.messages.map((m) => m.content), elapsed: Date.now() - started };
  },
  'a subscribe loop': async (p) => {
    await p.post(TOPIC, WRITER, 'seed');
    const saw: string[] = [];
    await p.subscribe(TOPIC, (m) => saw.push(m.content));
    const before = requests.length;
    await sleep(IDLE_MS);
    const idleCost = requests.length - before;

    const started = Date.now();
    fake.addMessage(String(TOPIC), 'fresh');
    await vi.waitFor(() => expect(saw).toContain('fresh'), { timeout: 4000, interval: 10 });
    return { idleCost, saw, elapsed: Date.now() - started };
  },
  'a blocking fetchRecent parked on a room no peer has created yet': async (p) => {
    fake.aliasExists = false;
    const before = requests.length;
    await p.fetchRecent({ topic: UNPROVISIONED, since: asCursor(''), blockMs: IDLE_MS });
    const idleCost = requests.length - before;

    const started = Date.now();
    const pending = p.fetchRecent({ topic: UNPROVISIONED, since: asCursor(''), blockMs: 4000 });
    const lands = setTimeout(() => {
      fake.aliasExists = true;
      fake.addMessage(String(UNPROVISIONED), 'fresh', aliasForTopic(String(UNPROVISIONED)));
    }, 50);
    const got = await pending;
    clearTimeout(lands);
    return { idleCost, saw: got.messages.map((m) => m.content), elapsed: Date.now() - started };
  },
};

/** Every `sync_timeout_ms` the loader accepts that is SHORTER than one park slice. */
const SMALL_TIMEOUTS = [1, 5, 50];

describe('a small sync_timeout_ms cannot turn an idle wait into a request storm', () => {
  for (const syncTimeoutMs of SMALL_TIMEOUTS) {
    for (const [name, drive] of Object.entries(DRIVERS)) {
      it(`sync_timeout_ms ${syncTimeoutMs} / ${name}: bounded request rate, still prompt`, async () => {
        const p = await connectFake({ syncTimeoutMs });

        const { idleCost, saw, elapsed } = await drive(p);

        expect(idleCost).toBeLessThanOrEqual(RATE_CEILING);
        expect(idleCost).toBeGreaterThanOrEqual(2); // it really did keep watching
        expect(saw).toContain('fresh');
        expect(elapsed).toBeLessThan(PROMPT_MS);
        await p.disconnect();
      }, 30_000);
    }
  }
});
