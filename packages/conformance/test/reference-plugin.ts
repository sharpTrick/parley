import {
  asBackendMsgId,
  asCursor,
  asTopic,
  type BackendConfig,
  type BackendIdentity,
  type BackendMsgId,
  type BackendPlugin,
  buildMessage,
  type Cursor,
  type FetchRecentArgs,
  type FetchRecentResult,
  type Handle,
  type Message,
  type MessageHandler,
  NoSuchTopicError,
  type Topic,
} from '@sharptrick/parley-core';
import { type ConformanceContext, PARK_FRACTION } from '@sharptrick/parley-conformance';

/**
 * The backing store a family of {@link ReferencePlugin} instances share, so that several
 * independently-connected clients can see one another's writes — which is what every real backend's
 * `concurrentPost` builds out of N connections, and what a live path graded only against its own
 * writes never exercises.
 */
export interface ReferenceStore {
  seq: number;
  readonly log: Map<string, Message[]>;
  subscriptions: { topic: string; handler: MessageHandler; owner: object }[];
  /** Fired by every `post`, so a plugin built `blocking` can honour `blockMs` on a real wake. */
  writes: (() => void)[];
}

export const newReferenceStore = (): ReferenceStore => ({
  seq: 0,
  log: new Map(),
  subscriptions: [],
  writes: [],
});

/**
 * An in-memory backend that is conformant BY CONSTRUCTION — the suite's reference control.
 *
 * Every real backend needs a server, so on a machine with none reachable the suite grades nothing
 * at all and a weakened assertion is invisible. This plugin always runs, and the broken variants
 * below are the negative control: each must fail at least one named case, which is what stops an
 * assertion in the suite from quietly becoming vacuous.
 */
export class ReferencePlugin implements BackendPlugin {
  private connected = false;
  private readonly store: ReferenceStore;
  private readonly blocking: boolean;

  constructor(store: ReferenceStore = newReferenceStore(), blocking = false) {
    this.store = store;
    this.blocking = blocking;
  }

  connect(_config: BackendConfig): Promise<void> {
    this.connected = true;
    return Promise.resolve();
  }

  disconnect(): Promise<void> {
    this.connected = false;
    this.store.subscriptions = this.store.subscriptions.filter((s) => s.owner !== this);
    return Promise.resolve();
  }

  async subscribe(topic: Topic, handler: MessageHandler): Promise<void> {
    this.require();
    this.store.subscriptions.push({ topic: String(topic), handler, owner: this });
  }

  async post(
    topic: Topic,
    identity: Handle,
    content: string,
    _opts?: { inReplyTo?: BackendMsgId },
  ): Promise<BackendMsgId> {
    this.require();
    const id = String(++this.store.seq).padStart(12, '0');
    const message = buildMessage({
      topic,
      sender: String(identity),
      content,
      timestamp: new Date().toISOString(),
      id,
    });
    this.store.log.set(String(topic), [...(this.store.log.get(String(topic)) ?? []), message]);
    for (const s of this.store.subscriptions) if (s.topic === String(topic)) s.handler(message);
    for (const wake of this.store.writes.splice(0)) wake();
    return asBackendMsgId(id);
  }

  /**
   * `blocking` is the OTHER arm of `supportsBlockingFetch`, and it has to be honoured for real: the
   * suite's native-blocking assertions grade waking on the message rather than on the budget, and a
   * poll would satisfy them by accident. Keep the read and the waiter in ONE synchronous turn, so
   * that a write landing between them cannot be lost — that window is what the suite's 0-3 ms race
   * case exists to open, and a fixture with the hazard in it grades nothing.
   */
  async fetchRecent(args: FetchRecentArgs): Promise<FetchRecentResult> {
    this.require();
    const page = this.read(args);
    if (!this.blocking || args.blockMs === undefined || page.messages.length > 0) return page;
    const until = Date.now() + args.blockMs;
    for (let left = args.blockMs; left > 0; left = until - Date.now()) {
      await this.nextWrite(left);
      const woken = this.read(args);
      if (woken.messages.length > 0) return woken;
    }
    return this.read(args);
  }

  private read(args: FetchRecentArgs): FetchRecentResult {
    const history = this.store.log.get(String(args.topic)) ?? [];
    const limit = args.limit ?? 100;
    if (args.since === undefined) {
      const window = history.slice(Math.max(0, history.length - limit));
      return { messages: window, nextCursor: this.tail(window, args.since) };
    }
    const after = history.filter((m) => String(m.cursor) > String(args.since)).slice(0, limit);
    return { messages: after, nextCursor: this.tail(after, args.since) };
  }

