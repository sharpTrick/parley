/**
 * Budget offered to the since-less blocking read. Keep it well under the harness's own per-case
 * timeout, so that a plugin which parks for the whole thing FAILS the bound below instead of being
 * killed by vitest — a generic timeout names neither the plugin's behaviour nor this clause.
 */
export const SINCELESS_BLOCK_MS = 12_000;

/**
 * How long that read may take. A bound compared against the BUDGET grades nothing: a plugin parking
 * for 95% of it still returns "under the budget", which is the hot path for every
 * `parley_fetch_recent` an agent makes before it holds a cursor. Keep this a fraction, so that the
 * assertion reads as "the plugin did not spend the budget".
 *
 * Keep the fraction between the slowest real backend and the parking control, so that widening it
 * for one does not certify the other: Matrix measures 4.1-4.8 s here against a live Synapse — a
 * room-provisioning positioning sync, not a park — and `BROKEN_VARIANTS`' parking plugin holds
 * {@link PARK_FRACTION} of the budget. A bound outside that window either reds a conformant backend
 * or greens the defect this clause exists to catch.
 */
export const SINCELESS_RETURN_MS = SINCELESS_BLOCK_MS * (2 / 3);

/**
 * The share of its budget the parking control spends. Keep it above
 * `SINCELESS_RETURN_MS / SINCELESS_BLOCK_MS`, so that the control still fails the bound it exists
 * to fail.
 */
export const PARK_FRACTION = 0.9;

/** Budget offered to the idle blocking read on the native arm — the one allowed to expire empty. */
export const IDLE_BLOCK_MS = 300;

/**
 * How much of that budget a plugin declaring NATIVE `blockMs` support must actually spend before it
 * reports "still nothing". A blocking read that answers at once is a long-poll core turns into a hot
 * loop against the backend, and it is the one native-blocking defect every other assertion in the
 * clause is blind to. Generous slack for slow CI: the control that fails this bound gives up at
 * {@link EARLY_RETURN_FRACTION} of the budget, an order of magnitude sooner rather than a hair.
 */
export const IDLE_BLOCK_FLOOR_MS = 150;

/**
 * The share of an idle budget the early-return control spends. Keep it well under
 * `IDLE_BLOCK_FLOOR_MS / IDLE_BLOCK_MS`, so that the control still fails the bound it exists to
 * fail — and above zero, so that it still wakes on a message like a conformant plugin.
 */
export const EARLY_RETURN_FRACTION = 0.1;

/** Budget offered to the blocking read at the tail — the one a refusing backend must fail fast on. */
export const TAIL_BLOCK_MS = 5_000;

/**
 * How long a REFUSAL may take. A refusal is raised before the read reaches the wire, so this is
 * ABSOLUTE and must never be derived from the budget being refused: a bound that scales with
 * `blockMs` certifies as fail-fast a plugin that parks for most of the wait and only then says it
 * cannot serve one.
 */
export const REFUSAL_RETURN_MS = 1_000;

/**
 * Ceiling on the idle blocking read. The floor above asks whether the plugin waited AT ALL; without
 * a ceiling a native blocker that spends a large multiple of the budget it was handed satisfies
 * every row, and the only thing that stops it is the harness timeout — which names no clause. Core
 * holds the caller's request open for whatever the plugin spends, so overshoot is a hang with a
 * politer name.
 */
export const IDLE_BLOCK_CEILING_MS = IDLE_BLOCK_MS * 4;

/**
 * The multiple of its budget the overshoot control spends. Keep it above
 * `IDLE_BLOCK_CEILING_MS / IDLE_BLOCK_MS`, so that the control still fails the ceiling it exists to
 * fail.
 */
export const OVERSHOOT_MULTIPLE = 10;

/**
 * Budget the lost-wakeup race offers. Far above the 0-3 ms write it races, and far enough below the
 * harness timeout that a plugin parking a MULTIPLE of it still fails a named bound instead of being
 * killed by vitest with a diagnostic that names nothing — which is what a 5 s budget over four rows
 * left no headroom for.
 */
export const RACE_BLOCK_MS = 2_000;

