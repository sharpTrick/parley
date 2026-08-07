import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
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

/**
 * A lifecycle event is one-shot and is never re-delivered, so a listener armed AFTER it can still
 * be missed — and the wiring above is armed late by construction: the MCP stdio transport puts
 * stdin into flowing mode as soon as the server connects, while the bridge is still awaiting
 * `subscribe()`. The table above cannot see that, because every trigger it fires goes through an
 * EventEmitter it owns, always after registration. So drive a REAL `Readable` into each terminal
 * state a chosen number of macrotasks either side of the wiring, and require teardown exactly once
 * in every cell — the state check and the listener are then each the only thing standing between a
 * column of cells and a bridge that heart-beats a ghost peer forever.
 */

/** Mirrors `process.stdin`: flowing, and `autoDestroy: false`, so EOF emits 'end' and never 'close'. */
function flowingStdin(): Readable {
  const stream = new Readable({ read() {}, autoDestroy: false });
  stream.on('data', () => {});
  return stream;
}

function wireReal(stdin: Readable): () => number {
  const signals = new EventEmitter();
  let calls = 0;
  installShutdown({ on: signals.on.bind(signals), stdin } as unknown as ShutdownHost, () => {
    calls++;
  });
  return () => calls;
}

const macrotasks = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

const TERMINALS = [
  { label: 'EOF', enter: (s: Readable) => void s.push(null) },
  { label: 'destroy without EOF', enter: (s: Readable) => void s.destroy() },
] as const;

/** Macrotasks between the terminal state and the wiring — the window `subscribe()` opens. */
const WINDOWS = [0, 1, 2] as const;

describe('teardown runs exactly once however the stream terminates around the wiring', () => {
  for (const terminal of TERMINALS) {
    for (const window of WINDOWS) {
      it(`${terminal.label} ${window} macrotasks BEFORE installShutdown`, async () => {
        const stdin = flowingStdin();
        terminal.enter(stdin);
        await macrotasks(window);
        const calls = wireReal(stdin);
        await macrotasks(3);
        expect(calls()).toBe(1);
      });

      it(`${terminal.label} ${window} macrotasks AFTER installShutdown`, async () => {
        const stdin = flowingStdin();
        const calls = wireReal(stdin);
        await macrotasks(window);
        expect(calls(), 'a stream that has not terminated is not a torn-down one').toBe(0);
        terminal.enter(stdin);
        await macrotasks(3);
        expect(calls()).toBe(1);
      });
    }
  }
});