  private nextWrite(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const wake = (): void => {
        clearTimeout(timer);
        resolve();
      };
      timer = setTimeout(() => {
        const at = this.store.writes.indexOf(wake);
        if (at >= 0) this.store.writes.splice(at, 1);
        resolve();
      }, ms);
      this.store.writes.push(wake);
    });
  }

  async resolveIdentity(handle: Handle): Promise<BackendIdentity> {
    this.require();
    return { handle, backendRef: `reference:${String(handle)}` };
  }

  private tail(page: Message[], since: Cursor | undefined): Cursor {
    return page.at(-1)?.cursor ?? since ?? asCursor('0');
  }

  private require(): void {
    if (!this.connected) throw new Error('reference plugin is disconnected');
  }
}

let seq = 0;

/**
 * The capability flags every fixture here used to hard-code, which made them a CONSTANT rather than
 * an axis: with `supportsBlockingFetch` false everywhere, nothing in this package ever ran the
 * suite's native-blocking half or the true arm of its lost-wakeup race, and both could be deleted
 * with the package green while eight backends that declare the capability kept being certified
 * against them. Every fixture below states which arm it takes, and `BROKEN_VARIANTS` covers both.
 */
type Capabilities = Pick<ConformanceContext, 'supportsBlockingFetch' | 'carriesSenderIdentity'>;

const DEFAULT_CAPABILITIES: Capabilities = {
  supportsBlockingFetch: false,
  carriesSenderIdentity: true,
};

const delegate = (inner: ReferencePlugin): BackendPlugin => ({
  connect: (c) => inner.connect(c),
  disconnect: () => inner.disconnect(),
  subscribe: (t, h) => inner.subscribe(t, h),
  post: (t, i, c, o) => inner.post(t, i, c, o),
  fetchRecent: (a) => inner.fetchRecent(a),
  resolveIdentity: (h) => inner.resolveIdentity(h),
});

/**
 * `concurrentPost` drives N separately-connected clients over the shared store, exactly as every
 * shipped fixture drives N plugin instances against one server. Keep it OFF `ctx.plugin`, so that
 * the writers the suite calls independent really are.
 */
async function context(
  plugin: BackendPlugin,
  store: ReferenceStore,
  caps: Partial<Capabilities> = {},
): Promise<ConformanceContext> {
  await plugin.connect({});
  return {
    plugin,
    freshTopic: (): Topic => asTopic(`ref-${++seq}-${Math.random().toString(36).slice(2, 8)}`),
    cleanup: () => plugin.disconnect(),
    concurrentPost: async (topic: Topic, writers: number, perWriter: number) => {
      const clients = await Promise.all(
        Array.from({ length: writers }, async () => {
          const p = new ReferencePlugin(store);
          await p.connect({});
          return p;
        }),
      );
      try {
        await Promise.all(
          clients.map(async (p, w) => {
            for (let i = 0; i < perWriter; i++) {
              await p.post(topic, `w${w}` as Handle, `w${w}-${i}`);
            }
          }),
        );
      } finally {
        await Promise.all(clients.map((p) => p.disconnect()));
      }
    },
    ...DEFAULT_CAPABILITIES,
    ...caps,
    absentTopicBehaviour: 'empty-page',
  };
}

export const makeReferenceContext = (): Promise<ConformanceContext> => {
  const store = newReferenceStore();
  return context(new ReferencePlugin(store), store);
};

/**
 * The positive control on the OTHER arm of `supportsBlockingFetch` — a reference that really honours
 * `blockMs` inside `fetchRecent`, as Redis, NATS, Matrix, Postgres, XMPP, Slack, Discord and Zulip
 * declare they do. Without it the suite's native-blocking assertions are satisfiable by nothing in
 * this repo, which is indistinguishable from their being deleted.
 */
export const makeBlockingReferenceContext = (): Promise<ConformanceContext> => {
  const store = newReferenceStore();
  return context(new ReferencePlugin(store, true), store, { supportsBlockingFetch: true });
};

/** The handle a backend that stamps its own account reports instead of `post`'s `identity`. */
const STAMPED = 'reference-bot' as Handle;

/**
 * The positive control on the false arm of `carriesSenderIdentity`: a backend that posts as its
 * authenticated account, which is what every hosted SaaS does and what Matrix's homeserver-stamped
 * `sender` amounts to. The weaker contract that arm buys is graded here rather than nowhere.
 */
