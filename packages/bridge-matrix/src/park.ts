import type { Cursor, FetchRecentResult, Topic } from '@sharptrick/parley-core';
import { MatrixTimeline } from './timeline.js';

/**
 * A pending native long-poll parked on a room. `topic` is the logical topic it is caught up to (its
 * exclusive `since` floor); `wake` fires EXACTLY once — on a belonging live event, at the `blockMs`
 * timeout, or on `disconnect()` — and tears down its own timer, registration and dedicated `/sync`.
 */
export interface Waiter {
  topic: Topic;
  wake: () => void;
}

export const liveKey = (roomId: string, topic: Topic): string => `${roomId}\u0000${String(topic)}`;

/** The long-polls parked on a room, what may wake one, and the teardown that drains them all. */
export abstract class MatrixParking extends MatrixTimeline {
  /**
   * room_id → the {@link Waiter}s parked on it, populated only while a `fetchRecent({ blockMs })`
   * blocks. Independent of `subscribe` — a blocking fetch needs no active route.
   */
  protected readonly waiters = new Map<string, Set<Waiter>>();
  /**
   * (room_id, topic) pairs with a live `subscribe` `/sync` loop running AND already positioned. A
   * blocking `fetchRecent` hooks that loop's delivery (no second `/sync`) only when its OWN pair is
   * here. Keep both halves — the loop wakes waiters for the one topic it delivers, so a room-only
   * key would let `subscribe(A)` starve a waiter on topic B in `shared_room` mode, and registering
   * before the positioning sync resolves would let a message landing in that window reach neither.
   */
  protected readonly liveTopics = new Set<string>();

  /**
   * End the current generation's background work, drop the credential that authorized it, and empty
   * every registry describing it. Keep BOTH lifecycle entry points on this, so that a bare
   * `connect()` — a reconnect with no preceding `disconnect()` — ends the previous generation's
   * parks at once rather than one park slice later, which at the documented `sync_timeout_ms` is 25
   * seconds of a caller's `blockMs` spent on a generation that is already gone.
   */
  protected standDown(): void {
    for (const c of this.controllers) c.abort();
    this.controllers.clear();
    this.liveTopics.clear();
    this.rooms.clear();
    this.token = undefined;
    this.userId = undefined;
    // Wake every blocked long-poll so its `fetchRecent` returns at once (each wake() clears its timer
    // and registration). Snapshot first — wake() mutates `waiters` — then clear so nothing outlives
    // the teardown; the in-flight `/sync` each drives (if any) was already aborted above.
    const pending = [...this.waiters.values()].flatMap((set) => [...set]);
    this.waiters.clear();
    for (const w of pending) w.wake();
  }

  /**
   * Park until a belonging live event lands in `roomId`, `blockMs` elapses, or `disconnect()` drains
   * us — then re-run the exclusive `/messages` query so the ids and cursor stay canonical.
   *
   * Every empty exit reports `best` — the most advanced cursor the canonical query has produced,
   * seeded from the pre-block one. Keep it threaded rather than reporting `sinceCursor`, so that a
   * blocking call reports the position a non-blocking one would: a cursor pinned at `since` cannot
   * cross a page-sized block of foreign-topic traffic, and everything beyond the forward-page bound
   * is then unreachable for as long as the caller keeps passing `blockMs`.
   */
  protected async blockingFetch(
    roomId: string,
    topic: Topic,
    sinceCursor: Cursor,
    limit: number,
    blockMs: number,
    bestCursor: Cursor,
    generation: number,
  ): Promise<FetchRecentResult> {
    const deadline = Date.now() + blockMs;
    let best = bestCursor;
    // Wait in a loop so a SPURIOUS wake does not end the call early. The dedicated `/sync` can
    // re-deliver an event at/before `sinceCursor`, waking the waiter even though the exclusive
    // re-query is still empty. On such an empty re-query with budget left we re-arm and keep
    // waiting, so the plugin holds the full `blockMs` like the other native backends.
    for (;;) {
      const remaining = deadline - Date.now();
      if (this.isStale(generation) || remaining <= 0) {
        return { messages: [], nextCursor: best };
      }

      let done = false;
      let timer: ReturnType<typeof setTimeout>;
      let syncController: AbortController | undefined;
      let resolveParked!: () => void;
      const parked = new Promise<void>((resolve) => {
        resolveParked = resolve;
      });
      const waiter: Waiter = {
        topic,
        wake: () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          const set = this.waiters.get(roomId);
          if (set !== undefined) {
            set.delete(waiter);
            if (set.size === 0) this.waiters.delete(roomId);
          }
          if (syncController !== undefined) {
            this.controllers.delete(syncController);
            syncController.abort();
          }
          resolveParked();
        },
      };
      // Keep the park sliced rather than spanning the whole budget, so that a wake source that stops
      // observing — a subscribe loop in retry backoff, a loop stalled mid-backfill, a dedicated
      // `/sync` that failed to position — costs one slice of latency and not the entire blockMs.
      const slice = this.parkSlice(remaining);
      // Keep the registration ahead of everything below, so that a delivery cannot land while this
      // waiter is invisible.
      timer = setTimeout(waiter.wake, slice);
      const set = this.waiters.get(roomId) ?? new Set<Waiter>();
      set.add(waiter);
      this.waiters.set(roomId, set);

      // Keep every exit from here on inside the finally, so that a throw from `fetchSince` cannot
      // strand this waiter's timer, registration and dedicated `/sync` for the rest of `blockMs`.
      try {
        if (this.isStale(generation)) return { messages: [], nextCursor: best };

        if (!this.liveTopics.has(liveKey(roomId, topic))) {
          syncController = new AbortController();
          this.controllers.add(syncController);
          // Keep this await ahead of the re-query below, so that a message landing in the
          // positioning window is seen by the re-query when the sync's `next_batch` already skipped
          // it. `parked` bounds the wait by the deadline.
          await Promise.race([
            this.driveBoundedSync(roomId, topic, slice, syncController, waiter.wake),
            parked,
          ]);
        }

        for (const afterPark of [false, true]) {
          if (afterPark) await parked;
          if (this.isStale(generation)) return { messages: [], nextCursor: best };
          const page = await this.fetchSince(roomId, topic, sinceCursor, limit, generation);
          if (page.messages.length > 0) return page;
          best = page.nextCursor;
        }
        // Empty ⇒ the deadline timer fired or the wake was spurious. Loop: the top re-checks the
        // deadline and returns the empty page once the budget is spent, else re-arms.
      } finally {
        waiter.wake();
      }
    }
  }
}
