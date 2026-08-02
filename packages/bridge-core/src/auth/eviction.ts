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
 * An idle registration first, then the MOST RECENT one holding nothing but a consent nobody has
 * approved yet. Only owner-approved state is unevictable, and `undefined` means every registration
 * holds some.
 *
 * Keep the second pass reading from the NEWEST end, so that a flood leaving every registration
 * holding anonymous-tier state cannot take the owner's: a pending consent is `ownerApproved: false`
 * by design, so a first-match scan returns the owner's registration — necessarily the oldest — and
 * deleting it invalidates the consent page they are looking at while they type the passphrase.
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
  return ids.find((id) => !anyState.has(id)) ?? [...ids].reverse().find((id) => !approved.has(id));
}

/**
 * Drop entries until the map is within `max`, always taking the OLDEST entry of whichever client
 * holds the MOST, and breaking a tie toward the client whose entries are the MOST RECENT. Keep the
 * per-client tier, so that one caller filling the map with its own entries can never displace an
 * entry belonging to a different client — for `pending`, undifferentiated FIFO shedding IS the
 * lockout the shed-don't-refuse policy above exists to prevent.
 *
 * A Map iterates in insertion order, so the first key seen for a client is its oldest. Keep the tie
 * break pointing at the NEWEST client, so that a flood spending one fresh client_id per entry — which
 * leaves nobody crowdedest and collapses the tier — cannot degenerate into plain oldest-first and
 * take the owner's entry, which is always the oldest one there is. `>=` against a count read live
 * gives that: the last client to reach the maximum wins. The caller must shed BEFORE inserting, so
 * that the arriving entry is never the victim chosen to make room for it.
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
      if (n >= (held.get(crowdedest) ?? 0)) crowdedest = client;
    }
    const victim = oldestOf.get(crowdedest);
    if (victim === undefined) return;
    map.delete(victim);
  }
}
