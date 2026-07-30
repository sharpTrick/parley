/**
 * The `pg` driver, faked once for the whole package: the Pool/Client surface this plugin drives
 * (below), and PostgreSQL's answer to the read shapes its push and catch-up paths depend on:
 * `SELECT seq::text AS seq … WHERE topic = $1 [AND seq > $n::bigint] ORDER BY … LIMIT …`.
 *
 * A fake that hands rows back from a queue honours the cursor predicate and the ordering for free,
 * so the drain loop's ascending-and-exactly-once guarantee would be asserted against a mock that
 * SUPPLIES it rather than against the query that has to earn it. So the sort key, the direction and
 * the limit are all read out of the SQL text, and — the part a fake usually gets wrong — the sort
 * models how PostgreSQL actually RESOLVES `ORDER BY seq`: a bare `seq` binds to the `seq::text AS
 * seq` OUTPUT alias and sorts lexicographically ('9' > '10'), while `<table>.seq` binds to the
 * bigint column and sorts numerically. Serving a bare spelling numerically would make the fake
 * kinder than the server and hide real message loss.
 *
 * A shape this file cannot classify is an ERROR, never a default: silently serving an unrecognised
 * SELECT in ascending order is how a rewritten query passes a suite that no longer grades it.
 */

import { EventEmitter } from 'node:events';

export type FakeRow = Record<string, unknown>;

const TOPIC_READ = /SELECT seq::text AS seq[\s\S]*WHERE topic = \$1/;
const CURSOR_WINDOW = /seq > \$(\d+)::bigint/;
const LITERAL_LIMIT = /LIMIT (\d+)/;
const PARAM_LIMIT = /LIMIT \$(\d+)/;
const QUALIFIED_ORDER = /ORDER BY\s+"?\w+"?\.seq\s+(ASC|DESC)/i;
const BARE_ORDER = /ORDER BY\s+seq\s+(ASC|DESC)/i;

/** How the server would sort this SQL: which key `ORDER BY` resolves to, and in which direction. */
interface Ordering {
  descending: boolean;
  /** `numeric` when the sort key is the bigint column, `text` when it is the `::text` alias. */
  key: 'numeric' | 'text';
}

function ordering(sql: string): Ordering {
  const qualified = QUALIFIED_ORDER.exec(sql);
  if (qualified !== null) {
    return { descending: qualified[1]?.toUpperCase() === 'DESC', key: 'numeric' };
  }
  const bare = BARE_ORDER.exec(sql);
  if (bare !== null) {
    return { descending: bare[1]?.toUpperCase() === 'DESC', key: 'text' };
  }
  throw new Error(
    `fake-pg cannot tell how PostgreSQL would order this read, so it refuses to guess: ${sql}`,
  );
}

function seqOf(row: FakeRow): bigint {
  return BigInt(String(row['seq']));
}

function compare(a: FakeRow, b: FakeRow, key: Ordering['key']): number {
  if (key === 'text') return String(a['seq']).localeCompare(String(b['seq']));
  const d = seqOf(a) - seqOf(b);
  return d === 0n ? 0 : d < 0n ? -1 : 1;
}

function limitOf(sql: string, values: readonly unknown[]): number {
  const literal = LITERAL_LIMIT.exec(sql);
  if (literal !== null) return Number(literal[1]);
  const param = PARAM_LIMIT.exec(sql);
  if (param !== null) return Number(values[Number(param[1]) - 1]);
  throw new Error(`fake-pg expects every read to carry a LIMIT: ${sql}`);
}

function serveTopicRead(
  all: readonly FakeRow[],
  sql: string,
  values: readonly unknown[],
): FakeRow[] {
  const window = CURSOR_WINDOW.exec(sql);
  const since = window !== null ? BigInt(String(values[Number(window[1]) - 1])) : undefined;
  const order = ordering(sql);
  return all
    .filter((r) => since === undefined || seqOf(r) > since)
    .sort((a, b) => (order.descending ? -1 : 1) * compare(a, b, order.key))
    .slice(0, limitOf(sql, values));
}

/** Serve whichever read shape the SQL is, or `undefined` for anything that is not a read. */
export function servePool(
  all: readonly FakeRow[],
  sql: string,
  values: readonly unknown[],
): FakeRow[] | undefined {
  if (/MAX\(seq\)/.test(sql)) {
    const max = all.reduce((m, r) => (seqOf(r) > m ? seqOf(r) : m), 0n);
    return [{ max: String(max) }];
  }
  if (TOPIC_READ.test(sql)) return serveTopicRead(all, sql, values);
  return undefined;
}

export interface FakeQueryResult {
  rows: unknown[];
  rowCount?: number;
}

export type FakePoolQuery = (
  sql: string,
  values: readonly unknown[],
) => Promise<FakeQueryResult>;

export interface FakePooledClient {
  query: (sql?: string, values?: readonly unknown[]) => Promise<FakeQueryResult>;
  release: () => void;
}

const bootstrapClient = (): FakePooledClient => ({
  query: async () => ({ rows: [] }),
  release: () => undefined,
});

/**
 * The `on`/`emit` plumbing every driver fake here needs, with Node's real event semantics — an
 * 'error' emitted while nothing is listening THROWS. Keep the fakes on this rather than a handlers
 * record, so that a missing `on('error')` in the plugin fails a case instead of being absorbed.
 */
export class FakeEmitter extends EventEmitter {}

/** `pg.Pool` reduced to the surface this plugin drives, on those same event semantics. */
export class FakePool extends FakeEmitter {
  constructor(
    private readonly onQuery: FakePoolQuery = async () => ({ rows: [] }),
    private readonly checkout: () => FakePooledClient = bootstrapClient,
  ) {
    super();
  }

  async connect(): Promise<FakePooledClient> {
    return this.checkout();
  }

  async query(sql: string, values?: readonly unknown[]): Promise<FakeQueryResult> {
    return this.onQuery(sql, values ?? []);
  }

  async end(): Promise<void> {}
}

export function fakePool(onQuery?: FakePoolQuery, checkout?: () => FakePooledClient): FakePool {
  return new FakePool(onQuery, checkout);
}

/** `pg.Client` that answers nothing, for the suites whose subject is not the connection. */
export class FakeIdleClient extends FakeEmitter {
  async connect(): Promise<void> {}

  async query(): Promise<FakeQueryResult> {
    return { rows: [] };
  }

  async end(): Promise<void> {}

  release(): void {}
}
