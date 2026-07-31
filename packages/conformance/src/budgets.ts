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