/**
 * How long that read may take. The write lands within 3 ms, so anything near the budget is the
 * plugin waking on its timeout rather than on the write — the defect the case is named for, and the
 * one that also makes the row expensive enough to be killed rather than reported.
 */
export const RACE_RETURN_MS = 1_000;

/**
 * Ceiling on the budget the lost-wakeup case's opening read carries — the read that decides which
 * arm the backend is on before the race is set up. Drawn rather than fixed, and small enough that
 * waiting one out on the parking arm costs nothing measurable.
 */
export const PROBE_MAX_BLOCK_MS = 40;

/**
 * The share of its budget a SERVED blocking read that came back EMPTY must actually have spent.
 * Applied to EVERY such read, not only the one the idle clause measures by hand: a plugin that
 * honours the first few budgets and then answers instantly forever is on the serving arm the whole
 * time, so nothing that grades only the ARM can see it, and one hand-measured read cannot either.
 *
 * Derived from the idle clause's own floor over its own budget, so the two cannot drift apart and
 * the {@link EARLY_RETURN_FRACTION} control still lands on the failing side of both.
 */
export const SERVED_BLOCK_FLOOR_FRACTION = IDLE_BLOCK_FLOOR_MS / IDLE_BLOCK_MS;

/**
 * The window the arm-stability run must cover on ONE connection. A recorder scoped to a single case
 * asserts stability over a handful of reads inside a few hundred milliseconds, which a backend that
 * refuses for the first seconds of a connection and silently drops every budget afterwards passes
 * without ever being asked a question it would answer differently.
 */
export const STABILITY_SPAN_MS = 3_000;

/** Fewest / most DRAWN blocking reads that run makes; it also makes {@link STABILITY_CALLER_READS}. */
export const STABILITY_READS_MIN = 26;
export const STABILITY_READS_MAX = 30;

/** How many of the drawn budgets are LONG, and the range they come from. */
export const STABILITY_LONG_READS = 3;
export const STABILITY_LONG_BLOCK_MIN_MS = 1_050;
export const STABILITY_LONG_BLOCK_MAX_MS = 1_250;

/** The range the remaining drawn budgets come from. */
export const STABILITY_SHORT_BLOCK_MIN_MS = 10;
export const STABILITY_SHORT_BLOCK_MAX_MS = 60;

/**
 * How many reads carry a budget the SIZE A REAL CALLER SENDS — up to `catchup.block_max_ms`, which
 * the skill this repo ships tells an agent to fill with 55 000. Every other budget here is two
 * orders of magnitude smaller, and that is itself a fingerprint: a plugin that honours the small
 * figures a suite hands out and drops the large ones an agent sends passes a run drawn only from the
 * small ones, which is the defect `blocking-arm-is-stable` exists to forbid.
 */
export const STABILITY_CALLER_READS = 2;

/**
 * The share of core's own ceiling below which a caller-scale budget is never drawn. Keep the FLOOR
 * above every figure the suite hands out from a constant, so that the control aimed at a plugin
 * which honours small budgets and drops large ones is really reached.
 */
export const CALLER_BLOCK_FLOOR_FRACTION = 1 / 8;

/**
 * How long a read carrying a caller-scale budget may take. Those budgets are deliberately LARGER
 * than the harness's own per-case ceiling — that is what makes them the size an agent sends — so
 * each is raced against this and fails by NAME rather than being killed by vitest with a diagnostic
 * that names no clause. Both shapes answer long before it: one is a since-less read of a topic that
 * already has messages, which both arms answer at once, and the other wakes on a write scheduled
 * inside it.
 */
export const CALLER_BLOCK_RETURN_MS = 6_000;

/**
 * How many distinct topics the run spreads its reads over, and how deep the first of them is. A
 * backend that serves budgets on the topic it was first asked about, or only while a topic is small
 * enough to answer from a first page, drops every budget a real deployment sends it — and answers
 * every other case, each of which works on ONE fresh topic holding one message, exactly as a
 * conformant one does.
 */
export const STABILITY_TOPICS = 3;
export const STABILITY_DEEP_TOPIC_ROWS = 14;
