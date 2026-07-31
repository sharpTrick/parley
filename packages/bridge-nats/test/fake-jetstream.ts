/**
 * A fault-injecting stand-in for the JetStream client/manager, wired into the plugin's private
 * `js`/`jsm` handles. It makes the failure modes a healthy localhost server never produces —
 * a fetch that expires having read part (or none) of its window, a throw between creating and
 * destroying an ephemeral consumer, a link whose every round trip costs `latencyMs` — deterministic
 * instead of timing-dependent.
 */
import type { Topic } from '@sharptrick/parley-core';

const enc = new TextEncoder();

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * NATS subject interest, implemented here rather than imported from the plugin: this is the rule the
 * fake GRADES the plugin's reads against, and a matcher shared with the code under test agrees with
 * that code's own mistakes.
 */
export const subjectMatches = (pattern: string, subject: string): boolean => {
  const tokens = pattern.split('.');
  const target = subject.split('.');
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '>') return target.length > i;
    if (i >= target.length) return false;
    if (tokens[i] !== '*' && tokens[i] !== target[i]) return false;
  }
  return tokens.length === target.length;
};

/**
 * One stored message. `subject` defaults to `FakeState.subject` — the topic's own. A record on any
 * OTHER subject is one the stream captures but the topic's `filter_subject` does not (a stream whose
 * subject list is wider than one topic, which `ensureStream` accepts): it counts toward every
 * STREAM-wide counter and must be invisible to every per-subject read.
 */
export interface FakeRecord {
  seq: number;
  data: string;
  subject?: string;
}

export interface FakeState {
  /** Stream contents: seq → JSON payload. */
  records: FakeRecord[];
  /** Subject of a record that does not name its own — the topic under test. */
  subject: string;
  /** How many messages ONE fetch yields before ending — the expiry/slow-link fault. */
  yieldLimit: number;
  /**
   * What `streams.info` reports as `last_seq`, above the newest surviving record: a deleted tail, or
   * a message on another subject. It moves no per-subject read — `last_by_subj` answers out of the
   * surviving records either way, which is what the real 2.10 server does.
   */
  visibleTail?: number;
  /**
   * What one round trip over this link costs: every manager/client call pays it, and so does each
   * message a pull delivers. Keep the per-message cost, so that a client-side patience budget
   * shorter than the link is a FAILING page here rather than a WAN-only defect.
   */
  latencyMs: number;
  /**
   * How long a pull holds the connection open when its window yields fewer than `max_messages` —
   * the real `expires`. A read that asks for more than the stream can supply pays this in full.
   */
  expiryMs: number;
  /** Config of the last `streams.add`, for retention/naming assertions. */
  added?: { name?: string; max_age?: number; subjects?: string[] };
  /** How many times `streams.add` was called — a read path that provisions is a non-zero here. */
  addCalls: number;
  /**
   * The topic has no stream yet: `streams.info` 404s until something calls `streams.add`. The
   * pre-state a read must answer without creating one, and the one a healthy localhost server
   * never shows a test that posts first.
   */
  streamAbsent: boolean;
  /** What `streams.find` names for the topic's subject; absent = no stream matches it. */
  rivalStream?: string;
  /**
   * Subjects `streams.info` reports for the stream. Defaults to `[subject]` — a real stream always
   * carries a subject list, and a fake that reports none certifies a read path that never checks
   * whether the stream it found is even the topic's. Set it to model a stream another config's
   * prefixes created.
   */
  subjects?: string[];
  /** How `streams.add` fails: the name is taken, or another stream already captures the subject. */
  addFails?: 'name-in-use' | 'subject-overlap';
  /** Where the fault is injected on the read path. */
  failOn: 'get' | 'fetch' | 'iterate' | null;
  /**
   * Make a pull that is CLOSED mid-wait throw, the way a real one closed under a disconnect does —
   * the termination a long-poll must swallow, and the only way to tell it apart from a fault.
   */
  throwOnClose: boolean;
  /** How many `consume()` iterators end silently — no consumer-loss status event, just EOF. */
  silentExits: number;
  /**
   * Sequences ONE `consume()` iterator counts as delivered and never yields — an `AckPolicy.None`
   * message the server wrote to a link that was already gone. The client sees it only as a jump in
   * `info.deliverySequence`. `swallowGeneration` says WHICH iterator swallows them (1 = the first),
   * so a hole can be injected into a rebuilt consumer as well as into the original.
   */
  swallowed: number[];
  swallowGeneration: number;
  /** `created` stamp both `streams.add` and `streams.info` report — the stream's incarnation. */
  streamCreated: string;
  /**
   * Re-provision the stream DURING the Nth `streams.info` call (1 = the first): the call observes
   * `swapCreatedTo` and the records are wiped, so an ack taken before it belongs to neither the
   * incarnation the caller last saw nor the one it is about to see.
   */
  swapCreatedOnInfoCall?: number;
  swapCreatedTo?: string;
  /** What the incarnation the swap installs holds, given what the old one held. Default: nothing. */
  swapRecordsTo?: (held: FakeRecord[]) => FakeRecord[];
  /** How many `streams.info` calls have been served — for arming `swapCreatedOnInfoCall` mid-run. */
  infoCalls: number;
  /** How many `streams.info` calls fail outright — the post-ack incarnation read `post` swallows. */
  infoFailures: number;
  /**
   * A ONE-SHOT "stream not found" at this point of a read, `streamMissingAfterMs` into it: the
   * out-of-band removal `withStream` re-ensures around, arriving late enough in a long-poll that a
   * retry granted a fresh budget overruns the caller's.
   */
  streamMissingOn?: 'consumers.add' | 'consumers.get' | 'fetch';
  streamMissingAfterMs: number;
  /** How many `streams.getMessage` calls report no message found. */
  getMessageMissing: number;
  /** How many `publish` calls report the stream as gone — the out-of-band-removal path. */
  publishMissing: number;
  /** Every ephemeral consumer created / destroyed, for leak assertions. */
  created: string[];
  deleted: string[];
  /** `opt_start_seq` of the most recently created consumer. */
  lastStart: number;
  /** `filter_subject` of the most recently created consumer; absent = the consumer set none. */
  lastFilter?: string;
  /** `filter_subject` of EVERY consumer created, in order. */
  filters: (string | undefined)[];
  /** `max_messages` of every `fetch`, and how many records the fake actually handed a pull. */
  maxMessages: number[];
  yielded: number;
}

