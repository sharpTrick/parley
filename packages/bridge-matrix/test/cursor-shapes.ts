import type { Cursor } from '@sharptrick/parley-core';

/**
 * Every cursor FORM this plugin emits, in ONE place: the predicate that recognizes it at run time.
 * The cursor tests grade what the plugin mints against `is`, so a row here is the single answer to
 * "is this the shape that origin produces".
 */
export interface CursorShape {
  is: (c: Cursor) => boolean;
}

export const SHAPES = {
  'event id': { is: (c: Cursor) => /^\$/.test(String(c)) },
  'stream token': {
    is: (c: Cursor) => String(c).startsWith('@parley-stream:'),
  },
  'not minted by this plugin': { is: () => true },
} satisfies Record<string, CursorShape>;
