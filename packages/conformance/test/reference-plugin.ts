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
import type { ConformanceContext } from '@sharptrick/parley-conformance';

/**
 * An in-memory backend that is conformant BY CONSTRUCTION — the suite's reference control.
 *
 * Every real backend needs a server, so on a machine with none reachable the suite grades nothing
 * at all and a weakened assertion is invisible. This plugin always runs, and the broken variants
 * below are the negative control: each must fail at least one named case, which is what stops an
 * assertion in the suite from quietly becoming vacuous.
 */
export class ReferencePlugin implements BackendPlugin {
  private seq = 0;
  private connected = false;
  private readonly log = new Map<string, Message[]>();
  private readonly live = new Map<string, MessageHandler[]>();

  connect(_config: BackendConfig): Promise<void> {
    this.connected = true;
    return Promise.resolve();
  }

  disconnect(): Promise<void> {
    this.connected = false;
    this.live.clear();
    return Promise.resolve();
  }

  async subscribe(topic: Topic, handler: MessageHandler): Promise<void> {
    this.require();
    this.live.set(String(topic), [...(this.live.get(String(topic)) ?? []), handler]);
  }

  async post(
    topic: Topic,
    identity: Handle,
    content: string,
    _opts?: { inReplyTo?: BackendMsgId },
  ): Promise<BackendMsgId> {
    this.require();
    const id = String(++this.seq).padStart(12, '0');
    const message = buildMessage({
      topic,
      sender: String(identity),
      content,
      timestamp: new Date().toISOString(),
      id,
    });
    this.log.set(String(topic), [...(this.log.get(String(topic)) ?? []), message]);
    for (const handler of this.live.get(String(topic)) ?? []) handler(message);
    return asBackendMsgId(id);
  }

  async fetchRecent(args: FetchRecentArgs): Promise<FetchRecentResult> {
    this.require();
    const history = this.log.get(String(args.topic)) ?? [];
    const limit = args.limit ?? 100;
    if (args.since === undefined) {
      const window = history.slice(Math.max(0, history.length - limit));
      return { messages: window, nextCursor: this.tail(window, args.since) };
    }
    const after = history.filter((m) => String(m.cursor) > String(args.since)).slice(0, limit);
    return { messages: after, nextCursor: this.tail(after, args.since) };
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

async function context(plugin: BackendPlugin): Promise<ConformanceContext> {
  await plugin.connect({});
  return {
    plugin,
    freshTopic: (): Topic => asTopic(`ref-${++seq}-${Math.random().toString(36).slice(2, 8)}`),
    cleanup: () => plugin.disconnect(),
    concurrentPost: async (topic: Topic, writers: number, perWriter: number) => {
      await Promise.all(
        Array.from({ length: writers }, async (_unused, w) => {
          for (let i = 0; i < perWriter; i++) {
            await plugin.post(topic, `w${w}` as Handle, `w${w}-${i}`);
          }
        }),
      );
    },
    supportsBlockingFetch: false,
    carriesSenderIdentity: true,
    absentTopicBehaviour: 'empty-page',
  };
}

export const makeReferenceContext = (): Promise<ConformanceContext> => context(new ReferencePlugin());

/**
 * A reference plugin taking the OTHER arm of the seam's absent-topic MAY: it throws
 * `NoSuchTopicError` for a topic nothing has been posted to. Without this nothing in the repo
 * produces that error for the suite (or for core's mapping of it) to grade.
 */
export const makeThrowingReferenceContext = async (): Promise<ConformanceContext> => {
  const inner = new ReferencePlugin();
  const posted = new Set<string>();
  const plugin: BackendPlugin = {
    connect: (c) => inner.connect(c),
    disconnect: () => inner.disconnect(),
    subscribe: (t, h) => inner.subscribe(t, h),
    post: async (t, i, c, o) => {
      posted.add(String(t));
      return inner.post(t, i, c, o);
    },
    fetchRecent: async (args) => {
      if (!posted.has(String(args.topic))) throw new NoSuchTopicError(String(args.topic));
      return inner.fetchRecent(args);
    },
    resolveIdentity: (h) => inner.resolveIdentity(h),
  };
  return { ...(await context(plugin)), absentTopicBehaviour: 'throws' };
};

/** One wrapper per way a plugin can be non-conformant, and the case each one must break. */
export interface BrokenVariant {
  name: string;
  /** A case title the suite MUST fail for this variant. */
  mustFail: string;
  make: () => Promise<ConformanceContext>;
}

const wrap = async (
  over: (inner: ReferencePlugin) => Partial<BackendPlugin>,
): Promise<ConformanceContext> => {
  const inner = new ReferencePlugin();
  const base: BackendPlugin = {
    connect: (c) => inner.connect(c),
    disconnect: () => inner.disconnect(),
    subscribe: (t, h) => inner.subscribe(t, h),
    post: (t, i, c, o) => inner.post(t, i, c, o),
    fetchRecent: (a) => inner.fetchRecent(a),
    resolveIdentity: (h) => inner.resolveIdentity(h),
  };
  return context({ ...base, ...over(inner) });
};

export const BROKEN_VARIANTS: BrokenVariant[] = [
  {
    name: 'inclusive since',
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
    mustFail: 'never-posted topic',
    make: async () => {
      const ctx = await makeThrowingReferenceContext();
      const inner = ctx.plugin;
      const posted = new Set<string>();
      return {
        ...ctx,
        plugin: {
          connect: (c) => inner.connect(c),
          disconnect: () => inner.disconnect(),
          subscribe: (t, h) => inner.subscribe(t, h),
          resolveIdentity: (h) => inner.resolveIdentity(h),
          post: async (t, i, c, o) => {
            posted.add(String(t));
            return inner.post(t, i, c, o);
          },
          fetchRecent: async (args) => {
            if (!posted.has(String(args.topic))) throw new Error('nope');
            return inner.fetchRecent(args);
          },
        },
      };
    },
  },
  {
    // The pre-commit-sequence hazard, in memory: report the tail row's cursor while withholding the
    // row itself, exactly as a BIGSERIAL reader sees seq 42 committed while 41 is not. Only a reader
    // placed INSIDE the write window can see it.
    name: 'a cursor that advances past a row it did not return',
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
    mustFail: 'either round-trips',
    make: () =>
      wrap((inner) => ({
        post: (t, i, c, o) => inner.post(t, i, c.replace(/\s+/gu, ' ').trim(), o),
      })),
  },
  {
    name: 'a fetch that parks forever on blockMs',
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
];