export interface FakeJetStream {
  js: unknown;
  jsm: unknown;
  state: FakeState;
}

export function fakeJetStream(init: Partial<FakeState> = {}): FakeJetStream {
  const state: FakeState = {
    records: [],
    subject: 'parley.topic',
    yieldLimit: Number.POSITIVE_INFINITY,
    latencyMs: 0,
    expiryMs: 0,
    failOn: null,
    addCalls: 0,
    streamAbsent: false,
    throwOnClose: false,
    silentExits: 0,
    swallowed: [],
    swallowGeneration: 1,
    streamCreated: '2026-01-01T00:00:00.000000000Z',
    getMessageMissing: 0,
    publishMissing: 0,
    infoCalls: 0,
    infoFailures: 0,
    streamMissingAfterMs: 0,
    created: [],
    deleted: [],
    lastStart: 0,
    filters: [],
    maxMessages: [],
    yielded: 0,
    ...init,
  };
  let n = 0;
  let consumes = 0;

  /** Every call over this link pays one round trip. */
  const hop = async (): Promise<void> => {
    if (state.latencyMs > 0) await delay(state.latencyMs);
  };

  /** Fire the one-shot removal if it is armed for `point`, then disarm it so the retry succeeds. */
  const streamMissingAt = async (point: FakeState['streamMissingOn']): Promise<void> => {
    if (state.streamMissingOn !== point) return;
    state.streamMissingOn = undefined;
    await delay(state.streamMissingAfterMs);
    throw new Error('stream not found');
  };

  const subjectOf = (r: FakeRecord): string => r.subject ?? state.subject;
  /**
   * What THIS consumer sees. A consumer that set no `filter_subject` sees the whole stream, exactly
   * as the server gives it — so a read that forgets the filter is a leak here rather than a fake
   * that filtered on the reader's behalf.
   */
  const delivered = (r: FakeRecord): boolean =>
    state.lastFilter === undefined || subjectMatches(state.lastFilter, subjectOf(r));

  const jsm = {
    streams: {
      add: async (cfg: { name?: string; max_age?: number; subjects?: string[] }) => {
        await hop();
        state.addCalls += 1;
        if (state.addFails === 'name-in-use') throw new Error('stream name already in use');
        if (state.addFails === 'subject-overlap') {
          throw new Error('subjects overlap with an existing stream');
        }
        state.added = cfg;
        state.streamAbsent = false;
        return { config: { name: cfg.name ?? 'fake', subjects: cfg.subjects }, created: state.streamCreated };
      },
      find: async (subject: string) => {
        await hop();
        if (state.rivalStream === undefined) throw new Error('no stream matches subject');
        void subject;
        return state.rivalStream;
      },
      info: async () => {
        await hop();
        if (state.streamAbsent) throw new Error('stream not found');
        if (state.infoFailures > 0) {
          state.infoFailures -= 1;
          throw new Error('injected: streams.info failed');
        }
        state.infoCalls += 1;
        if (state.infoCalls === state.swapCreatedOnInfoCall) {
          state.records = state.swapRecordsTo?.(state.records) ?? [];
          state.streamCreated = state.swapCreatedTo ?? state.streamCreated;
        }
        const first = state.records[0]?.seq ?? 0;
        const last = state.visibleTail ?? state.records.at(-1)?.seq ?? 0;
        return {
          created: state.streamCreated,
          config: { subjects: state.subjects ?? [state.subject] },
          state: {
            messages: state.records.length,
            first_seq: first,
            last_seq: last,
            num_deleted: last === 0 ? 0 : last - first + 1 - state.records.length,
          },
        };
      },
      getMessage: async (_stream: string, req: { seq?: number; last_by_subj?: string }) => {
        await hop();
        if (state.getMessageMissing > 0) {
          state.getMessageMissing -= 1;
          throw new Error('no message found');
        }
        const subj = req.last_by_subj;
        const found =
          req.seq === undefined
            ? state.records.filter((r) => subj !== undefined && subjectMatches(subj, subjectOf(r))).at(-1)
            : state.records.find((r) => r.seq === req.seq);
        if (found === undefined) throw new Error('no message found');
        return { seq: found.seq, data: enc.encode(found.data) };
      },
    },
    consumers: {
      add: async (_stream: string, cfg: { opt_start_seq?: number; filter_subject?: string }) => {
        await hop();
        await streamMissingAt('consumers.add');
        const name = `c${++n}`;
        state.created.push(name);
        state.lastStart = cfg.opt_start_seq ?? 0;
        state.lastFilter = cfg.filter_subject;
        state.filters.push(cfg.filter_subject);
        return { name };
      },
      delete: async (_stream: string, name: string) => {
        await hop();
        state.deleted.push(name);
        return true;
      },
    },
  };

  const js = {
    consumers: {
      get: async () => {
        await hop();
        await streamMissingAt('consumers.get');
        if (state.failOn === 'get') throw new Error('injected: consumers.get failed');
        const start = state.lastStart;
        const filter = state.lastFilter;
        const visible = (r: FakeRecord): boolean =>
          filter === undefined || subjectMatches(filter, subjectOf(r));
        return {
          consume: async () => {
            const generation = ++consumes;
            const silent = generation <= state.silentExits;
            const swallowed = generation === state.swallowGeneration ? state.swallowed : [];
            let delivery = 0;
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
                  const due = state.records.filter((r) => r.seq >= next && visible(r));
                  for (const r of due) {
                    next = r.seq + 1;
                    delivery += 1;
                    if (swallowed.includes(r.seq)) continue;
                    yield {
                      seq: r.seq,
                      data: enc.encode(r.data),
                      info: { deliverySequence: delivery },
                    };
                  }
                  await new Promise((r) => setTimeout(r, 10));
                }
              },
            };
          },
          fetch: async ({ max_messages }: { max_messages: number }) => {
            await streamMissingAt('fetch');
            if (state.failOn === 'fetch') throw new Error('injected: fetch failed');
            state.maxMessages.push(max_messages);
            const window = state.records
              .filter((r) => r.seq >= start && visible(r))
              .slice(0, Math.min(max_messages, state.yieldLimit));
            let release = () => undefined as void;
            let wasClosed = false;
            const closed = new Promise<void>((resolve) => {
              release = () => resolve();
            });
            /**
             * Wait `ms`, or report that the pull was closed first. nats.js `stop()` is immediate, and
             * keep the macrotask even at zero: a message off a socket NEVER arrives in the same tick
             * as the pull request, so a budget that expires within one grades as truncation here.
             */
            const quiet = async (ms: number): Promise<'closed' | 'elapsed'> => {
              if (wasClosed) return 'closed';
              return Promise.race([
                closed.then(() => 'closed' as const),
                delay(Math.max(ms, 0)).then(() => 'elapsed' as const),
              ]);
            };
            return {
              close: () => {
                wasClosed = true;
                release();
              },
              [Symbol.asyncIterator]: async function* () {
                if (state.failOn === 'iterate') throw new Error('injected: iterator failed');
                // Keep the close check ahead of every yield: nats.js `stop()` unsubscribes at once,
                // so a closed pull delivers nothing further and a truncating reader LOSES messages.
                for (const r of window) {
                  if ((await quiet(state.latencyMs)) === 'closed') break;
                  state.yielded += 1;
                  yield { seq: r.seq, data: enc.encode(r.data) };
                }
                if (!wasClosed && window.length < max_messages && state.expiryMs > 0) {
                  await quiet(state.expiryMs);
                }
                if (wasClosed && state.throwOnClose) throw new Error('injected: pull closed');
              },
            };
          },
        };
      },
    },
    publish: async (subject: string, data: Uint8Array) => {
      await hop();
      if (state.publishMissing > 0) {
        state.publishMissing -= 1;
        throw new Error('503 no responders — stream not found');
      }
      // Keep `visibleTail` in the high-water mark: a sequence a delete left behind is spent, and a
      // fake that hands it out again models a server that reuses sequence numbers — which is the one
      // thing this plugin's cursor and dedup key are built on never happening.
      const seq = Math.max(state.records.at(-1)?.seq ?? 0, state.visibleTail ?? 0) + 1;
      state.records.push({ seq, data: new TextDecoder().decode(data), subject });
      return { seq };
    },
  };

  return { js, jsm, state };
}

