import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { installShutdown, type ShutdownHost } from './backend-cli.js';

/**
 * The bridge's teardown runs once, from four independent triggers. Grade the shipped wiring, not a
 * transcription of it: a stub host makes every trigger order reachable, and a dropped registration
 * or a lost once-only guard then fails here instead of surviving as a duplicate `bridge.shutdown()`
 * that still exits 0 and looks fine end to end.
 */

type Trigger = 'SIGINT' | 'SIGTERM' | 'end' | 'close';

function wire(): { fire: (t: Trigger) => void; calls: () => number } {
  const signals = new EventEmitter();
  const stdin = new EventEmitter();
  let calls = 0;
  installShutdown({ on: signals.on.bind(signals), stdin } as unknown as ShutdownHost, () => {
    calls++;
  });
  return {
    fire: (t) => {
      const listened = t === 'end' || t === 'close' ? stdin.emit(t) : signals.emit(t);
      expect(listened, `nothing is listening for '${t}'`).toBe(true);
    },
    calls: () => calls,
  };
}

const SEQUENCES: Trigger[][] = [
  ['end'],
  ['close'],
  ['SIGINT'],
  ['SIGTERM'],
  ['end', 'close'],
  ['close', 'end'],
  ['SIGINT', 'end'],
  ['end', 'SIGINT'],
  ['close', 'SIGTERM'],
  ['SIGINT', 'SIGTERM'],
  ['end', 'close', 'SIGINT', 'SIGTERM'],
  ['SIGTERM', 'SIGTERM', 'close', 'close'],
];

describe('installShutdown runs teardown exactly once, from every trigger', () => {
  for (const sequence of SEQUENCES) {
    it(sequence.join(' then '), () => {
      const w = wire();
      expect(w.calls()).toBe(0);
      for (const t of sequence) w.fire(t);
      expect(w.calls()).toBe(1);
    });
  }
});
