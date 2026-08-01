/**
 * Keep both caps SHEDDING rather than refusing, so that the anonymous caller who filled the map —
 * anyone who can reach /register or /authorize creates state without spending the owner's
 * passphrase — cannot lock the owner out of the only path that authorizes the bridge. The sweeper's
 * TTLs are a rate, not a bound; these are the bound.
 */

export const MAX_CLIENTS = 100;
export const MAX_PENDING = 100;

export interface ClientState {
  clientId: string;
  expiresAtMs: number;
  /** Whether reaching this state cost the owner's passphrase, or any anonymous caller can create it. */
  ownerApproved: boolean;
}

/**
 * An idle registration first, then one holding nothing but a consent nobody has approved yet. Only
 * owner-approved state is unevictable, and `undefined` means every registration holds some.
 */
export function evictionCandidate(
  clientIds: Iterable<string>,
  clientStates: Iterable<ClientState>,
  nowMs: number,
): string | undefined {
  const live = [...clientStates].filter((state) => state.expiresAtMs >= nowMs);
  const holders = (accept: (state: ClientState) => boolean): Set<string> =>
    new Set(live.filter(accept).map((state) => state.clientId));
  const anyState = holders(() => true);
  const approved = holders((state) => state.ownerApproved);
  const ids = [...clientIds];
  return ids.find((id) => !anyState.has(id)) ?? ids.find((id) => !approved.has(id));
}

/**
 * Drop entries until the map is within `max`, always taking the OLDEST entry of whichever client
 * holds the MOST, and falling back to plain oldest-first among clients holding equally many. Keep
 * the per-client tier, so that one caller filling the map with its own entries can never displace an
 * entry belonging to a different client — for `pending`, undifferentiated FIFO shedding IS the
 * lockout the shed-don't-refuse policy above exists to prevent. A Map iterates in insertion order,
 * so the first key seen for a client is its oldest, and a strict `>` keeps ties on that order.
 */
export function shedCrowdedest<V>(
  map: Map<string, V>,
  max: number,
  clientOf: (value: V) => string,
): void {
  while (map.size > max) {
    const oldestOf = new Map<string, string>();
    const held = new Map<string, number>();
    let crowdedest = '';
    for (const [key, value] of map) {
      const client = clientOf(value);
      if (!oldestOf.has(client)) oldestOf.set(client, key);
      const n = (held.get(client) ?? 0) + 1;
      held.set(client, n);
      if (n > (held.get(crowdedest) ?? 0)) crowdedest = client;
    }
    const victim = oldestOf.get(crowdedest);
    if (victim === undefined) return;
    map.delete(victim);
  }
}
