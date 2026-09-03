import { delay } from '@sharptrick/parley-net-util';
import { Client } from 'pg';
import { endWithin, SOCKET_BOUNDS, TEARDOWN_WAIT_MS } from './connection.js';
import { PostgresPush } from './push.js';

/** Backoff between listener reconnect attempts after the connection drops. */
const RECONNECT_DELAY_MS = 500;
/**
 * How long a seam call waits for the shared LISTEN connection — a first connect, or the backoff
 * reconnect after a drop — before giving up. Bounded for the same reason as {@link LOCK_WAIT_MS}.
 */
export const LISTENER_WAIT_MS = 5000;

const dialTimedOut = (): Error =>
  new Error(`the listener connection did not come up within ${LISTENER_WAIT_MS}ms`);

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

export interface ListenState {
  /** Resolves only once the LISTEN is ESTABLISHED — never merely intended. */
  ready: Promise<void>;
  /** Subscriptions that still need this channel LISTENed. */
  refs: number;
}

/**
 * The one shared non-pool LISTEN connection: bringing it up, wiring it, replacing it, and the
 * reference-counted LISTENs the subscriptions on it hold.
 */
export abstract class PostgresListener extends PostgresPush {
  /**
   * Take a reference on the channel's LISTEN, resolving only once that LISTEN is ESTABLISHED —
   * publishing "someone intends to LISTEN" as if it were "the channel is LISTENed" strands the
   * caller on a doorbell that may never be installed. Rejects (having taken no reference) if the
   * LISTEN failed, so the caller can fall back.
   */
  protected async acquireListen(listener: Client, channel: string): Promise<ListenState> {
    const existing = this.listens.get(channel);
    if (existing !== undefined) {
      existing.refs++;
      try {
        await existing.ready;
      } catch (err) {
        this.releaseListen(channel, existing);
        throw err;
      }
      return existing;
    }
    const entry: ListenState = {
      ready: listener.query(`LISTEN "${channel}"`).then(() => undefined),
      refs: 1,
    };
    this.listens.set(channel, entry);
    try {
      await entry.ready;
    } catch (err) {
      if (this.listens.get(channel) === entry) this.listens.delete(channel);
      throw err;
    }
    return entry;
  }

  protected releaseListen(channel: string, entry: ListenState): void {
    if (this.listens.get(channel) !== entry) return;
    entry.refs--;
    if (entry.refs > 0) return;
    this.listens.delete(channel);
    if (!this.stopped && this.listener !== undefined) {
      void this.listener.query(`UNLISTEN "${channel}"`).catch(() => undefined);
    }
  }

  /**
   * The shared LISTEN connection: created lazily on first subscribe, and REPLACED by the backoff
   * reconnect after a drop. Keep the memo pointing at the reconnect that is in flight rather than
   * at the client whose socket just closed, so that a `subscribe` issued during the blackout waits
   * for the replacement and then succeeds — handed the dead client it is guaranteed to fail, and
   * core's push loop rethrows that, so the whole bridge fails to come up. The wait is bounded, so
   * an outage that outlasts {@link LISTENER_WAIT_MS} is a named error rather than a call that never
   * settles.
   */
  protected ensureListener(): Promise<Client> {
    if (this.listenerPromise === undefined) {
      const attempt: Promise<Client> = this.createListener().catch((err: unknown) => {
        if (this.listenerPromise === attempt) this.listenerPromise = undefined;
        throw err;
      });
      this.listenerPromise = attempt;
    }
    return withDeadline(this.listenerPromise, LISTENER_WAIT_MS, dialTimedOut);
  }

  /**
   * Keep the DIAL bounded here rather than at the caller, so that no attempt can stay memoised in
   * `listenerPromise` for longer than {@link LISTENER_WAIT_MS}: a caller's deadline rejects the
   * caller and leaves the memo, and every later `subscribe` then awaits the same dead promise and
   * is told to retry something that cannot work.
   */
  private async createListener(): Promise<Client> {
    const epoch = this.epoch;
    const client = new Client({ connectionString: this.url, ...SOCKET_BOUNDS });
    this.wireListener(client);
    this.starting.add(client);
    try {
      await withDeadline(client.connect(), LISTENER_WAIT_MS, dialTimedOut);
    } catch (err) {
      // End the candidate this attempt is walking away from, so that a dial which lands after its
      // memo was cleared cannot publish a second listener over the one its successor adopted — but
      // do NOT wait on it, so that a socket which refuses to close gracefully cannot keep the memo
      // alive past the deadline that is the whole point of this bound.
      if (this.starting.delete(client)) void endWithin(client, TEARDOWN_WAIT_MS);
      throw err;
    }
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
      await endWithin(client, TEARDOWN_WAIT_MS);
      throw new Error('parley-postgres: disconnected while the listener connection was in flight');
    }
    this.listener = client;
    return client;
  }

  /**
   * Re-drive every subscription registered on these channels: each re-queries from `lastSeen`. Keep
   * EVERY registry reachable from this ONE call, so that a recovery path cannot re-drive some of
   * them and leave the rest asleep on a doorbell that is never going to ring again.
   */
  protected redrive(channels: Iterable<string>): void {
    for (const channel of channels) {
      const sub = this.subs.get(channel);
      if (sub !== undefined) this.drain(sub);
    }
  }

  private wireListener(client: Client): void {
    client.on('error', () => {
      /* Keep this swallow, so that a socket error cannot kill the process; 'end' follows it and
         drives the reconnect. */
    });
    client.on('notification', (n) => {
      // Payload is a hint only (size limits + best-effort delivery) — always re-query.
      this.redrive([n.channel]);
    });
    client.on('end', () => {
      if (!this.stopped && this.listener === client) {
        void this.reconnectListener().catch(() => undefined);
      }
    });
  }

  /**
   * Backoff loop: new connection, re-LISTEN every channel, then {@link redrive} every subscription —
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
        const client = new Client({ connectionString: this.url, ...SOCKET_BOUNDS });
        this.wireListener(client);
        this.starting.add(client);
        try {
          await withDeadline(client.connect(), LISTENER_WAIT_MS, dialTimedOut);
          if (this.stopped || epoch !== this.epoch) {
            this.starting.delete(client);
            await endWithin(client, TEARDOWN_WAIT_MS);
            return;
          }
          // Re-LISTEN every channel a subscription needs, so a reconnect still delivers the
          // doorbell.
          const listened: string[] = [];
          for (const channel of this.listens.keys()) {
            await client.query(`LISTEN "${channel}"`);
            listened.push(channel);
          }
          await this.adoptListener(client, epoch);
          // The loop above awaits, and a subscription's last reference can be dropped inside it,
          // with no live connection to send its UNLISTEN to. Keep this reconciliation, so that the
          // replacement is not left registered for a channel nothing needs — every future post to
          // that topic would wake the process forever.
          for (const channel of listened) {
            if (!this.listens.has(channel)) {
              void client.query(`UNLISTEN "${channel}"`).catch(() => undefined);
            }
          }
          landed(client);
          adopted = true;
          this.redrive([...this.subs.keys()]);
          return;
        } catch {
          // Bounded and not awaited, so that a peer which accepts the socket and then says nothing
          // can park neither this attempt nor the ladder's next rung.
          this.starting.delete(client);
          void endWithin(client, TEARDOWN_WAIT_MS);
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
