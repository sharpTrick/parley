import type { Cursor } from '@sharptrick/parley-core';

/**
 * Every cursor FORM this plugin emits, in ONE place: the predicate that recognizes it at run time,
 * and the literal a reader would grep a doc for. The cursor tests grade what the plugin mints
 * against `is`; `shipped-artifacts.test.ts` grades `marker` against BOTH the package README and
 * DESIGN §6's Matrix row, so a form only one of them knows about — the shape a reader meets in a
 * `read-state.json` and cannot name — fails the day it is added rather than the day it confuses
 * somebody.
 */
export interface CursorShape {
  /** Literal both docs must carry, or `undefined` for a value this plugin never mints itself. */
  marker?: string;
  is: (c: Cursor) => boolean;
}

export const SHAPES = {
  'event id': { marker: 'event_id', is: (c: Cursor) => /^\$/.test(String(c)) },
  'stream token': {
    marker: '@parley-stream:',
    is: (c: Cursor) => String(c).startsWith('@parley-stream:'),
  },
  'not minted by this plugin': { is: () => true },
} satisfies Record<string, CursorShape>;