export const makeStampedSenderReferenceContext = (): Promise<ConformanceContext> => {
  const store = newReferenceStore();
  const inner = new ReferencePlugin(store);
  const plugin: BackendPlugin = {
    ...delegate(inner),
    post: (t, _identity, c, o) => inner.post(t, STAMPED, c, o),
  };
  return context(plugin, store, { carriesSenderIdentity: false });
};

/**
 * A reference plugin taking the OTHER arm of the seam's absent-topic MAY: it throws
 * `NoSuchTopicError` for a topic nothing has been posted to. Without this nothing in the repo
 * produces that error for the suite (or for core's mapping of it) to grade.
 */
async function throwingReference(
  absent: (topic: string) => Error,
): Promise<ConformanceContext> {
  const store = newReferenceStore();
  const inner = new ReferencePlugin(store);
  // Presence is read off the STORE, not off this wrapper's own writes: an independent client's post
  // creates the topic just as a human's message would.
  const plugin: BackendPlugin = {
    ...delegate(inner),
    fetchRecent: async (args) => {
      if (!store.log.has(String(args.topic))) throw absent(String(args.topic));
      return inner.fetchRecent(args);
    },
  };
  return { ...(await context(plugin, store)), absentTopicBehaviour: 'throws' };
}

export const makeThrowingReferenceContext = (): Promise<ConformanceContext> =>
  throwingReference((topic) => new NoSuchTopicError(topic));

/** One wrapper per way a plugin can be non-conformant, and the case each one must break. */
export interface BrokenVariant {
  name: string;
  /** A case title the suite MUST fail for this variant. */
  mustFail: string;
  /**
   * The `Message` field or seam call this variant corrupts. The clause↔variant mapping is per
   * CLAUSE, so a clause could keep its control while individual assertions INSIDE it had none — six
   * of them did, and neutering all six at once left this whole package green. Keyed by field, the
   * requirement is mechanical in both directions: a `Message` field no variant names is a field the
   * suite can stop asserting on for free.
   */
  mutates: string;
  make: () => Promise<ConformanceContext>;
}

/**
 * The inner plugin is built to MATCH the capabilities the fixture declares — a variant that declares
 * native `blockMs` gets an inner that really honours it — so that the only thing failing the arm is
 * the wrapper's own defect and not the fixture lying about what it supports.
 */
const wrap = async (
  over: (inner: ReferencePlugin) => Partial<BackendPlugin>,
  caps: Partial<Capabilities> = {},
): Promise<ConformanceContext> => {
  const store = newReferenceStore();
  const inner = new ReferencePlugin(store, caps.supportsBlockingFetch ?? false);
  return context({ ...delegate(inner), ...over(inner) }, store, caps);
};

