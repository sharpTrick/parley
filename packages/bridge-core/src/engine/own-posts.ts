import type { BackendMsgId } from '../message.js';

/** How many of this bridge's own message ids are remembered; the oldest is forgotten first. */
export const OWN_POSTS_MAX = 1024;

/**
 * How long a reader of this ledger waits for in-flight writes to return their ids. Keep it bounded,
 * so that one write that never answers cannot stop live delivery or every later post — the price is
 * that an echo racing a write slower than this is taken for someone else's message.
 */
const WRITE_WAIT_MS = 2_000;

/**
 * The messages this bridge wrote, so that the live path never hands an agent its own words back
 * and a post's read guard never asks it to read them first.
 *
 * Keep recognition on the id a write returned, so that a backend stamping the sender from an
 * account of its own (seam.ts, `post`) — Zulip answers with the bot's email — still has its echo
 * recognised.
 *
 * A backend can deliver a message on the live path before the write that created it has returned
 * its id. Keep {@link OwnPosts.settled} awaited before {@link OwnPosts.has} is trusted, so that an
 * echo racing its own write is still recognised.
 */
export class OwnPosts {
  private readonly ids = new Set<BackendMsgId>();
  private readonly inFlight = new Set<{ started: number; done: Promise<void> }>();

  async track(write: () => Promise<BackendMsgId>): Promise<BackendMsgId> {
    const pending = write();
    const entry = { started: Date.now(), done: pending.then(() => undefined, () => undefined) };
    this.inFlight.add(entry);
    try {
      const id = await pending;
      this.remember(id);
      return id;
    } finally {
      this.inFlight.delete(entry);
    }
  }

  has(id: BackendMsgId): boolean {
    return this.ids.has(id);
  }

  /**
   * Resolves once every write in flight has either returned its id or grown too old to wait on.
   * Keep the age limit per write, so that a write that never returns costs one bounded wait — not
   * one per message behind it, and not one more for every younger write that returns in time.
   */
  async settled(): Promise<void> {
    const now = Date.now();
    await Promise.all([...this.inFlight].map((w) => this.doneOrAged(w, WRITE_WAIT_MS - (now - w.started))));
  }

  private async doneOrAged(write: { done: Promise<void> }, remainingMs: number): Promise<void> {
    if (remainingMs <= 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const aged = new Promise<void>((resolve) => (timer = setTimeout(resolve, remainingMs)));
    await Promise.race([write.done, aged]).finally(() => clearTimeout(timer));
  }

  private remember(id: BackendMsgId): void {
    this.ids.delete(id);
    this.ids.add(id);
    if (this.ids.size > OWN_POSTS_MAX) this.ids.delete(this.ids.values().next().value!);
  }
}
