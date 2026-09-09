import {
  asBackendMsgId,
  asCursor,
  asHandle,
  asTopic,
  type Cursor,
  type Message,
  type Topic,
} from '../message.js';
import type { BackendPlugin, FetchRecentArgs, FetchRecentResult } from '../seam.js';

/**
 * Backend shapes the seam does NOT forbid but a conformant plugin never produces: a cursor that
 * stands still or walks backwards, a cursor re-serialised differently each call, a page longer than
 * the requested `limit`, an empty page carrying a brand-new cursor, and a history API that caps its
 * page below the `limit` it was asked for (Discord's 100-message ceiling, Telegram, Matrix
 * `/messages`).
 *
 * Core's page-driven loops are the only thing standing between these and a bridge that never
 * finishes starting up, so every driver that pages must be run against ALL of them, not against the
 * one shape whose guard it happens to own.
 */
const SENDER = asHandle('writer');

function row(topic: Topic, n: number): Message {
  return {
    topic,
    senderHandle: SENDER,
    content: `m${n}`,
    timestamp: '1970-01-01T00:00:00.000Z',
    backendMsgId: asBackendMsgId(String(n)),
    cursor: asCursor(String(n)),
    mentions: [],
  };
}

/** Rows `(since, since + count]` out of a corpus of `total`, as a page. */
function window(args: FetchRecentArgs, count: number, total: number): FetchRecentResult {
  const from = args.since === undefined ? 0 : Number(args.since);
  const ns = Array.from({ length: total }, (_unused, i) => i + 1).filter((n) => n > from).slice(0, count);
  const messages = ns.map((n) => row(args.topic, n));
  return {
    messages,
    nextCursor: messages.at(-1)?.cursor ?? args.since ?? asCursor('0'),
  };
}

/** Serves one page; `call` is the 0-based index of this call on the plugin. */
type ServePage = (args: FetchRecentArgs, call: number) => FetchRecentResult;

/**
 * How many messages a driver that pages to exhaustion must drain from each shape, or `undefined`
 * where the shape is deliberately unbounded and only TERMINATION is required.
 */
interface NonconformantShape {
  serve: ServePage;
  drains?: number;
}

export const NONCONFORMANT_SHAPES: Record<string, NonconformantShape> = {
  'a full page whose cursor never advances': {
    serve: (a) => ({ messages: [row(a.topic, 1), row(a.topic, 2)], nextCursor: asCursor('stuck') }),
  },
  'a full page whose cursor names one position but is spelled differently each call': {
    serve: (a, call) => ({
      messages: [row(a.topic, 1), row(a.topic, 2)],
      nextCursor: asCursor(
        JSON.stringify(call % 2 === 0 ? { seq: 2, topic: a.topic } : { topic: a.topic, seq: 2 }),
      ),
    }),
  },
  'a cursor that walks backwards, then forwards again': {
    serve: (a, call) => ({
      messages: [row(a.topic, 1), row(a.topic, 2)],
      nextCursor: asCursor(call % 2 === 0 ? '5' : '3'),
    }),
  },
  'a page LONGER than the requested limit': {
    serve: (a) => window(a, (a.limit ?? 100) + 5, 12),
    drains: 12,
  },
  // Sized past every server-side cap core applies to a page (the fetch limit, the per-topic dedup
  // window), so that a shape meant to probe them can actually reach them.
  'a page longer than every server-side cap': {
    serve: (a) => window(a, 6_000, 6_000),
    drains: 6_000,
  },
  'an empty page carrying a fresh cursor every call': {
    serve: (_a, call) => ({ messages: [], nextCursor: asCursor(`fresh-${call}`) }),
    drains: 0,
  },
  'a history API that caps its page below the requested limit': {
    serve: (a) => window(a, 100, 250),
    drains: 250,
  },
  'a conformant finite topic (the control)': {
    serve: (a) => window(a, a.limit ?? 100, 7),
    drains: 7,
  },
};

export const NONCONFORMANT_SHAPE_NAMES = Object.keys(NONCONFORMANT_SHAPES);

