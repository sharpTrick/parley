import { delay } from '@sharptrick/parley-net-util';
import { Client } from 'pg';
import { PostgresPush } from './push.js';

/** Backoff between listener reconnect attempts after the connection drops. */
const RECONNECT_DELAY_MS = 500;
/**
 * How long a seam call waits for the shared LISTEN connection — a first connect, or the backoff
 * reconnect after a drop — before giving up. Bounded for the same reason as {@link LOCK_WAIT_MS}.
 */
export const LISTENER_WAIT_MS = 5000;

/** Reject with `onTimeout()` if `p` has not settled within `budgetMs`; never leaves a timer behind. */
async function withDeadline<T>(p: Promise<T>, budgetMs: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(onTimeout()), budgetMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The one shared non-pool LISTEN connection: bringing it up, wiring it, and replacing it. */
export abstract class PostgresListener extends PostgresPush {
  /**
   * The shared LISTEN connection: created lazily on first subscribe, and REPLACED by the backoff
   * reconnect after a drop. Keep the memo pointing at the reconnect that is in flight rather than
   * at the client whose socket just closed, so that a `subscribe` issued during the blackout waits
   * for the replacement and then succeeds — handed the dead client it is guaranteed to fail, and
   * core's push loop rethrows that, so the whole bridge fails to come up. The wait is bounded, so
   * an outage that outlasts `budgetMs` is a named error rather than a call that never settles.
   */
  protected ensureListener(budgetMs = LISTENER_WAIT_MS): Promise<Client> {
    if (this.listenerPromise === undefined) {
      const attempt: Promise<Client> = this.createListener().catch((err: unknown) => {
        if (this.listenerPromise === attempt) this.listenerPromise = undefined;
        throw err;
      });
      this.listenerPromise = attempt;
    }
    const late = (): Error =>
      new Error(`the listener connection did not come up within ${budgetMs}ms`);
    return withDeadline(this.listenerPromise, budgetMs, late);
  }

  private async createListener(): Promise<Client> {
    const epoch = this.epoch;
    const client = new Client({ connectionString: this.url });
    this.wireListener(client);
    this.starting.add(client);
    await client.connect();
    return this.adoptListener(client, epoch);
  }

  /**
   * The one place a freshly connected candidate becomes `this.listener`. Keep EVERY path that opens
   * a listener socket publishing the candidate into {@link PluginState.starting} before it dials
   * and going through here afterwards, so that a `disconnect()` which completed while the connect
   * was in flight cannot have RETURNED leaving a live pg connection attached to a stopped plugin —
   * an orphan pins the Node event loop and holds a server backend slot for the life of the process.
   */
  private async adoptListener(client: Client, epoch: number): Promise<Client> {
    if (!this.starting.delete(client) || this.stopped || epoch !== this.epoch) {
      await client.end().catch(() => undefined);
      throw new Error('parley-postgres: disconnected while the listener connection was in flight');
    }
    this.listener = client;
    return client;
  }

  /**
   * Re-drive every participant registered on these channels — the subscription re-queries from
   * `lastSeen`, and the parked blocking waiters are served according to `doorbell`. Keep EVERY
   * participant registry reachable from this ONE call, so that a recovery path cannot re-drive some
   * of them and leave the rest asleep on a doorbell that is never going to ring again.
   *
   * `'rang'` is a NOTIFY that really fired, so each waiter ends its wait and its caller re-runs the
   * exclusive `since` query. `'silent'` is a recovery with nothing behind it, so each waiter
   * re-reads first: waking one that has nothing to return ends a native long-poll early and drops
   * the LISTEN reference its topic still needs.
   */
  protected redrive(channels: Iterable<string>, doorbell: 'rang' | 'silent'): void {
    for (const channel of channels) {
      const sub = this.subs.get(channel);
      if (sub !== undefined) this.drain(sub);
      const set = this.waiters.get(channel);
      if (set === undefined) continue;
      for (const waiter of [...set]) (doorbell === 'rang' ? waiter.wake : waiter.recheck)();
    }
  }

  private wireListener(client: Client): void {
    client.on('error', () => {
      /* Keep this swallow, so that a socket error cannot kill the process; 'end' follows it and
         drives the reconnect. */
    });
    client.on('notification', (n) => {
      // Payload is a hint only (size limits + best-effort delivery) — always re-query.
      this.redrive([n.channel], 'rang');
    });
    client.on('end', () => {
      if (!this.stopped && this.listener === client) {
        void this.reconnectListener().catch(() => undefined);
      }
    });
  }

  /**
   * Backoff loop: new connection, re-LISTEN every channel, then {@link redrive} every participant —
   * anything posted while we were dark rang a NOTIFY nobody heard and nothing rings again, so a lost
   * notification window costs latency, never a message.
   */
  private async reconnectListener(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    const epoch = this.epoch;
    let landed!: (client: Client) => void;
    let abandoned!: (err: unknown) => void;
    const replacement = new Promise<Client>((resolve, reject) => {
      landed = resolve;
      abandoned = reject;
    });
    // Keep this handler, so that a reconnect abandoned with no seam call waiting on it is not an
    // unhandled rejection that takes the process down.
    replacement.catch(() => undefined);
    this.listenerPromise = replacement;
    let adopted = false;
    try {
      while (!this.stopped && epoch === this.epoch) {
        await delay(RECONNECT_DELAY_MS);
        if (this.stopped || epoch !== this.epoch) return;
        const client = new Client({ connectionString: this.url });
        this.wireListener(client);
        this.starting.add(client);
        try {
          await client.connect();
          if (this.stopped || epoch !== this.epoch) {
            this.starting.delete(client);
            await client.end().catch(() => undefined);
            return;
          }
          // Re-LISTEN every channel a subscription OR an in-flight blocking waiter needs, so a
          // reconnect mid-wait still delivers the doorbell.
          const listened: string[] = [];
          for (const channel of this.listens.keys()) {
            await client.query(`LISTEN "${channel}"`);
            listened.push(channel);
          }
          await this.adoptListener(client, epoch);
          // The loop above awaits, and a waiter's blockMs can expire inside it: that release has
          // already dropped the channel with no live connection to send its UNLISTEN to. Keep this
          // reconciliation, so that the replacement is not left registered for a channel no
          // participant needs — every future post to that topic would wake the process forever.
          for (const channel of listened) {
            if (!this.listens.has(channel)) {
              void client.query(`UNLISTEN "${channel}"`).catch(() => undefined);
            }
          }
          landed(client);
          adopted = true;
          this.redrive(new Set([...this.subs.keys(), ...this.waiters.keys()]), 'silent');
          return;
        } catch {
          this.starting.delete(client);
          await client.end().catch(() => undefined);
          // server still unreachable — back off and try again
        }
      }
    } finally {
      // A loop that gave up must settle the memo every waiting seam call is parked on, and clear
      // it, so that a later subscribe starts a fresh listener instead of awaiting a dead promise.
      if (!adopted) {
        abandoned(new Error('the listener reconnect was abandoned by disconnect()'));
        if (this.listenerPromise === replacement) this.listenerPromise = undefined;
      }
      // Keep the flag owned by the lifecycle that set it, so that this loop exiting after a
      // disconnect() cannot clear a successor lifecycle's reconnect and let two run at once.
      if (epoch === this.epoch) this.reconnecting = false;
    }
  }
}