/**
 * Wire a fake into a plugin instance. `topic` pre-seeds the stream cache so `connect()` isn't
 * needed; omit it to let the call under test drive `ensureStream` and record its `streams.add`.
 * A pre-seeded stream carries its incarnation too — a plugin that has ensured a stream has read
 * that stream's `created` stamp — and the fake's records are placed on the subject that topic
 * composes, so a read that drops its `filter_subject` sees what the server would show it.
 */
export function injectFake(plugin: unknown, fake: FakeJetStream, topic?: Topic): void {
  const peek = plugin as {
    js: unknown;
    jsm: unknown;
    ensured: Map<string, Promise<void>>;
    incarnations: Map<string, string>;
    subject: (t: Topic) => string;
    streamName: (t: Topic) => string;
  };
  peek.js = fake.js;
  peek.jsm = fake.jsm;
  if (topic !== undefined) {
    fake.state.subject = peek.subject(topic);
    const streamName = peek.streamName(topic);
    peek.ensured.set(streamName, Promise.resolve());
    peek.incarnations.set(streamName, fake.state.streamCreated.replace(/[^0-9A-Za-z]/g, ''));
  }
}

/** A connection stub, so that the subscribe loop's `live()` gate passes with no server. */
export function attachConnection(plugin: unknown, closed = false): void {
  (plugin as { nc: unknown }).nc = {
    isClosed: () => closed,
    drain: async () => undefined,
    close: async () => undefined,
  };
}

export const payload = (content: string): string =>
  JSON.stringify({ sender: 'sys', content, ts: '2026-01-01T00:00:00.000Z', in_reply_to: '' });