/**
 * The topics a delivery COARSER than one topic hands core alongside the one it was asked for: a NATS
 * wildcard subject, a Matrix room carrying several logical topics, a Slack channel doubling as two.
 * Every agent-facing path has to answer the same way about each of them, or a guard that holds on
 * one path is walked around on its sibling.
 */
export const FOREIGN_TOPIC_KINDS: Array<[name: string, topic: string]> = [
  ['an unconfigured topic', 'secret-ops'],
  ['a topic a post pattern allows but nothing subscribes to', 'ctx-pattern-only'],
];

/**
 * A plugin whose history read is COARSER than a topic: every page carries the requested topic's
 * message plus one on each of {@link FOREIGN_TOPIC_KINDS}. The seam does not forbid it — it is what a
 * wildcard subscription or a shared room produces — so every driver that reads pages must be run
 * against it, not only against fixtures that pre-filter by topic.
 */
export function coarseDelivery(
  alsoCarry: readonly string[] = [],
  opts: {
    /**
     * Whether a page for topic X carries any message ON X. `false` is the shared room that is busy
     * with everyone else's traffic — the page a reader has to treat as "nothing arrived for me".
     */
    carryOwn?: boolean;
  } = {},
): {
  plugin: BackendPlugin;
  /** Push one message on `topic` to every live subscriber, whatever topic they subscribed to. */
  push(topic: string, n: number): void;
} {
  const handlers: Array<(m: Message) => void> = [];
  const plugin = {
    connect: () => Promise.resolve(),
    disconnect: () => Promise.resolve(),
    subscribe: (_topic: Topic, h: (m: Message) => void) => {
      handlers.push(h);
      return Promise.resolve();
    },
    post: () => Promise.resolve(asBackendMsgId('1')),
    resolveIdentity: (handle: unknown) => Promise.resolve({ handle, backendRef: handle }),
    fetchRecent: (args: FetchRecentArgs): Promise<FetchRecentResult> => {
      const foreign = [...FOREIGN_TOPIC_KINDS.map(([, t]) => t), ...alsoCarry].filter(
        (t) => t !== args.topic,
      );
      const own = opts.carryOwn === false ? [] : [row(args.topic, 1)];
      const messages = [...own, ...foreign.map((t, i) => row(asTopic(t), i + 2))];
      return Promise.resolve({
        messages,
        nextCursor: messages.at(-1)?.cursor ?? args.since ?? asCursor('0'),
      });
    },
  } as unknown as BackendPlugin;
  return {
    plugin,
    push: (topic, n) => {
      for (const h of handlers) h(row(asTopic(topic), n));
    },
  };
}

/** A plugin serving `shape`, recording every `fetchRecent` it is asked for. */
export function pagingProbe(serve: ServePage): { plugin: BackendPlugin; calls: FetchRecentArgs[] } {
  const calls: FetchRecentArgs[] = [];
  const plugin = {
    fetchRecent: (args: FetchRecentArgs): Promise<FetchRecentResult> => {
      const result = serve(args, calls.length);
      calls.push(args);
      return Promise.resolve(result);
    },
  } as unknown as BackendPlugin;
  return { plugin, calls };
}

/**
 * A read-state that keeps the cursor in memory. The adversarial shapes below deliberately drive
 * thousands of pages, and a real {@link ReadStateStore} would turn each one into a
 * read-merge-write-rename — which is itself part of the damage the bounded loop prevents, and is
 * measured separately.
 */
export function memoryReadState(): {
  path: string;
  warmPath: string;
  get(topic: Topic): Cursor | undefined;
  set(topic: Topic, cursor: Cursor): void;
  warmedThrough(topic: Topic): Cursor | undefined;
  markWarmed(topic: Topic, cursor: Cursor): void;
} {
  const state = new Map<Topic, Cursor>();
  const warmed = new Map<Topic, Cursor>();
  return {
    path: '<memory>',
    warmPath: '<memory:warmed>',
    get: (topic) => state.get(topic),
    set: (topic, cursor) => {
      state.set(topic, cursor);
    },
    warmedThrough: (topic) => warmed.get(topic),
    markWarmed: (topic, cursor) => {
      warmed.set(topic, cursor);
    },
  };
}
