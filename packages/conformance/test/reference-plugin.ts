import {
  asBackendMsgId,
  asCursor,
  assertBlockMsUnsupported,
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
  safeDeliver,
  type Topic,
} from '@sharptrick/parley-core';
import {
  CALLER_BLOCK_RETURN_MS,
  carriesControlCharacter,
  type ConformanceContext,
  CONTENT_SHAPES,
  DELIVERY_MS,
  isPlainAscii,
  EARLY_RETURN_FRACTION,
  IDLE_BLOCK_MS,
  OVERSHOOT_MULTIPLE,
  PARK_FRACTION,
  PROBE_MAX_BLOCK_MS,
  QUIET_BACKLOG_ROWS,
  QUIET_DELIVERY_MS,
  QUIET_IDLE_MS,
  QUIET_POSTS,
  QUIET_POSTS_MIN,
  RACE_BLOCK_MS,
  REFUSAL_RETURN_MS,
  SINCELESS_BLOCK_MS,
  SINCELESS_RETURN_MS,
  STABILITY_CALLER_READS,
  STABILITY_READS_MIN,
  SHORT_PAYLOAD,
  STABILITY_SPAN_MS,
  TAIL_BLOCK_MS,
  TOOL_BACKLOG_MIN,
} from '@sharptrick/parley-conformance';

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
    for (const s of this.store.subscriptions) if (s.topic === String(topic)) safeDeliver(s.handler, () => message);
    for (const wake of this.store.writes.splice(0)) wake();
    return asBackendMsgId(id);
  }

  /**
   * The two arms of the `blockMs` contract, both honoured for real. A `blocking` reference WAITS —
   * the suite grades waking on the message rather than on the budget, and a poll would satisfy that
   * by accident — and keeps the read and the waiter in ONE synchronous turn, so that a write landing
   * between them cannot be lost; that window is what the suite's 0-3 ms race case exists to open.
   * A non-`blocking` reference REFUSES, exactly as every backend with nowhere to park does.
   */
  async fetchRecent(args: FetchRecentArgs): Promise<FetchRecentResult> {
    this.require();
    if (!this.blocking) assertBlockMsUnsupported('reference', args.blockMs);
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
 * an axis: a flag no fixture ever takes the other arm of is a flag whose weaker contract is graded
 * nowhere. Every fixture below states which arm it takes, and `BROKEN_VARIANTS` covers both.
 */
type Capabilities = Pick<ConformanceContext, 'carriesSenderIdentity' | 'refusesContentShapes'>;

const DEFAULT_CAPABILITIES: Capabilities = {
  carriesSenderIdentity: true,
  refusesContentShapes: [],
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
 * The positive control on the BLOCKING arm — a reference that really honours `blockMs` inside
 * `fetchRecent`, as Redis and NATS do over their own read primitives. Without it the suite's
 * native-blocking assertions are satisfiable by nothing in this repo, which is indistinguishable
 * from their being deleted.
 */
export const makeBlockingReferenceContext = (): Promise<ConformanceContext> => {
  const store = newReferenceStore();
  return context(new ReferencePlugin(store, true), store);
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
  /**
   * How many of the suite's cases this variant may fail. A control is only evidence for the case it
   * names when the rest of the suite still PASSES for it: one that fails most of the suite proves
   * its target assertion is alive no better than a plugin that answers nothing at all, and the
   * negative control — which bounded the count only from below — could not tell the two apart.
   * Declared per variant rather than inferred, so a mutation that starts breaking more than it was
   * built to break reddens here instead of reading as coverage. Default {@link NARROW_BLAST_RADIUS}.
   */
  blastRadius?: number;
  make: () => Promise<ConformanceContext>;
}

/**
 * What a variant may fail without saying so: its own case, plus the handful that read through the
 * same field. Deliberately small — a variant needing more has to state the figure, which is the
 * moment to ask whether it is still aimed at anything.
 */
const NARROW_BLAST_RADIUS = 4;

/**
 * Rows an imagined server-side batch holds. Two variants below misbehave only ABOVE it, which is
 * what keeps them aimed: every clause but the two concurrency ones works on a handful of messages,
 * so a defect conditioned on a topic this large reaches those two and nothing else.
 */
const SERVER_BATCH = 50;

/**
 * The widest any control may be declared, whatever it corrupts. `since` is threaded through most of
 * the suite, so the one variant that re-delivers at a cursor legitimately reaches half of it — but
 * past half a control has stopped discriminating, and no figure recorded here can buy that back.
 *
 * The two handler-fault controls scale with the SHARED fault table rather than with anything they
 * corrupt: each fails one row per rejecting shape per fault position, so a shape added to
 * `FAILURE_SHAPES` widens them by {@link FAULT_POSITIONS_PER_SHAPE}. That is what raised this from
 * 16, and it stays a bound on the same terms — the row beside it still refuses anything past half
 * the suite.
 */
export const MAX_BLAST_RADIUS = 18;

/** Positions in a run the shared clause drives each fault shape at (first, middle, every). */
const FAULT_POSITIONS_PER_SHAPE = 3;

/**
 * Shapes whose failure arrives as a REJECTION. A control that never attaches to what the handler
 * returned fails one row per one of these per position, and nothing else — which is exactly what
 * keeps it aimed at "survives a handler that".
 */
const REJECTING_SHAPES = 4;

/** Shapes a live path can be handed that a control mistaking one for a backend fault will misreport. */
const NON_STALLING_SHAPES = 6;

export const blastRadiusOf = (v: BrokenVariant): number => v.blastRadius ?? NARROW_BLAST_RADIUS;

/**
 * `nativeBlocking` picks which arm of the `blockMs` contract the INNER plugin takes — parking on a
 * budget, or refusing it — so that the only thing failing an arm is the wrapper's own defect and not
 * a fixture that could not have served the budget in the first place.
 */
const wrap = async (
  over: (inner: ReferencePlugin, store: ReferenceStore) => Partial<BackendPlugin>,
  opts: Partial<Capabilities> & { nativeBlocking?: boolean } = {},
): Promise<ConformanceContext> => {
  const { nativeBlocking = false, ...caps } = opts;
  const store = newReferenceStore();
  const inner = new ReferencePlugin(store, nativeBlocking);
  return context({ ...delegate(inner), ...over(inner, store) }, store, caps);
};

/**
 * Ways a plugin can return an id from `post` that is unique, stable, and NOT the id its own read
 * paths report for that message. Every uniqueness assertion in the suite passes for each of these,
 * so only the agreement assertions can see them.
 *
 * `identity` is deliberately not a row: it is the conformant plugin, and a variant that fails
 * nothing is exactly the vacuous control this table exists to forbid. Nor is an uppercasing
 * re-spelling, which is the identity on the reference plugin's numeric ids for the same reason.
 */
const POST_ID_RESPELLINGS: [label: string, spell: (id: string, topic: string) => string][] = [
  ['under a prefix', (id) => `msg-${id}`],
  // Telegram's `<chat_id>:<message_id>` is a composite the write and read paths build separately.
  ['as a composite key the read path builds differently', (id, topic) => `${topic}:${id}`],
];

const respelledPostId = ([label, spell]: [
  string,
  (id: string, topic: string) => string,
]): BrokenVariant => ({
  name: `a post that returns its id ${label}`,
  mutates: 'post-id-agreement',
  mustFail: 'in order, with unique ids and distinct cursors',
  make: () =>
    wrap((inner) => ({
      post: async (t, i, c, o) =>
        asBackendMsgId(spell(String(await inner.post(t, i, c, o)), String(t))),
    })),
});

/**
 * The mark each broken variant's suite is registered under. Keep it in one place, so that the
 * negative control recovers a variant's name from a report row by an EXACT comparison rather than by
 * searching for one name inside another — one name here is a prefix of another, so a containment
 * match reads the sibling's failures as this variant's.
 */
export const BROKEN_SUITE_MARK = 'broken/';

export const brokenSuiteName = (name: string): string => `${BROKEN_SUITE_MARK}${name}`;


/**
 * The state an arm switch can be conditioned on. Every one of these is CONSTANT inside a case that
 * works on one topic, on a connection of its own, in a few hundred milliseconds — which is what
 * every blocking case except the long run is, and why three plugins built on exactly these
 * predicates passed the whole suite while ignoring every `block_ms` a real agent would send.
 */
interface SwitchPoint {
  /** Blocking reads this connection has taken, this one included. */
  call: number;
  /** How old the connection was when the read arrived. */
  connectionAgeMs: number;
  blockMs: number;
  topic: string;
  /** Rows the topic held when the budget arrived. */
  topicRows: number;
  /** The first topic this connection was handed a budget for. */
  firstTopic: string;
  /** Connections that have been handed a budget, this one included. */
  connection: number;
}

interface ArmSwitch {
  when: string;
  fires: (at: SwitchPoint) => boolean;
}

/** The budgets the suite hands out from a named constant — the only ones a plugin could enumerate. */
export const ENUMERABLE_BUDGETS = [SINCELESS_BLOCK_MS, TAIL_BLOCK_MS, RACE_BLOCK_MS, IDLE_BLOCK_MS, 5_000];

/**
 * Above what any case but the long run issues on one connection, and below the fewest that run
 * issues — so a switch on this count is invisible to every other case and certain inside that one.
 */
export const SWITCH_AFTER_CALLS = 10;

/**
 * The clock the long run is built to have a budget on both sides of, and which no other case comes
 * near. Set AT the window rather than inside it, so this row stays the tightest switch the run can
 * still catch: a control set safely inside would go on passing if the run stopped spanning it.
 */
const SWITCH_AFTER_MS = STABILITY_SPAN_MS;

/**
 * Above the deepest topic every OTHER case works on (one message) and below the depth the long run
 * seeds, so a switch on topic state is invisible to all of them and certain inside that one.
 */
const SWITCH_TOPIC_ROWS = 10;

/**
 * The count row at the far edge of the run's reach rather than at the near edge the first row
 * covers: `SWITCH_AFTER_CALLS` bounds the class only up to the fewest budgets the run hands out, so
 * a plugin switching just past that count answered the whole suite. The last read the run is
 * guaranteed to make is the one after this.
 */
const SWITCH_AFTER_MANY_CALLS = STABILITY_READS_MIN + STABILITY_CALLER_READS - 1;

/**
 * ONE mutation per way a switch can be hidden. The table is the point: the clause exists to forbid
 * a backend that honours the budgets a suite is known to ask for and drops the rest, and a control
 * per instance would leave the next predicate — a different count, a different clock, a different
 * key — free to pass.
 */
export const ARM_SWITCHES: ArmSwitch[] = [
  {
    when: `after the ${SWITCH_AFTER_CALLS}th budget on a connection`,
    fires: (at) => at.call > SWITCH_AFTER_CALLS,
  },
  {
    when: `once the connection is ${SWITCH_AFTER_MS}ms old`,
    fires: (at) => at.connectionAgeMs > SWITCH_AFTER_MS,
  },
  {
    when: 'on any budget the suite does not hand out from a constant',
    fires: (at) => at.blockMs > PROBE_MAX_BLOCK_MS && !ENUMERABLE_BUDGETS.includes(at.blockMs),
  },
  {
    when: 'on every topic but the first this connection was asked about',
    fires: (at) => at.topic !== at.firstTopic,
  },
  {
    when: 'on every connection but the first to be handed a budget',
    fires: (at) => at.connection > 1,
  },
  {
    // The one the drawn ranges alone cannot reach: every budget above is two orders of magnitude
    // below what an agent sends, so a plugin that honours what a suite hands out and drops what a
    // caller hands out answered every read the suite made and none of the reads that matter.
    when: 'on any budget larger than the largest the suite hands out from a constant',
    fires: (at) => at.blockMs > SINCELESS_BLOCK_MS,
  },
  {
    when: `once the topic holds more than ${SWITCH_TOPIC_ROWS} rows`,
    fires: (at) => at.topicRows > SWITCH_TOPIC_ROWS,
  },
  {
    when: `after the ${SWITCH_AFTER_MANY_CALLS}th budget on a connection`,
    fires: (at) => at.call > SWITCH_AFTER_MANY_CALLS,
  },
];

/**
 * A plugin that answers block budgets honestly until its predicate fires, and silently drops every
 * budget after that. On the REFUSING arm dropping the budget makes it answer with a page, so the arm
 * itself changes; on the SERVING arm it stays on the arm it was on and merely stops waiting — the
 * shape a real backend takes when a resource its blocking read needs runs out and is never released.
 * Both are the same defect, and only a check that spans cases and connections sees either.
 */
const armSwitch = (sw: ArmSwitch, nativeBlocking: boolean, blastRadius: number): BrokenVariant => {
  let connections = 0;
  return {
    name: `a read that stops honouring the budget ${sw.when}${nativeBlocking ? ', still serving' : ''}`,
    blastRadius,
    mutates: nativeBlocking ? 'native-block-waits-every-time' : 'blocking-arm-is-stable',
    mustFail: 'a long run of unpredictable budgets',
    make: () => {
      const openedAt = Date.now();
      let call = 0;
      let connection = 0;
      let firstTopic: string | undefined;
      return wrap(
        (inner, store) => ({
          fetchRecent: (args) => {
            if (args.blockMs === undefined || args.blockMs <= 0) return inner.fetchRecent(args);
            if (connection === 0) connection = ++connections;
            call += 1;
            firstTopic ??= String(args.topic);
            const at: SwitchPoint = {
              call,
              connectionAgeMs: Date.now() - openedAt,
              blockMs: args.blockMs,
              topic: String(args.topic),
              topicRows: (store.log.get(String(args.topic)) ?? []).length,
              firstTopic,
              connection,
            };
            return inner.fetchRecent(sw.fires(at) ? { ...args, blockMs: undefined } : args);
          },
        }),
        { nativeBlocking },
      );
    },
  };
};

/**
 * The state a live path can die AT. Every one of these is constant inside a case that subscribes to
 * a fresh topic, sends a handful of messages and sees them back within milliseconds — which is every
 * live case in the suite but the floor, and why a poll loop capped at three messages, one capped per
 * plugin, one that stops after 50ms and one that goes quiet on a busy topic all answered the whole
 * suite. The table is the point: the clause forbids a live path that recognises the shape of the
 * reads a suite is known to make, and a control per instance leaves the next threshold free to pass.
 *
 * THE REACH, MEASURED, so the next reader does not have to re-derive it:
 *  - COUNT, PER SUBSCRIPTION. The floor offers `INDEPENDENT_WRITERS + depth` ON ONE SUBSCRIPTION,
 *    depth drawn from [`QUIET_POSTS_MIN`, `QUIET_POSTS_MAX`] = 10..13, so 12..15 where the fixture
 *    has a second writer and 10..13 where `concurrentPost` is `'unsupported'`. A cap at 11 is caught
 *    every run; 12 and 13 are caught on SOME runs and 15 on none. A control inside the drawn range
 *    would fire on a fraction of runs, which is worse than no control at all — hence the far-edge
 *    row below sits at `QUIET_POSTS_MIN - 1`, the deepest cap every run is guaranteed to exceed on
 *    both arms. The SCOPE is the bound that matters and reads as though it were global: a cap
 *    counted per PLUGIN or per connection rather than per subscription is measured to pass at 20,
 *    because no case here offers one connection that many deliveries. There is no
 *    `connectionOffered` axis, and that is what closing it would take.
 *  - AGE reaches the span the floor holds a subscription idle mid-run (`QUIET_IDLE_MS`), plus
 *    whatever that run's own round trips cost. A path that dies at 3 s passes.
 *  - BACKLOG reaches `QUIET_BACKLOG_ROWS` = 10 rows already on the topic when the floor subscribes,
 *    which is the figure a path conditioned on how BUSY a topic is meets; the topic goes on to hold
 *    22–25 rows by the end of the case (20–23 where `concurrentPost` is `'unsupported'`), but those
 *    rows arrive one at a time with the subscription already open. A path that goes silent above 40
 *    passes.
 *  - LATENCY is one fixed bound per message; a path whose delay GROWS (150 ms per message, minutes
 *    late after a few hundred) passes.
 *  - ORDER reaches a burst drawn from [`BURST_POSTS_MIN`, `BURST_POSTS_MAX`] = 5..8, so a path that
 *    shuffles bursts of 5 is caught every run and one that only shuffles above 8 is caught on none.
 *  - SUBSCRIPTIONS reaches `LIVE_SUBSCRIPTIONS` = 3 on one connection: a path that registers its
 *    first two is caught, one that registers its first three is not, and a session whose allowlist
 *    is longer than three hears nothing on the rest.
 *  - VOCABULARY reaches a payload and a handle drawn per call, which forbids a plugin keyed on a
 *    LITERAL this package once wrote. One keyed on the SHAPE of a draw — `[a-z][0-9a-z]{0,8}` — is
 *    still outside it; what the CONTENT rows below reach is the complement the floor now sends.
 *  - CONTENT reaches the shapes in `CONTENT_SHAPES` THAT THE FIXTURE DID NOT DECLARE REFUSED: a
 *    payload past `SHORT_PAYLOAD` characters, one that is not plain ASCII, and one carrying a
 *    newline or a tab. A path sized against some other property of a real message — a mention, a
 *    code fence, a 4 kB paste — is outside it until that shape is a row in that table. A backend
 *    naming a label in `refusesContentShapes` withdraws that row from this axis, and the write
 *    clause then requires the refusal to be real; what it may NOT do is refuse silently, which
 *    while the floor fell back to a bare token bought a backend carrying nothing a person could
 *    type — on either path — a 36-of-36 certification.
 * Every one of these costs wall clock on every fixture and on every variant here, which is why they
 * are recorded rather than chased. None of them is CLOSED, and each has its control below at the far
 * edge of the reach a run guarantees.
 */
interface DeliveryPoint {
  /** Messages this subscription has been offered, this one included. */
  offered: number;
  /** How old the subscription was when the message arrived. */
  subscriptionAgeMs: number;
  /** Rows the topic held when it arrived. */
  topicRows: number;
  /** The message's payload, and the handle it was written under. */
  content: string;
  senderHandle: string;
}

/**
 * Which property of a delivery a row conditions on. Declared rather than recovered from {@link
 * LiveDeath.when}: the far-edge check below used to select the count rows by looking for a phrase
 * inside that human label, so renaming a row silently removed it from the check that keeps it
 * inside the floor's guaranteed reach, and a table with one count row left satisfied the `> 1`
 * that was supposed to notice.
 */
type DeathAxis = 'count' | 'age' | 'depth' | 'vocabulary' | 'content';

interface LiveDeath {
  when: string;
  axis: DeathAxis;
  /** True when the path DROPS the message rather than handing it on. */
  drops: (at: DeliveryPoint) => boolean;
}

/**
 * Above the age at which every other live case here has already been delivered to, and below the
 * span the floor leaves its subscription idle — so a death by age is invisible to all of them and
 * certain inside that one.
 */
const DEATH_AFTER_MS = QUIET_IDLE_MS * 0.7;

/**
 * Above the deepest topic any other live case subscribes over, and below the backlog the floor
 * seeds — so a death conditioned on how BUSY a topic is reaches the floor and nothing else.
 */
const DEATH_TOPIC_ROWS = QUIET_BACKLOG_ROWS - 1;

/**
 * How late the latency control delivers. Between the bound the floor holds a message to and the
 * window the suite will WAIT for one, so the control still arrives — and still fails the bound it
 * exists to fail — instead of degenerating into another path that drops.
 */
export const LATE_DELIVERY_MS = (QUIET_DELIVERY_MS + DELIVERY_MS) / 2;

/**
 * The narrowest batch the reordering control shuffles, and how long it waits for one to stop
 * growing. Four rather than the five the tail case sends, so the control is aimed at the CLASS
 * — any burst a delivery window can hold — rather than at that case's current width; a suite that
 * stopped leaving a batch this wide in flight would leave this control passing, which the negative
 * control reports as a variant that failed nothing. The settle is short enough that every OTHER
 * case — which sends a message at a time — sees a batch of one and no delay worth measuring.
 */
export const REORDER_ABOVE = 4;
const BATCH_SETTLE_MS = 30;

/**
 * How many subscriptions the capped control registers before it starts ignoring them. An
 * INDEPENDENT figure, not `LIVE_SUBSCRIPTIONS - 1`: derived from the suite's own constant it fires
 * for every value that constant could take, so the negative control's "the suite opens more than
 * this control drops" was true by construction and said nothing about how deep the suite goes.
 */
export const SUBSCRIPTION_CAP = 2;

/**
 * The payloads and handles every live case used to write from a literal, before they were drawn.
 * A plugin serving only these answered all 34 cases; it now serves nothing the floor sends. Keep
 * these EXACT, so that the two rows built on them go green — and so fail the negative control —
 * the moment a live case goes back to writing from a constant.
 */
const RETIRED_PAYLOADS = /^(?:q\d+|bk\d+|h\d+|n\d+|live-[ab]|w\d+-\d+|plugin-\d+|before-teardown|after-teardown)$/;
const RETIRED_WRITERS = /^(?:writer|second-writer|w\d+|plugin)$/;

export const LIVE_DEATHS: LiveDeath[] = [
  {
    // The boundary the rest of the suite names. `QUIET_POSTS` is the deepest single-topic delivery
    // any other case requires, so it is the figure a plugin could read off the suite and cap itself
    // at — and until the floor drew its own depth from a range starting above it, a cap here passed.
    when: `after the ${QUIET_POSTS}th message on a subscription`,
    axis: 'count',
    drops: (at) => at.offered > QUIET_POSTS,
  },
  {
    // The far edge of the same axis: the deepest cap every run is still guaranteed to exceed.
    when: `after the ${QUIET_POSTS_MIN - 1}th message on a subscription`,
    axis: 'count',
    drops: (at) => at.offered > QUIET_POSTS_MIN - 1,
  },
  {
    when: `once the subscription is ${DEATH_AFTER_MS}ms old`,
    axis: 'age',
    drops: (at) => at.subscriptionAgeMs > DEATH_AFTER_MS,
  },
  {
    when: `once the topic holds more than ${DEATH_TOPIC_ROWS} rows`,
    axis: 'depth',
    drops: (at) => at.topicRows > DEATH_TOPIC_ROWS,
  },
  {
    // Gated on the same depth as the row above, so it reaches the floor and nothing else: what it
    // stands for is a plugin that recognises the TEXT a suite is known to write, which is the live
    // path's version of the budget-value switch the blocking clause already forbids.
    when: 'for any payload the suite did not write from a literal',
    axis: 'vocabulary',
    drops: (at) => at.topicRows > DEATH_TOPIC_ROWS && !RETIRED_PAYLOADS.test(at.content),
  },
  {
    when: 'for any writer the suite did not name in a constant',
    axis: 'vocabulary',
    drops: (at) => at.topicRows > DEATH_TOPIC_ROWS && !RETIRED_WRITERS.test(at.senderHandle),
  },
  /**
   * The three below stand for a live path sized for the payloads a TEST writes: a websocket frame
   * cap, a fixed read buffer, a transcoder that survives ASCII and drops the rest, a line-oriented
   * reader that stops at the first newline. Each was measured CERTIFIED — 0 of 34 cases red — while
   * every live case wrote an eight-character lowercase token, and each is caught only because the
   * floor now carries the same content table the write path is graded on.
   *
   * Gated on the floor's own depth exactly as the vocabulary rows are, so they reach that case and
   * nothing else — the write path posts these payloads on fresh topics with no subscriber.
   */
  {
    when: `for any payload longer than ${SHORT_PAYLOAD} characters`,
    axis: 'content',
    drops: (at) => at.topicRows > DEATH_TOPIC_ROWS && at.content.length > SHORT_PAYLOAD,
  },
  {
    when: 'for any payload that is not plain ASCII',
    axis: 'content',
    drops: (at) => at.topicRows > DEATH_TOPIC_ROWS && !isPlainAscii(at.content),
  },
  {
    when: 'for any payload carrying a newline or a tab',
    axis: 'content',
    drops: (at) => at.topicRows > DEATH_TOPIC_ROWS && carriesControlCharacter(at.content),
  },
];

/** A live path that delivers honestly until its predicate fires, and drops everything after that. */
const liveDeath = (death: LiveDeath): BrokenVariant => ({
  name: `a live path that stops delivering ${death.when}`,
  mutates: 'subscribe',
  mustFail: 'does not fall behind a quiet topic',
  make: () =>
    wrap((inner, store) => ({
      subscribe: (topic, handler) => {
        const born = Date.now();
        let offered = 0;
        return inner.subscribe(topic, (m) => {
          offered += 1;
          const at: DeliveryPoint = {
            offered,
            subscriptionAgeMs: Date.now() - born,
            topicRows: (store.log.get(String(topic)) ?? []).length,
            content: m.content,
            senderHandle: String(m.senderHandle),
          };
          if (!death.drops(at)) safeDeliver(handler, () => m);
        });
      },
    })),
});

/**
 * A page a resumed read hands back, and what it drops out of it. Written against the page rather
 * than against a case, so a row is a shape a real backend can take — a server-side window applied
 * to a cursor read, an off-by-one slice, a cursor minted from the topic's tail — and not a
 * transcription of the assertion it must fail.
 */
interface ResumedReadLoss {
  what: string;
  mutates: string;
  /**
   * How far behind the caller must be before this shape loses anything, in rows. Default: one page
   * — near the tail every row here is the identity, so the clauses that read a page or two off a
   * small topic answer honestly.
   *
   * Declared per row so the DEPTH the tool clause reaches is itself controlled. While the clause's
   * backlog was a literal 12, a shape gated at 12, 13, 20, 50 or 200 rows behind was certified
   * 36/36 every time and only a gate at 5 was caught: the clause reached eleven messages behind and
   * read as closed. The far-edge row below sits at {@link TOOL_BACKLOG_MIN} - 1, the deepest gate
   * every run is still guaranteed to exceed.
   */
  behind?: number;
  /** The page as the caller receives it, given the rows really after `since` and the page size. */
  serve: (after: Message[], limit: number, since: Cursor) => FetchRecentResult;
}

const RESUMED_READ_LOSSES: ResumedReadLoss[] = [
  {
    // The OLD end, which is the end a reader cannot notice: the page it gets is a valid page, its
    // cursor is a real cursor, and the rows before it are simply never mentioned again.
    what: 'drops the oldest half of every resumed page',
    mutates: 'fetchRecent',
    serve: (after, limit) => {
      const page = after.slice(0, limit);
      return { messages: page.slice(Math.ceil(page.length / 2)), nextCursor: page.at(-1)!.cursor };
    },
  },
  {
    // The NEW end, with the cursor still reporting the whole page — so the rows it dropped are
    // behind the position the caller resumes from, and are skipped on every later call.
    what: 'drops the newest half of every resumed page',
    mutates: 'fetchRecent',
    serve: (after, limit) => {
      const page = after.slice(0, limit);
      return { messages: page.slice(0, Math.floor(page.length / 2)), nextCursor: page.at(-1)!.cursor };
    },
  },
  {
    // A cursor that names where the read STARTED instead of where it ended. The page is complete,
    // so nothing about it is wrong until the caller pages: the second call asks the same question.
    what: 'answers a resumed page with the cursor it was asked from',
    mutates: 'nextCursor-agreement',
    serve: (after, limit, since) => ({ messages: after.slice(0, limit), nextCursor: since }),
  },
  {
    // R1's own shape, at the plugin: a read that treats a cursor as decoration and answers with the
    // backend's newest window. A caller near the tail cannot tell — which is why every other case
    // here is blind to it — and a caller far behind is handed the far side of its own gap.
    what: 'answers a resumed page with the newest window instead of the oldest rows after it',
    mutates: 'fetchRecent',
    serve: (after, limit) => {
      const window = after.slice(-limit);
      return { messages: window, nextCursor: window.at(-1)!.cursor };
    },
  },
  {
    // The far edge of the DEPTH axis, and the ONLY row here that no plugin-level paging clause
    // reaches: every other case reads a topic a page or two deep, so a shape that serves honestly
    // until the reader is this far behind answers all of them, and only the tool clause — which
    // strands its session behind a whole drawn backlog — asks a question deep enough to see it.
    what: `drops the oldest half of a resumed page once the reader is more than ${TOOL_BACKLOG_MIN - 1} messages behind`,
    mutates: 'fetchRecent',
    behind: TOOL_BACKLOG_MIN - 1,
    serve: (after, limit) => {
      const page = after.slice(0, limit);
      return { messages: page.slice(Math.ceil(page.length / 2)), nextCursor: page.at(-1)!.cursor };
    },
  },
];

const resumedReadLoss = (loss: ResumedReadLoss): BrokenVariant => ({
  name: `a read that ${loss.what}`,
  mutates: loss.mutates,
  mustFail: 'hands a resuming session everything it missed',
  make: () =>
    wrap((inner) => ({
      fetchRecent: async (args) => {
        const page = await inner.fetchRecent(args);
        const since = args.since;
        if (since === undefined || page.messages.length < 2) return page;
        const all = await inner.fetchRecent({ topic: args.topic, since, limit: 10_000 });
        const limit = page.messages.length;
        if (all.messages.length <= (loss.behind ?? limit)) return page;
        return loss.serve(all.messages, limit, since);
      },
    })),
});

export const BROKEN_VARIANTS: BrokenVariant[] = [
  ...POST_ID_RESPELLINGS.map(respelledPostId),
  {
    name: 'inclusive since',
    blastRadius: 16,
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
    blastRadius: 6,
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
    mustFail: 'only the post-subscribe tail',
    make: () =>
      wrap((inner) => ({
        subscribe: async (topic, handler) => {
          const past = await inner.fetchRecent({ topic, limit: 10_000 });
          for (const m of past.messages) safeDeliver(handler, () => m);
          await inner.subscribe(topic, handler);
        },
      })),
  },
  /**
   * The three ways a plugin can fail to contain a fault that is the CALLER's, one control each: a
   * clause keeps its control while an assertion inside it has none, and these three assertions sit
   * in one case precisely because no two of them can be satisfied by the same accident.
   */
  {
    name: 'a live path a throwing handler takes down with it',
    blastRadius: 6,
    mutates: 'handler-fault-does-not-stop-delivery',
    mustFail: 'survives a handler that',
    make: () =>
      wrap((inner) => ({
        subscribe: (topic, handler) => {
          let dead = false;
          return inner.subscribe(topic, (m) => {
            if (dead) return undefined;
            try {
              return handler(m);
            } catch (err) {
              dead = true;
              throw err;
            }
          });
        },
      })),
  },
  {
    name: 'a live path that drops the promise its handler returns',
    blastRadius: REJECTING_SHAPES * FAULT_POSITIONS_PER_SHAPE,
    mutates: 'handler-fault-reaches-no-unhandled-rejection',
    mustFail: 'survives a handler that',
    make: () =>
      wrap((inner) => ({
        subscribe: (topic, handler) =>
          inner.subscribe(topic, (m) => {
            // Nothing is ever attached to what the handler returns, so an `async` one that rejects
            // reaches the process — which is the whole of this defect.
            void handler(m);
          }),
      })),
  },
  {
    name: 'a live path that diagnoses a consumer fault as a backend failure',
    blastRadius: NON_STALLING_SHAPES * FAULT_POSITIONS_PER_SHAPE,
    mutates: 'handler-fault-is-not-a-backend-failure',
    mustFail: 'survives a handler that',
    make: () =>
      wrap((inner) => ({
        subscribe: (topic, handler) =>
          inner.subscribe(topic, (m) => {
            try {
              const out = handler(m);
              void Promise.resolve(out).catch(() => {
                console.error(`[reference] live path for ${String(topic)} failed`);
              });
              return out;
            } catch (err) {
              console.error(`[reference] live path for ${String(topic)} failed`);
              throw err;
            }
          }),
      })),
  },
  ...LIVE_DEATHS.map(liveDeath),
  {
    /**
     * ORDER, on the one shape that can carry it: a batch. This path delivers everything, once, and
     * only from the post-subscribe tail — it just hands a burst over backwards. Every live case but
     * the tail one sends a message at a time or compares as a set, so nothing else here can see it,
     * and a conversation an agent reads in the wrong order is a wrong conversation.
     */
    name: 'a live path that hands a burst back in reverse',
    blastRadius: 2,
    mutates: 'cursor',
    mustFail: 'only the post-subscribe tail',
    make: () =>
      wrap((inner) => ({
        subscribe: (topic, handler) => {
          const batch: Message[] = [];
          let timer: ReturnType<typeof setTimeout> | undefined;
          return inner.subscribe(topic, (m) => {
            batch.push(m);
            clearTimeout(timer);
            timer = setTimeout(() => {
              const held = batch.splice(0);
              for (const each of held.length >= REORDER_ABOVE ? held.reverse() : held) {
                safeDeliver(handler, () => each);
              }
            }, BATCH_SETTLE_MS);
          });
        },
      })),
  },
  {
    /**
     * A connection that registers its first subscriptions and silently ignores the rest — a fixed
     * listener pool, a server-side per-connection cap, a `Map` keyed on something that collides.
     * Two was the deepest the suite went, so this shape answered every case while a session
     * subscribed to a third topic in its allowlist heard nothing at all.
     */
    name: `a live path that registers only its first ${SUBSCRIPTION_CAP} subscriptions`,
    mutates: 'subscribe',
    mustFail: 'on the live path too',
    make: () =>
      wrap((inner) => {
        let registered = 0;
        return {
          subscribe: async (topic, handler) => {
            registered += 1;
            if (registered > SUBSCRIPTION_CAP) return;
            await inner.subscribe(topic, handler);
          },
        };
      }),
  },
  {
    /**
     * The same clause's LATENCY half, and the one no floor phrased as "did it arrive?" can reach:
     * this path delivers everything, in order, exactly once — just late enough that an agent acts on
     * it after the turn it belonged to. Conditioned on a topic deeper than any other case here
     * subscribes over, so the case that bounds the wait is the only one it reaches.
     */
    name: 'a live path that delivers everything, seconds late',
    mutates: 'live-delivery-is-prompt',
    mustFail: 'does not fall behind a quiet topic',
    make: () =>
      wrap((inner, store) => ({
        subscribe: (topic, handler) =>
          inner.subscribe(topic, (m) => {
            if ((store.log.get(String(topic)) ?? []).length <= DEATH_TOPIC_ROWS) {
              safeDeliver(handler, () => m);
              return;
            }
            setTimeout(() => safeDeliver(handler, () => m), LATE_DELIVERY_MS);
          }),
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
    // Four paging widths, plus the tool-surface case: an agent paging through a backlog stalls on
    // the same cursor exactly as the paging clause's own reader does.
    blastRadius: 5,
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
    // Drifts on a re-read of a topic that has never held a message, and nowhere else — which is
    // exactly the assertion the clause turns on.
    name: 'a drifting cursor on a re-read of an empty topic',
    mutates: 'cursor',
    mustFail: 'never-posted topic',
    make: () =>
      wrap((inner) => ({
        fetchRecent: async (args) => {
          const page = await inner.fetchRecent(args);
          if (args.since === undefined || page.messages.length > 0) return page;
          const all = await inner.fetchRecent({ topic: args.topic, limit: 10_000 });
          if (all.messages.length > 0) return page;
          return { ...page, nextCursor: asCursor(`${String(page.nextCursor)}-drift`) };
        },
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
    blastRadius: 8,
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
    // The measured defeat of the content axis, whole: refuse every shape on the way in AND drop
    // every long, non-ASCII or control-carrying message on the way out, while declaring no refusal
    // at all. The write clause used to permit a refusal without a declaration and the live floor
    // used to fall back to a bare token on one, so this plugin — which carries nothing a person
    // could type, on either path — was certified 36 of 36.
    name: 'a write path that refuses every content shape while declaring none',
    mutates: 'content-shape-declaration',
    mustFail: 'either round-trips',
    blastRadius: 7,
    make: () =>
      wrap((inner, store) => ({
        post: (t, i, c, o) => {
          if (CONTENT_SHAPES.some(([, body]) => c.includes(body))) {
            return Promise.reject(new Error('this payload is not supported by this backend'));
          }
          return inner.post(t, i, c, o);
        },
        subscribe: (topic, handler) =>
          inner.subscribe(topic, (m) => {
            const busy = (store.log.get(String(topic)) ?? []).length > DEATH_TOPIC_ROWS;
            const typed =
              m.content.length > SHORT_PAYLOAD ||
              !isPlainAscii(m.content) ||
              carriesControlCharacter(m.content);
            if (!busy || !typed) safeDeliver(handler, () => m);
          }),
      })),
  },
  {
    // The PARTIAL of the same shape, which is worse: it withdraws exactly one row of the content
    // axis and leaves the case reading as covered. Nothing but the floor's reached-vs-declared
    // check can see it — the axis is still exercised, just no longer along the length dimension.
    name: 'a write path that refuses the longest content shape while declaring none',
    mutates: 'content-shape-declaration',
    mustFail: 'either round-trips',
    make: () =>
      wrap((inner) => ({
        post: (t, i, c, o) =>
          c.length > SHORT_PAYLOAD
            ? Promise.reject(new Error('message too long for this backend'))
            : inner.post(t, i, c, o),
      })),
  },
  {
    // The declaration in the other direction: a fixture that names a refusal it does not have buys
    // a shorter live floor for free. `refusesContentShapes` is only a weaker grade while it is TRUE.
    name: 'a fixture that declares a refusal the backend does not have',
    mutates: 'content-shape-declaration',
    mustFail: 'either round-trips',
    blastRadius: 6,
    make: () => wrap(() => ({}), { refusesContentShapes: CONTENT_SHAPES.map(([label]) => label) }),
  },
  {
    // The defect the contract exists to forbid, and the only one a DECLARATION could never catch:
    // swallow the budget and answer with the window the backend already had. A caller cannot tell
    // that from a long-poll that timed out empty, so an agent polls on believing it is parked.
    name: 'a read that answers a block budget with the window it already had',
    blastRadius: 6,
    mutates: 'native-block-actually-waits',
    mustFail: 'blockMs is honoured natively or refused',
    make: () =>
      wrap((inner) => ({
        fetchRecent: (args) => inner.fetchRecent({ ...args, blockMs: undefined }),
      })),
  },
  {
    // A refusal that arrives only after the wait it refuses. The caller budgeted for a long-poll and
    // got one — with no messages and no page — which is strictly worse than either honest arm.
    name: 'a read that parks for most of a budget before refusing it',
    mutates: 'refusal-is-prompt',
    mustFail: 'blockMs is honoured natively or refused',
    make: () =>
      wrap((inner) => ({
        fetchRecent: async (args) => {
          const budget = args.blockMs;
          if (args.since !== undefined && budget !== undefined) {
            // Capped: this is aimed at `refusal-is-prompt`, so anything past that bound fails it,
            // and a park proportional to a budget an agent's size is minutes of nothing.
            const parkFor = Math.min(budget * PARK_FRACTION, REFUSAL_RETURN_MS * 2);
            await new Promise((resolve) => setTimeout(resolve, parkFor));
          }
          return inner.fetchRecent(args);
        },
      })),
  },
  {
    // The same trade wearing one honest refusal: refuse the budget asked first, answer the next one
    // with a page. A refusal a backend does not hold to tells the caller nothing at all.
    name: 'a read that refuses one block budget and answers the next with a page',
    blastRadius: 6,
    mutates: 'refusal-is-not-an-empty-page',
    mustFail: 'blockMs is honoured natively or refused',
    make: () =>
      wrap((inner) => ({
        fetchRecent: (args) =>
          args.since === undefined
            ? inner.fetchRecent(args)
            : inner.fetchRecent({ ...args, blockMs: undefined }),
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
    mutates: 'sinceless-block-returns-promptly',
    mustFail: 'blockMs is honoured natively or refused',
    make: () =>
      wrap((inner) => ({
        fetchRecent: async (args) => {
          // Ahead of the delegate, so that the park is what the bound measures whichever arm the
          // inner plugin takes — a refusal held back for most of the budget is the same defect.
          if (args.since === undefined && args.blockMs !== undefined) {
            // Capped just past the bound it is aimed at, so it still fails that bound and still
            // outlasts what the suite will wait for on a caller-scale budget — without parking for
            // the minutes such a budget would otherwise buy.
            const parkFor = Math.min(args.blockMs * PARK_FRACTION, SINCELESS_RETURN_MS + 1_000);
            await new Promise((resolve) => setTimeout(resolve, parkFor));
          }
          return inner.fetchRecent(args);
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
    blastRadius: 15,
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
              for (const s of registered) if (s.topic !== String(t)) safeDeliver(s.handler, () => landed);
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
    // Each writer numbering from its own sequence — the cursor namespace a backend gets when the
    // ordering key is per-connection rather than per-topic. Cursors then collide across writers.
    name: 'a cursor namespace that restarts per writer',
    blastRadius: 8,
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
    /**
     * Re-delivery that only shows up under CONTENTION. A page stitched from two server-side batches
     * repeats the boundary row, which a topic small enough for one batch never reveals — so every
     * other clause reads clean and only the interleaved reader, paging a topic while it grows past
     * a batch, sees a row twice. The row it never saw at all — the assertion beside this one — is
     * untouched, so this control reaches that assertion and nothing else in its case.
     */
    name: 'a since page that repeats its first row once the topic outgrows one batch',
    mutates: 'interleaved-reader-sees-each-row-once-in-order',
    mustFail: 'interleaved with concurrent writers',
    make: () =>
      wrap((inner) => ({
        fetchRecent: async (args) => {
          const page = await inner.fetchRecent(args);
          if (args.since === undefined || page.messages.length === 0) return page;
          const whole = await inner.fetchRecent({ ...args, since: undefined, limit: 10_000 });
          if (whole.messages.length <= SERVER_BATCH) return page;
          return { ...page, messages: [page.messages[0]!, ...page.messages] };
        },
      })),
  },
  {
    /**
     * A cursor RENDERED non-uniquely while still resolving correctly — a coarse rendering (a
     * second-resolution timestamp, a truncated offset) that two concurrent writes land inside.
     * Every `since` in the suite still names the right position, so the ordering assertion beside
     * it passes and only the distinctness assertion can see this.
     */
    name: 'two concurrent rows rendered under one cursor',
    mutates: 'cursor',
    mustFail: 'multi-process writes',
    make: () =>
      wrap((inner) => ({
        fetchRecent: async (args) => {
          const page = await inner.fetchRecent(args);
          if (page.messages.length <= SERVER_BATCH) return page;
          // `nextCursor` keeps the REAL last cursor, so paging still terminates and the collision is
          // visible only where the suite reads the rows' own cursors.
          return {
            messages: page.messages.map((m, i) =>
              i === page.messages.length - 1 ? { ...m, cursor: page.messages[i - 1]!.cursor } : m,
            ),
            nextCursor: page.nextCursor,
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
              for (const s of registered) if (s.topic === String(t)) safeDeliver(s.handler, () => landed);
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
    blastRadius: 8,
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
    blastRadius: 5,
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
    // The idle arm's FLOOR, which nothing could fail: of the three native-blocking variants, two
    // fail arm (a) before reaching it and the third fails on the cursor, so a plugin that declares
    // native `blockMs` support and answers "still nothing" the instant it is asked was certified —
    // and the assertion could be deleted with this package, negative control included, staying
    // green. This plugin is conformant on every other axis; it just gives its budget up early,
    // which is what core turns into a hot poll loop against the backend.
    name: 'a native blocking read that gives up long before the budget',
    blastRadius: 6,
    mutates: 'native-block-actually-waits',
    mustFail: 'blockMs is honoured natively or refused',
    make: () =>
      wrap(
        (inner) => ({
          fetchRecent: (args) =>
            inner.fetchRecent(
              args.blockMs === undefined
                ? args
                : { ...args, blockMs: Math.ceil(args.blockMs * EARLY_RETURN_FRACTION) },
            ),
        }),
        { nativeBlocking: true },
      ),
  },
  {
    // The blocking arm's TIMING assertion — "it woke on the message, not on the budget expiring" —
    // which every fixture in this package used to be on the wrong side of the flag to reach. This
    // plugin returns the right messages under the right cursor; all it does is ignore the wake.
    name: 'a native blocking read that returns at the budget instead of on the message',
    blastRadius: 5,
    mutates: 'native-block-wakes-on-the-message',
    mustFail: 'blockMs is honoured natively or refused',
    make: () =>
      wrap(
        (inner) => ({
          fetchRecent: async (args) => {
            const page = await inner.fetchRecent({ ...args, blockMs: undefined });
            if (args.since === undefined || args.blockMs === undefined) return page;
            if (page.messages.length > 0) return page;
            const parkFor = Math.min(args.blockMs, 4_200);
            await new Promise((resolve) => setTimeout(resolve, parkFor));
            return inner.fetchRecent({ ...args, blockMs: undefined });
          },
        }),
        { nativeBlocking: true },
      ),
  },
  {
    // The blocking arm's empty-timeout cursor. A drained long-poll that reports a MOVED cursor makes
    // the caller's next `since` skip a window it never read, and only the native arm passes a
    // `blockMs` that is allowed to expire empty.
    name: 'a native blocking read whose cursor moves on an empty timeout',
    mutates: 'nextCursor-stability',
    mustFail: 'blockMs is honoured natively or refused',
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
        { nativeBlocking: true },
      ),
  },
  {
    /**
     * A native blocker that WAITS — just far past the budget it was given. Every "did it wait at
     * all?" floor passes for it, so without a ceiling the only thing that ends the case is the
     * harness timeout, whose message names no clause. Conditioned on a SMALL budget so it reaches
     * the idle read and nothing else: the clause's other budgets are seconds long and a multiple of
     * one of those would be killed rather than reported.
     */
    name: 'a native blocking read that parks well past the budget it was given',
    mutates: 'native-block-does-not-overshoot-the-budget',
    mustFail: 'blockMs is honoured natively or refused',
    make: () =>
      wrap(
        (inner) => ({
          fetchRecent: async (args) => {
            const budget = args.blockMs;
            const page = await inner.fetchRecent(args);
            if (budget === undefined || budget > IDLE_BLOCK_MS || page.messages.length > 0) {
              return page;
            }
            await new Promise((resolve) => setTimeout(resolve, budget * (OVERSHOOT_MULTIPLE - 1)));
            return page;
          },
        }),
        { nativeBlocking: true },
      ),
  },
  {
    /**
     * The SAME lost wakeup, on the arm that never parks — and the only control that can reach it.
     * This plugin refuses `blockMs` exactly as the eight shipped backends do, so the race case takes
     * its refusing branch; what it gets wrong is minting `nextCursor` AFTER the read instead of from
     * the rows the read returned, which is what a backend timestamping its position at "now" does.
     * A write landing in that window is covered by a cursor that never carried it, and resuming from
     * that cursor skips it for good.
     *
     * Gated on the PLAIN read: the refusing branch passes no budget at all, so a variant keyed on
     * `blockMs` being present (as this one's parking sibling is) never runs on that branch and
     * leaves its assertion with no control whatever.
     */
    name: 'a refusing read that mints its cursor after the read instead of from its own rows',
    blastRadius: 5,
    mutates: 'refusing-read-covers-only-what-it-returned',
    mustFail: 'blocking fetch is not missed',
    make: () =>
      wrap((inner) => ({
        fetchRecent: async (args) => {
          const page = await inner.fetchRecent(args);
          if (args.since === undefined || page.messages.length > 0) return page;
          await new Promise((resolve) => setTimeout(resolve, 10));
          const all = await inner.fetchRecent({ topic: args.topic, limit: 10_000 });
          return { messages: [], nextCursor: all.nextCursor };
        },
      })),
  },
  {
    // The lost-wakeup race: park "from now" instead of at the caller's cursor, so a message landing
    // between the read and the waiter is reported as already-consumed and can never be fetched.
    name: 'a native blocking read that parks from now instead of at the caller cursor',
    blastRadius: 6,
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
        { nativeBlocking: true },
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
                if (last !== undefined) setTimeout(() => safeDeliver(s.handler, () => last), 10);
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
  {
    /**
     * A backend that parks on the budgets an AGENT sends. Every other budget in the suite is small
     * enough to sit through, so a plugin can park on a caller-scale one for as long as it likes and
     * be indistinguishable from one that has stopped answering — while every bound measured on a
     * small budget passes. Conditioned on a budget larger than any the suite hands out from a
     * constant, so it reaches the caller-scale reads and nothing else.
     */
    name: 'a read that parks on a budget the size an agent sends',
    blastRadius: 2,
    mutates: 'caller-scale-block-is-answered',
    mustFail: 'a long run of unpredictable budgets',
    make: () =>
      wrap(
        (inner) => ({
          fetchRecent: async (args) => {
            if ((args.blockMs ?? 0) > SINCELESS_BLOCK_MS) {
              await new Promise((resolve) => setTimeout(resolve, CALLER_BLOCK_RETURN_MS + 500));
            }
            return inner.fetchRecent(args);
          },
        }),
        { nativeBlocking: true },
      ),
  },
  /**
   * The four ways a resumed read can strand a backlog, on the ONE case that reads through core's
   * `parley_fetch_recent` rather than through the plugin. Each is a page a caller has no way to
   * tell from a short one it will be handed the rest of next time — the loss is only visible once
   * the whole catch-up procedure has run and the topic still has messages the agent never saw.
   *
   * Every row here is conditioned on a read that carries a `since`, so a since-less window read —
   * which every other clause in the suite leans on — answers honestly and the control stays aimed
   * at the case it names.
   */
  ...RESUMED_READ_LOSSES.map(resumedReadLoss),
  ...ARM_SWITCHES.map((sw) =>
    armSwitch(sw, false, sw.when.startsWith('on every connection') ? 5 : 1),
  ),
  // The same class on the SERVING arm, which the arm half is by construction blind to. This is the
  // shape the shipped Redis plugin took the day one line stopped releasing its reader budget: it
  // never left the serving arm, it just stopped waiting, and 980 tests stayed green.
  armSwitch(ARM_SWITCHES[0] as ArmSwitch, true, 1),
];
