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

/** Drop entries until the map is within `max`; a Map iterates in insertion order, so oldest first. */
export function shedOldest<V>(map: Map<string, V>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}
