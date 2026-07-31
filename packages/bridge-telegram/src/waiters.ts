/** One parked call: `wake` idempotently unparks it, and only a `seq` above `sinceSeq` may. */
type Waiter = { sinceSeq: number; wake: () => void };

/**
 * The native long-poll parking lot, keyed by CHAT ID: `fetchRecent` calls parked on a chat, woken
 * by the SHARED ingest path when a message above their `since` lands, by their own timeout, or by
 * teardown. No parked read ever opens a second `getUpdates` consumer — the one shared loop and own
 * posts both flow through ingest, which calls {@link wake}.
 *
 * A waiter always self-cleans (timer cleared, dropped from its set, an emptied set dropped from the
 * map), so a timed-out or resolved long-poll never leaks.
 */
export class Waiters {
  private readonly byChat = new Map<string, Set<Waiter>>();

  /** Park until a message in `chatId` above `sinceSeq` is ingested, `blockMs` elapses, or teardown. */
  park(chatId: string, sinceSeq: number, blockMs: number): Promise<void> {
    let set = this.byChat.get(chatId);
    if (set === undefined) {
      set = new Set<Waiter>();
      this.byChat.set(chatId, set);
    }
    const waiters = set;
    return new Promise<void>((resolve) => {
      let done = false;
      const wake = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        waiters.delete(waiter);
        if (waiters.size === 0) this.byChat.delete(chatId);
        resolve();
      };
      const timer = setTimeout(wake, blockMs);
      const waiter: Waiter = { sinceSeq, wake };
      waiters.add(waiter);
    });
  }

  /** Wake every waiter on the chat whose `since` now trails `seq`. */
  wake(chatId: string, seq: number): void {
    const set = this.byChat.get(chatId);
    if (set === undefined) return;
    // Snapshot: wake() removes the waiter from the set (and may drop the key).
    for (const w of [...set]) if (seq > w.sinceSeq) w.wake();
  }

  /**
   * Unpark everything, so no blocked `fetchRecent` hangs past teardown. Each resumes, re-queries
   * the (now closed) store and returns an empty page — returning early/empty is always safe.
   */
  wakeAll(): void {
    for (const set of [...this.byChat.values()]) for (const w of [...set]) w.wake();
    this.byChat.clear();
  }
}
