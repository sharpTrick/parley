/**
 * Bounds on the reconnect ladder, DERIVED from the plugin's exported constants — so a budget case
 * states a band a reader can recompute instead of a hand-tuned margin that silently widens.
 */
import { BACKOFF_BASE_MS, RECONNECT_CAP_MS } from '../src/index.js';
import { FakeWs, instances } from './fake-gateway.js';

/**
 * Dials one instance can fit into `windowMs`: the rungs it takes to climb to `capMs`, plus one per
 * cap-length interval after that.
 */
export const dialCeiling = (windowMs: number, capMs: number = RECONNECT_CAP_MS): number =>
  Math.ceil(Math.log2(capMs / BACKOFF_BASE_MS)) + 1 + Math.ceil(windowMs / capMs);

/** Backoff delays only — a per-socket handshake watchdog is not a reconnect step. */
export const ladderDelays = (
  calls: Array<unknown[]>,
  handshakeMs: number,
): number[] =>
  calls.map((c) => c[1] as number).filter((d) => d >= BACKOFF_BASE_MS && d !== handshakeMs);

/**
 * A pump that HELLOs each newly opened socket ONCE and then advances the clock. Keep the HELLO ahead
 * of the advance, so that a step longer than `handshake_timeout_ms` cannot let the watchdog terminate
 * a socket the test never drove — that turns a scripted close into an extra, unscripted ladder step.
 */
export function dialPump(
  advance: (ms: number) => Promise<unknown>,
  hb: number,
): (steps: number, stepMs: number) => Promise<void> {
  const driven = new Set<FakeWs>();
  return async (steps, stepMs) => {
    for (let i = 0; i < steps; i++) {
      for (const ws of [...instances]) {
        if (driven.has(ws)) continue;
        driven.add(ws);
        if (ws.readyState === FakeWs.OPEN) ws.hello(hb);
      }
      await advance(stepMs);
    }
  };
}
