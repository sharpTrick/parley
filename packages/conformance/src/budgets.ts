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
 * Ceiling on a probe's budget. Probes exist to make the NUMBER of blocking reads unpredictable, so
 * on the parking arm each one is really waited out — keep them small enough that an unknown number
 * of them costs nothing measurable.
 */
export const PROBE_MAX_BLOCK_MS = 40;

/**
 * Most extra blocking reads a case makes beyond the ones its other assertions need. The arm is
 * INFERRED from behaviour, so a fixed count of them is a fingerprint: a plugin that refuses exactly
 * the reads the suite is known to make, and silently drops every budget after them, passes a suite
 * that asks a predictable number of times. Drawn at random between 1 and this, so what is graded is
 * that the arm never CHANGES — a property no schedule can be fitted to.
 */
export const MAX_EXTRA_PROBES = 3;
