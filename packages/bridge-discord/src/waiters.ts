/**
 * Native long-poll wakeups: channel id → one-shot callbacks armed by a blocking `fetchRecent`,
 * fired by a MESSAGE_CREATE on that channel or by the socket going away. Keep them independent
 * of the subscription table and listening on the SHARED socket, so that a blocking fetch never
 * opens a second gateway connection or registers a subscription core did not ask for.
 */
export type Waiters = Map<string, Set<() => void>>;

export interface Waiter { fired: Promise<void>; cancel: () => void }

/**
 * Fire every waiter on `channelId`, or on EVERY channel when it is omitted. Iterate over copies, so
 * that a callback which cancels or arms a waiter cannot cut the fan-out short.
 */
export function wake(waiters: Waiters, channelId?: string): void {
  const sets = channelId === undefined ? [...waiters.values()] : [waiters.get(channelId)];
  for (const set of sets) if (set !== undefined) for (const fire of [...set]) fire();
}

/**
 * Arm a one-shot waiter on `channelId`: `fired` resolves on a MESSAGE_CREATE for that channel,
 * at `blockMs`, or when the socket goes away. Keep `cancel()` idempotent and shared with the fire
 * path, so that no timer or map entry can leak past the wait.
 */
export function arm(waiters: Waiters, channelId: string, blockMs: number): Waiter {
  let settled = false;
  let timer: NodeJS.Timeout;
  let fire!: () => void;
  const fired = new Promise<void>((resolve) => {
    fire = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const set = waiters.get(channelId);
      set?.delete(fire);
      if (set?.size === 0) waiters.delete(channelId);
      resolve();
    };
  });
  timer = setTimeout(fire, blockMs);
  const armed = waiters.get(channelId) ?? new Set<() => void>();
  waiters.set(channelId, armed);
  armed.add(fire);
  return { fired, cancel: fire };
}