export const BROKEN_VARIANTS: BrokenVariant[] = [
  {
    name: 'inclusive since',
    mutates: 'fetchRecent',
    mustFail: 'only newer messages (exclusive)',
    make: () =>
      wrap((inner) => ({
        fetchRecent: async (args) => {
          const page = await inner.fetchRecent(args);
          if (args.since === undefined) return page;
          const all = await inner.fetchRecent({ ...args, since: undefined, limit: 10_000 });
          const at = all.messages.filter((m) => String(m.cursor) === String(args.since));
          return { ...page, messages: [...at, ...page.messages] };
        },
      })),
  },
  {
    name: 'a constant topic on every message',
    mutates: 'topic',
    mustFail: 'topics are isolated',
    make: () =>
      wrap((inner) => ({
        fetchRecent: async (args) => {
          const page = await inner.fetchRecent(args);
          return {
            ...page,
            messages: page.messages.map((m) => ({ ...m, topic: asTopic('collapsed') })),
          };
        },
      })),
  },
  {
    name: 'a constant backendMsgId',
    mutates: 'backendMsgId',
    mustFail: 'unique ids and distinct cursors',
    make: () =>
      wrap((inner) => ({
        fetchRecent: async (args) => {
          const page = await inner.fetchRecent(args);
          return {
            ...page,
            messages: page.messages.map((m) => ({ ...m, backendMsgId: asBackendMsgId('same') })),
          };
        },
      })),
  },
  {
    name: 'an oldest-first default window',
    mutates: 'fetchRecent',
    mustFail: 'returns the NEWEST messages',
    make: () =>
      wrap((inner) => ({
        fetchRecent: async (args) => {
          if (args.since !== undefined) return inner.fetchRecent(args);
          const all = await inner.fetchRecent({ ...args, limit: 10_000 });
          const window = all.messages.slice(0, args.limit ?? 100);
          return {
            messages: window,
            nextCursor: window.at(-1)?.cursor ?? all.nextCursor,
          };
        },
      })),
  },
  {
    name: 'a subscribe that replays history as live',
    mutates: 'subscribe',
    mustFail: 'exactly the post-subscribe tail',
    make: () =>
      wrap((inner) => ({
        subscribe: async (topic, handler) => {
          const past = await inner.fetchRecent({ topic, limit: 10_000 });
          for (const m of past.messages) handler(m);
          await inner.subscribe(topic, handler);
        },
      })),
  },
  {
    name: 'a post that still serves after disconnect',
    mutates: 'disconnect',
    mustFail: 'disconnect is idempotent',
    make: () =>
      wrap((inner) => {
        let torn = false;
        return {
          disconnect: async () => {
            torn = true;
            await inner.disconnect();
          },
          post: async (t, i, c, o) => {
            if (torn) await inner.connect({});
            return inner.post(t, i, c, o);
          },
        };
      }),
  },
  {
    name: 'mentions dropped from every message',
    mutates: 'mentions',
    mustFail: 'via live push and via catch-up',
    make: () =>
      wrap((inner) => ({
        fetchRecent: async (args) => {
          const page = await inner.fetchRecent(args);
          return { ...page, messages: page.messages.map((m) => ({ ...m, mentions: [] })) };
        },
      })),
  },
  {
    name: 'a blank senderHandle',
    mutates: 'senderHandle',
    mustFail: 'not collapsed onto one another',
    make: () =>
      wrap((inner) => ({
        fetchRecent: async (args) => {
          const page = await inner.fetchRecent(args);
          return {
            ...page,
            messages: page.messages.map((m) => ({ ...m, senderHandle: '' as Handle })),
          };
        },
      })),
  },
  {
    name: 'a cursor that does not advance past a truncating limit',
    mutates: 'cursor',
    mustFail: 'paging from a cursor with limit',
    make: () =>
      wrap((inner) => ({
        fetchRecent: async (args) => {
          const page = await inner.fetchRecent(args);
          const all = await inner.fetchRecent({ ...args, since: undefined, limit: 10_000 });
          return { ...page, nextCursor: all.nextCursor };
        },
      })),
  },
  {
    name: 'an unreplayable cursor on an absent topic',
    mutates: 'cursor',
    mustFail: 'never-posted topic',
    make: () =>
      wrap(() => ({
        fetchRecent: () =>
          Promise.resolve({
            messages: [],
            nextCursor: asCursor(`drifting-${Math.random().toString(36).slice(2)}`),
          }),
      })),
  },
  {
    name: 'a plain Error for an absent topic instead of NoSuchTopicError',
    mutates: 'fetchRecent',
    mustFail: 'never-posted topic',
    make: () => throwingReference(() => new Error('nope')),
  },
  {
    // The pre-commit-sequence hazard, in memory: report the tail row's cursor while withholding the
    // row itself, exactly as a BIGSERIAL reader sees seq 42 committed while 41 is not. Only a reader
    // placed INSIDE the write window can see it.
    name: 'a cursor that advances past a row it did not return',
    mutates: 'cursor',
    mustFail: 'interleaved with concurrent writers',
    make: () =>
      wrap((inner) => ({
        fetchRecent: async (args) => {
          const page = await inner.fetchRecent(args);
          if (args.since === undefined || page.messages.length < 2) return page;
          return {
            messages: page.messages.slice(0, -1),
            nextCursor: page.messages.at(-1)!.cursor,
          };
        },
      })),
  },
  {
    // Silent alteration, the failure mode a "post then read one short ASCII string" suite cannot
    // see: accept the payload, store something else, report success.
    name: 'content flattened on the way in',
    mutates: 'content',
    mustFail: 'either round-trips',
    make: () =>
      wrap((inner) => ({
        post: (t, i, c, o) => inner.post(t, i, c.replace(/\s+/gu, ' ').trim(), o),
      })),
  },
  {
    name: 'a fetch that parks forever on blockMs',
    mutates: 'fetchRecent',
    mustFail: 'blockMs is honoured natively or ignored promptly',
    make: () =>
      wrap((inner) => ({
        fetchRecent: async (args) => {
          const page = await inner.fetchRecent(args);
          if (args.blockMs !== undefined && page.messages.length === 0) {
            await new Promise((resolve) => setTimeout(resolve, Math.min(args.blockMs ?? 0, 1_200)));
          }
          return page;
        },
      })),
  },
  {
    // The same hang one argument away: park on a budget that came WITHOUT a cursor. That is the
    // first iteration of core's long-poll wrapper, so it stalls every fetch an agent makes before
    // it has a cursor — while the variant above, which parks only on an empty page, sails through.
    //
    // A FRACTION of the budget, not all of it. Parking for the whole budget is the one park an
    // assertion phrased as "under the budget" can catch, so a control that spends it all leaves
    // that phrasing looking like a working guard; this one is only caught by a bound that is a real
    // fraction, which is the property the clause claims to grade.
    name: 'a fetch that parks on a since-less blockMs',
    mutates: 'fetchRecent',
    mustFail: 'blockMs is honoured natively or ignored promptly',
    make: () =>
      wrap((inner) => ({
        fetchRecent: async (args) => {
          const page = await inner.fetchRecent(args);
          if (args.since === undefined && args.blockMs !== undefined) {
            const parkFor = Math.min(args.blockMs * PARK_FRACTION, 20_000);
            await new Promise((resolve) => setTimeout(resolve, parkFor));
          }
          return page;
        },
      })),
  },
  {
    // Content-keyed identity: the shape a backend that treats a repost as the same message has.
    // Core's dedup namespace is `backendMsgId`, so two turns with the same words collapse into one.
    name: 'a post that dedupes identical content',
    mutates: 'post',
    mustFail: 'the same content posted twice',
    make: () =>
      wrap((inner) => ({
        post: async (t, i, c, o) => {
          const seen = (await inner.fetchRecent({ topic: t, limit: 10_000 })).messages.find(
            (m) => m.content === c,
          );
          return seen?.backendMsgId ?? inner.post(t, i, c, o);
        },
      })),
  },
  {
    // A cursor at the tail that re-serves the newest message: the catch-up loop then replays the
    // last message on every poll forever, because `since` never gets past it.
    name: 'a tail cursor that re-delivers the newest message',
    mutates: 'cursor',
    mustFail: 'since at the tail',
    make: () =>
      wrap((inner) => ({
        fetchRecent: async (args) => {
          const page = await inner.fetchRecent(args);
          if (args.since === undefined || page.messages.length > 0) return page;
          const all = await inner.fetchRecent({ topic: args.topic, limit: 10_000 });
          const newest = all.messages.at(-1);
          if (newest === undefined || String(newest.cursor) !== String(args.since)) return page;
          return { messages: [newest], nextCursor: newest.cursor };
        },
      })),
  },
  {
    name: 'a post that rejects a threaded reply',
    mutates: 'post',
    mustFail: 'post accepts inReplyTo',
    make: () =>
      wrap((inner) => ({
        post: (t, i, c, o) =>
          o?.inReplyTo === undefined
            ? inner.post(t, i, c, o)
            : Promise.reject(new Error('threaded replies unsupported')),
      })),
  },
  {
    // A live path that fans every message to every handler regardless of topic: core then emits a
    // `<channel>` event for a topic the allowlist never admitted.
    name: 'a live path that ignores its topic filter',
    mutates: 'subscribe',
    mustFail: 'on the live path too',
    make: () =>
      wrap((inner) => {
        const registered: { topic: string; handler: MessageHandler }[] = [];
        return {
          subscribe: async (topic, handler) => {
            registered.push({ topic: String(topic), handler });
            await inner.subscribe(topic, handler);
          },
          post: async (t, i, c, o) => {
            const id = await inner.post(t, i, c, o);
            const landed = (await inner.fetchRecent({ topic: t, limit: 1 })).messages.at(-1);
            if (landed !== undefined) {
              for (const s of registered) if (s.topic !== String(t)) s.handler(landed);
            }
            return id;
          },
        };
      }),
  },
  {
    name: 'a resolveIdentity that answers about someone else',
    mutates: 'resolveIdentity',
    mustFail: 'resolveIdentity answers',
    make: () =>
      wrap(() => ({
        resolveIdentity: (handle) =>
          Promise.resolve({
            handle: `not-${String(handle)}` as Handle,
            backendRef: 'reference:constant',
          }),
      })),
  },
  {
    // The lost-wakeup race: park "from now" instead of at the caller's cursor, so a message landing
    // between the read and the waiter is reported as already-consumed and can never be fetched.
    name: 'a blocking read that parks from now instead of at the caller cursor',
    mutates: 'fetchRecent',
    mustFail: 'blocking fetch is not missed',
    make: () =>
      wrap((inner) => ({
        fetchRecent: async (args) => {
          const page = await inner.fetchRecent(args);
          if (args.since === undefined || args.blockMs === undefined) return page;
          if (page.messages.length > 0) return page;
          await new Promise((resolve) => setTimeout(resolve, 10));
          const all = await inner.fetchRecent({ topic: args.topic, limit: 10_000 });
          return { messages: [], nextCursor: all.nextCursor };
        },
      })),
  },
  {
    // Each writer numbering from its own sequence — the cursor namespace a backend gets when the
    // ordering key is per-connection rather than per-topic. Cursors then collide across writers.
    name: 'a cursor namespace that restarts per writer',
    mutates: 'cursor',
    mustFail: 'multi-process writes',
    make: () =>
      wrap((inner) => ({
        fetchRecent: async (args) => {
          const page = await inner.fetchRecent(args);
          const perSender = new Map<string, number>();
          return {
            ...page,
            messages: page.messages.map((m) => {
              const n = (perSender.get(String(m.senderHandle)) ?? 0) + 1;
              perSender.set(String(m.senderHandle), n);
              return { ...m, cursor: asCursor(String(n).padStart(12, '0')) };
            }),
          };
        },
      })),
  },
  {
    // The loopback: a live path that only ever echoes writes made through THIS client. Every other
    // subscribe case posts through the subscribing client, so nothing else can see it.
    name: 'a live path that only echoes its own writes',
    mutates: 'subscribe',
    mustFail: 'written by an independent client',
    make: () =>
      wrap((inner) => {
        const registered: { topic: string; handler: MessageHandler }[] = [];
        return {
          subscribe: (topic, handler) => {
            registered.push({ topic: String(topic), handler });
            return Promise.resolve();
          },
          post: async (t, i, c, o) => {
            const id = await inner.post(t, i, c, o);
            const landed = (await inner.fetchRecent({ topic: t, limit: 1 })).messages.at(-1);
            if (landed !== undefined) {
              for (const s of registered) if (s.topic === String(t)) s.handler(landed);
            }
            return id;
          },
        };
      }),
  },
  {
    // Every variant above corrupts something a WHOLE clause is built on, so the assertions inside a
    // clause had no control of their own: `timestamp` was asserted parseable and no plugin anywhere
    // produced an unparseable one. Core rejects ordering on it, but it is what an operator reads.
    name: 'a timestamp no clock could have produced',
    mutates: 'timestamp',
    mustFail: 'in order, with unique ids and distinct cursors',
    make: () =>
      wrap((inner) => ({
        fetchRecent: async (args) => {
          const page = await inner.fetchRecent(args);
          return {
            ...page,
            messages: page.messages.map((m) => ({ ...m, timestamp: 'the other day' })),
          };
        },
      })),
  },
  {
    // Blank ONE cursor, not all of them: blanking every cursor also collapses the distinct-cursor
    // assertion, and a control that trips two assertions cannot tell which one is still alive.
    name: 'an empty cursor on the oldest message of a page',
    mutates: 'cursor',
    mustFail: 'in order, with unique ids and distinct cursors',
    make: () =>
      wrap((inner) => ({
        fetchRecent: async (args) => {
          const page = await inner.fetchRecent(args);
          return {
            ...page,
            messages: page.messages.map((m, i) => (i === 0 ? { ...m, cursor: asCursor('') } : m)),
          };
        },
      })),
  },
  {
    // The same, one level down: `post` reports the blank id too, so the id it returns still matches
    // the one catch-up reports and the uniqueness assertions still hold. All that is left is the
    // length check — which nothing could fail before this.
    name: 'an empty backendMsgId, reported the same way by post',
    mutates: 'backendMsgId',
    mustFail: 'in order, with unique ids and distinct cursors',
    make: () =>
      wrap((inner) => {
        const blanked = new Set<string>();
        return {
          post: async (t, i, c, o) => {
            const opens = (await inner.fetchRecent({ topic: t, limit: 1 })).messages.length === 0;
            const id = await inner.post(t, i, c, o);
            if (!opens) return id;
            blanked.add(String(id));
            return asBackendMsgId('');
          },
          fetchRecent: async (args) => {
            const page = await inner.fetchRecent(args);
            return {
              ...page,
              messages: page.messages.map((m) =>
                blanked.has(String(m.backendMsgId)) ? { ...m, backendMsgId: asBackendMsgId('') } : m,
              ),
            };
          },
        };
      }),
  },
  {
    // The IDEMPOTENT half of "disconnect is idempotent and stops the plugin serving". The variant
    // above it only stops serving; deleting the second `disconnect()` call cost nothing.
    name: 'a disconnect that throws on the second call',
    mutates: 'disconnect',
    mustFail: 'disconnect is idempotent',
    make: async () => {
      const ctx = await wrap((inner) => {
        let calls = 0;
        return {
          disconnect: async () => {
            calls++;
            if (calls > 1) throw new Error('already disconnected');
            await inner.disconnect();
          },
        };
      });
      // The teardown must SWALLOW it, so that the case which calls `disconnect()` twice is the only
      // one that fails: an afterEach that rethrows reddens all 21 and the control proves nothing.
      return { ...ctx, cleanup: () => ctx.plugin.disconnect().then(() => undefined, () => undefined) };
    },
  },
  {
    // `backendRef` is how core addresses the account behind a handle. The variant above answers
    // about the wrong handle; nothing produced an empty ref, so that assertion graded nothing.
    name: 'an empty backendRef',
    mutates: 'resolveIdentity',
    mustFail: 'resolveIdentity answers',
    make: () => wrap(() => ({ resolveIdentity: (handle) => Promise.resolve({ handle, backendRef: '' }) })),
  },
  {
    // `nextCursor` on a since-LESS page. Every variant that touches the default window corrupts the
    // MESSAGES, so the cursor assertion beside them graded nothing: report where the window STARTS
    // instead of where it ends and a catch-up loop re-reads the whole window on every poll.
    // Applied only when the window was truncated, so the clause that owns the shape is the one
    // that fails rather than every case that reads without a `since`.
    name: 'a truncated since-less page that reports its oldest row',
    mutates: 'nextCursor-agreement',
    mustFail: 'returns the NEWEST messages',
    make: () =>
      wrap((inner) => ({
        fetchRecent: async (args) => {
          const page = await inner.fetchRecent(args);
          if (args.since !== undefined || page.messages.length === 0) return page;
          const all = await inner.fetchRecent({ topic: args.topic, limit: 10_000 });
          if (all.messages.length === page.messages.length) return page;
          return { ...page, nextCursor: page.messages[0]!.cursor };
        },
      })),
  },
  {
    // The other half of "since at the tail returns empty and a stable cursor". The variant that
    // re-delivers the newest message is caught by the EMPTINESS assertion; a cursor that drifts
    // while the page stays empty is caught by nothing else, and the catch-up loop it produces never
    // settles — every poll reports a new cursor for the same drained window.
    name: 'a tail cursor that drifts while the page stays empty',
    mutates: 'nextCursor-stability',
    mustFail: 'since at the tail',
    make: () =>
      wrap((inner) => ({
        fetchRecent: async (args) => {
          const page = await inner.fetchRecent(args);
          if (args.since === undefined || page.messages.length > 0) return page;
          const all = await inner.fetchRecent({ topic: args.topic, limit: 10_000 });
          const newest = all.messages.at(-1);
          if (newest === undefined || String(newest.cursor) !== String(args.since)) return page;
          return { ...page, nextCursor: asCursor(`${String(page.nextCursor)}-drift`) };
        },
      })),
  },
  {
    // A server-side page cap the plugin does not enforce, or an off-by-one in the slice. Nothing
    // produced an over-long page, so `limit` could stop being honoured entirely — and a caller
    // paging with a bounded window would silently read past it.
    name: 'a page one row longer than the limit it was given',
    mutates: 'limit-honoured',
    mustFail: 'paging from a cursor with limit',
    make: () =>
      wrap((inner) => ({
        fetchRecent: (args) =>
          args.limit === undefined
            ? inner.fetchRecent(args)
            : inner.fetchRecent({ ...args, limit: args.limit + 1 }),
      })),
  },
  {
    // The blocking arm's TIMING assertion — "it woke on the message, not on the budget expiring" —
    // which every fixture in this package used to be on the wrong side of the flag to reach. This
    // plugin returns the right messages under the right cursor; all it does is ignore the wake.
    name: 'a native blocking read that returns at the budget instead of on the message',
    mutates: 'fetchRecent',
    mustFail: 'blockMs is honoured natively or ignored promptly',
    make: () =>
      wrap(
        (inner) => ({
          fetchRecent: async (args) => {
            const page = await inner.fetchRecent({ ...args, blockMs: undefined });
            if (args.since === undefined || args.blockMs === undefined) return page;
            if (page.messages.length > 0) return page;
            await new Promise((resolve) => setTimeout(resolve, Math.min(args.blockMs, 4_200)));
            return inner.fetchRecent({ ...args, blockMs: undefined });
          },
        }),
        { supportsBlockingFetch: true },
      ),
  },
  {
    // The blocking arm's empty-timeout cursor. A drained long-poll that reports a MOVED cursor makes
    // the caller's next `since` skip a window it never read, and only the native arm passes a
    // `blockMs` that is allowed to expire empty.
    name: 'a native blocking read whose cursor moves on an empty timeout',
    mutates: 'nextCursor-stability',
    mustFail: 'blockMs is honoured natively or ignored promptly',
    make: () =>
      wrap(
        (inner) => ({
          fetchRecent: async (args) => {
            const page = await inner.fetchRecent(args);
            if (args.since === undefined || args.blockMs === undefined) return page;
            if (page.messages.length > 0) return page;
            return { ...page, nextCursor: asCursor(`${String(page.nextCursor)}-drift`) };
          },
        }),
        { supportsBlockingFetch: true },
      ),
  },
  {
    // The lost-wakeup race on the arm that actually blocks. The variant below it takes the same
    // shape on a polling backend; with every fixture declaring the polling arm, the true arm of the
    // 0-3 ms case had no control at all and could be deleted with this package green.
    name: 'a native blocking read that parks from now instead of at the caller cursor',
    mutates: 'fetchRecent',
    mustFail: 'blocking fetch is not missed',
    make: () =>
      wrap(
        (inner) => ({
          fetchRecent: async (args) => {
            const page = await inner.fetchRecent({ ...args, blockMs: undefined });
            if (args.since === undefined || args.blockMs === undefined) return page;
            if (page.messages.length > 0) return page;
            await new Promise((resolve) => setTimeout(resolve, 10));
            const all = await inner.fetchRecent({ topic: args.topic, limit: 10_000 });
            return { messages: [], nextCursor: all.nextCursor };
          },
        }),
        { supportsBlockingFetch: true },
      ),
  },
  {
    // Declaring `identity` not carried buys a WEAKER contract, not none: whoever the sender turns
    // out to be, it is ONE account and core routes and displays it. Every fixture here declared the
    // capability true, so the whole false arm — the only thing keeping that flag honest — ran
    // nowhere and could be deleted with this package green.
    name: 'a scrambled senderHandle on a backend that declares identity not carried',
    mutates: 'senderHandle',
    mustFail: 'not collapsed onto one another',
    make: () =>
      wrap(
        (inner) => ({
          fetchRecent: async (args) => {
            const page = await inner.fetchRecent(args);
            return {
              ...page,
              messages: page.messages.map((m, i) => ({ ...m, senderHandle: `who-${i}` as Handle })),
            };
          },
        }),
        { carriesSenderIdentity: false },
      ),
  },
  {
    // The same flag one clause over: `expectWellFormedMessage` drops its `senderHandle` EQUALITY
    // check on the false arm and keeps the non-emptiness one, and nothing declaring that arm could
    // fail it.
    name: 'a blank senderHandle on a backend that declares identity not carried',
    mutates: 'senderHandle',
    mustFail: 'in order, with unique ids and distinct cursors',
    make: () =>
      wrap(
        (inner) => ({
          fetchRecent: async (args) => {
            const page = await inner.fetchRecent(args);
            return {
              ...page,
              messages: page.messages.map((m) => ({ ...m, senderHandle: '' as Handle })),
            };
          },
        }),
        { carriesSenderIdentity: false },
      ),
  },
  {
    // The half of teardown the case could not see: a loop that outlives `disconnect()` and goes
    // round once more, pushing into a handler core believes is gone. Until the case watched the
    // handler across a settle window its `expect(live).toHaveLength(1)` could not fail — nothing
    // between the teardown and the assertion could have delivered anything.
    name: 'a disconnect that leaves its poll loop delivering',
    mutates: 'disconnect-stops-live-delivery',
    mustFail: 'disconnect is idempotent',
    make: () =>
      wrap((inner) => {
        const registered: { topic: Topic; handler: MessageHandler }[] = [];
        let torn = false;
        return {
          subscribe: async (topic, handler) => {
            registered.push({ topic, handler });
            await inner.subscribe(topic, handler);
          },
          disconnect: async () => {
            if (!torn) {
              torn = true;
              for (const s of registered) {
                const last = (await inner.fetchRecent({ topic: s.topic, limit: 1 })).messages.at(-1);
                if (last !== undefined) setTimeout(() => s.handler(last), 10);
              }
            }
            await inner.disconnect();
          },
        };
      }),
  },
  {
    // The id `post` RETURNS, which core stores as the dedup key without reading the topic back.
    // Catch-up stays honest here, so only the assertions over post's own return value can see it.
    name: 'a post that returns one id for every message',
    mutates: 'post',
    mustFail: 'in order, with unique ids and distinct cursors',
    make: () =>
      wrap((inner) => ({
        post: async (t, i, c, o) => {
          await inner.post(t, i, c, o);
          return asBackendMsgId('one-id-for-all');
        },
      })),
  },
];
