/**
 * A fault-injecting stand-in for the JetStream client/manager, wired into the plugin's private
 * `js`/`jsm` handles. It makes the failure modes a healthy localhost server never produces —
 * a fetch that expires having read part (or none) of its window, a throw between creating and
 * destroying an ephemeral consumer — deterministic instead of timing-dependent.
 */
const enc = new TextEncoder();

export interface FakeState {
  /** Stream contents: seq → JSON payload. */
  records: { seq: number; data: string }[];
  /** How many messages ONE fetch yields before ending — the expiry/slow-link fault. */
  yieldLimit: number;
  /** `streams.info` reports this as `last_seq` (models a message landing after the snapshot). */
  visibleTail?: number;
  /**
   * How long a pull holds the connection open when its window yields fewer than `max_messages` —
   * the real `expires`. A read that asks for more than the stream can supply pays this in full.
   */
  expiryMs: number;
  /** Config of the last `streams.add`, for retention/naming assertions. */
  added?: { name?: string; max_age?: number; subjects?: string[] };
  /** Where the fault is injected on the read path. */
  failOn: 'get' | 'fetch' | 'iterate' | null;
  /** How many `consume()` iterators end silently — no consumer-loss status event, just EOF. */
  silentExits: number;
  /** Every ephemeral consumer created / destroyed, for leak assertions. */
  created: string[];
  deleted: string[];
  /** `opt_start_seq` of the most recently created consumer. */
  lastStart: number;
}

export interface FakeJetStream {
  js: unknown;
  jsm: unknown;
  state: FakeState;
}

export function fakeJetStream(init: Partial<FakeState> = {}): FakeJetStream {
  const state: FakeState = {
    records: [],
    yieldLimit: Number.POSITIVE_INFINITY,
    expiryMs: 0,
    failOn: null,
    silentExits: 0,
    created: [],
    deleted: [],
    lastStart: 0,
    ...init,
  };
  let n = 0;
  let consumes = 0;

  const jsm = {
    streams: {
      add: async (cfg: { name?: string; max_age?: number; subjects?: string[] }) => {
        state.added = cfg;
        return { config: { name: cfg.name ?? 'fake' } };
      },
      info: async () => ({
        state: {
          messages: state.records.length,
          first_seq: state.records[0]?.seq ?? 0,
          last_seq: state.visibleTail ?? state.records.at(-1)?.seq ?? 0,
        },
      }),
    },
    consumers: {
      add: async (_stream: string, cfg: { opt_start_seq?: number }) => {
        const name = `c${++n}`;
        state.created.push(name);
        state.lastStart = cfg.opt_start_seq ?? 0;
        return { name };
      },
      delete: async (_stream: string, name: string) => {
        state.deleted.push(name);
        return true;
      },
      list: () => ({ [Symbol.asyncIterator]: async function* () {} }),
    },
  };

  const js = {
    consumers: {
      get: async () => {
        if (state.failOn === 'get') throw new Error('injected: consumers.get failed');
        const start = state.lastStart;
        return {
          consume: async () => {
            const silent = ++consumes <= state.silentExits;
            let closed = false;
            return {
              close: async () => {
                closed = true;
              },
              status: async () => ({ [Symbol.asyncIterator]: async function* () {} }),
              [Symbol.asyncIterator]: async function* () {
                if (silent) return; // EOF with no status event — a dropped link, not a deletion
                let next = start;
                while (!closed) {
                  const due = state.records.filter((r) => r.seq >= next);
                  for (const r of due) {
                    next = r.seq + 1;
                    yield { seq: r.seq, data: enc.encode(r.data) };
                  }
                  await new Promise((r) => setTimeout(r, 10));
                }
              },
            };
          },
          fetch: async ({ max_messages }: { max_messages: number }) => {
            if (state.failOn === 'fetch') throw new Error('injected: fetch failed');
            const window = state.records
              .filter((r) => r.seq >= start)
              .slice(0, Math.min(max_messages, state.yieldLimit));
            let done = () => undefined as void;
            const closed = new Promise<void>((resolve) => {
              done = () => resolve();
            });
            return {
              close: () => done(),
              [Symbol.asyncIterator]: async function* () {
                if (state.failOn === 'iterate') throw new Error('injected: iterator failed');
                for (const r of window) yield { seq: r.seq, data: enc.encode(r.data) };
                if (window.length < max_messages && state.expiryMs > 0) {
                  await Promise.race([closed, new Promise((r) => setTimeout(r, state.expiryMs))]);
                }
              },
            };
          },
        };
      },
    },
    publish: async () => ({ seq: (state.records.at(-1)?.seq ?? 0) + 1 }),
  };

  return { js, jsm, state };
}

/**
 * Wire a fake into a plugin instance. `streamName` pre-seeds the stream cache so `connect()` isn't
 * needed; omit it to let the call under test drive `ensureStream` and record its `streams.add`.
 */
export function injectFake(plugin: unknown, fake: FakeJetStream, streamName?: string): void {
  const peek = plugin as { js: unknown; jsm: unknown; ensured: Map<string, Promise<void>> };
  peek.js = fake.js;
  peek.jsm = fake.jsm;
  if (streamName !== undefined) peek.ensured.set(streamName, Promise.resolve());
}

export const payload = (content: string): string =>
  JSON.stringify({ sender: 'sys', content, ts: '2026-01-01T00:00:00.000Z', in_reply_to: '' });
