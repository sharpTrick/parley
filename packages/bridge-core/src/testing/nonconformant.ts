import { asBackendMsgId, asCursor, asHandle, type Cursor, type Message, type Topic } from '../message.js';
import type { BackendPlugin, FetchRecentArgs, FetchRecentResult } from '../seam.js';

/**
 * Backend shapes the seam does NOT forbid but a conformant plugin never produces: a cursor that
 * stands still or walks backwards, a page longer than the requested `limit`, an empty page carrying
 * a brand-new cursor, and a history API that caps its page below the `limit` it was asked for
 * (Discord's 100-message ceiling, Telegram, Matrix `/messages`).
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
export type ServePage = (args: FetchRecentArgs, call: number) => FetchRecentResult;

/**
 * How many messages a driver that pages to exhaustion must drain from each shape, or `undefined`
 * where the shape is deliberately unbounded and only TERMINATION is required.
 */
export interface NonconformantShape {
  serve: ServePage;
  drains?: number;
}

export const NONCONFORMANT_SHAPES: Record<string, NonconformantShape> = {
  'a full page whose cursor never advances': {
    serve: (a) => ({ messages: [row(a.topic, 1), row(a.topic, 2)], nextCursor: asCursor('stuck') }),
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
  'an empty page carrying a fresh cursor every call': {
    serve: (a, call) => ({ messages: [], nextCursor: asCursor(`fresh-${call}`) }),
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
  get(topic: Topic): Cursor | undefined;
  set(topic: Topic, cursor: Cursor): void;
} {
  const state = new Map<Topic, Cursor>();
  return {
    path: '<memory>',
    get: (topic) => state.get(topic),
    set: (topic, cursor) => {
      state.set(topic, cursor);
    },
  };
}
