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
  private inFlight = 0;
  private idle: Promise<void> = Promise.resolve();
  private release: () => void = () => {};

  async track(write: () => Promise<BackendMsgId>): Promise<BackendMsgId> {
    if (this.inFlight++ === 0) this.idle = new Promise((resolve) => (this.release = resolve));
    try {
      const id = await write();
      this.remember(id);
      return id;
    } finally {
      if (--this.inFlight === 0) this.release();
    }
  }

  has(id: BackendMsgId): boolean {
    return this.ids.has(id);
  }

  /**
   * Resolves once no write is in flight, so every id a write is about to return is known — or after
   * a bounded wait, whichever is first.
   */
  settled(): Promise<void> {
    if (this.inFlight === 0) return this.idle;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const elapsed = new Promise<void>((resolve) => (timer = setTimeout(resolve, WRITE_WAIT_MS)));
    return Promise.race([this.idle, elapsed]).finally(() => clearTimeout(timer));
  }

  private remember(id: BackendMsgId): void {
    this.ids.delete(id);
    this.ids.add(id);
    if (this.ids.size > OWN_POSTS_MAX) this.ids.delete(this.ids.values().next().value!);
  }
}
