import {
  asBackendMsgId,
  asHandle,
  asTopic,
  type BackendMsgId,
  type BackendPlugin,
  type Handle,
  type Topic,
} from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { PostgresPlugin } from '../src/index.js';
import { dropTable, isUp, PG_URL, rand, withAdmin } from './pg-harness.js';

// `post()`'s `opts` is the seam's only threading argument, and this plugin is where it stops:
// `in_reply_to` is written but never projected back into a normalized Message (DESIGN §5 has no
// reply field), so no consumer can tell whether the write happened. Replacing the bind with a
// literal NULL left this whole package green. So the column is read back over an ADMIN connection —
// the only place the stored value is observable — and the key set is read out of the seam, so an
// argument added there cannot be accepted by this plugin and silently discarded.

type PostOpts = NonNullable<Parameters<BackendPlugin['post']>[3]>;

/**
 * Where each `post()` opts key lands in this backend's table. Keyed off the seam TYPE — imported,
 * never read out of `bridge-core/src/seam.ts` as text: a regex over a sibling package's source
 * reddens THIS package when core renames a parameter, and reports the failure against the wrong
 * one. `satisfies` grades both directions at compile time: a key added to the seam with no column
 * here does not build, and a column for a key the seam never declared does not either.
 */
const PERSISTED_COLUMN = { inReplyTo: 'in_reply_to' } satisfies Record<keyof PostOpts, string>;

interface Anchors {
  sameTopic: BackendMsgId;
  otherTopic: BackendMsgId;
}

interface Threading {
  label: string;
  opts: (a: Anchors) => { inReplyTo?: BackendMsgId } | undefined;
  stored: (a: Anchors) => string | null;
}

const THREADINGS: Threading[] = [
  { label: 'no opts argument', opts: () => undefined, stored: () => null },
  { label: 'an opts object without the key', opts: () => ({}), stored: () => null },
  {
    label: 'the key present and undefined',
    opts: () => ({ inReplyTo: undefined }),
    stored: () => null,
  },
  {
    label: 'an id from an earlier post in the same topic',
    opts: (a) => ({ inReplyTo: a.sameTopic }),
    stored: (a) => String(a.sameTopic),
  },
  {
    label: 'a valid id belonging to a row in another topic',
    opts: (a) => ({ inReplyTo: a.otherTopic }),
    stored: (a) => String(a.otherTopic),
  },
];

/** `table_name` reaches SQL as interpolated text, so the write path is graded under both spellings. */
const TABLES = ['an ordinary name', 'a reserved word'] as const;

/** The stored column, per row of `topic`, in cursor order — invisible to every seam read path. */
async function storedReplies(table: string, topic: Topic): Promise<(string | null)[]> {
  const column = PERSISTED_COLUMN.inReplyTo;
  return withAdmin(async (admin) => {
    const res = await admin.query(
      `SELECT "${column}" AS stored FROM "${table}" WHERE topic = $1 ORDER BY seq`,
      [topic],
    );
    return (res.rows as { stored: string | null }[]).map((r) => r.stored);
  });
}

describe('the seam pins which post() arguments this file has to grade', () => {
  const SAMPLE: Anchors = {
    sameTopic: asBackendMsgId('1'),
    otherTopic: asBackendMsgId('2'),
  };

  it('every opts key the seam declares is passed by a threading row and read back from a column', () => {
    const exercised = [
      ...new Set(THREADINGS.flatMap((t) => Object.keys(t.opts(SAMPLE) ?? {}))),
    ].sort();
    expect(exercised, 'a new post() opts key needs a persistence cell in this file').toEqual(
      Object.keys(PERSISTED_COLUMN).sort(),
    );
  });
});

const CELLS = TABLES.flatMap((table) => THREADINGS.map((threading) => ({ table, threading })));

if (await isUp(PG_URL)) {
  describe('post() persists every threading argument the seam declares', () => {
    it.each(CELLS.map((c) => [`${c.threading.label}, table_name is ${c.table}`, c] as const))(
      '%s',
      async (_label, cell) => {
        // The BARE reserved word — suffixing it would make it an ordinary identifier and grade nothing.
        const table = cell.table === 'a reserved word' ? 'grant' : `parley_rep_${rand()}`;
        const topic: Topic = asTopic(`rep-${rand()}`);
        const elsewhere: Topic = asTopic(`rep-other-${rand()}`);
        const alice: Handle = asHandle('alice');

        await dropTable(table);
        const plugin = new PostgresPlugin();
        try {
          await plugin.connect({ url: PG_URL, table_name: table });
          const anchors: Anchors = {
            sameTopic: await plugin.post(topic, alice, 'anchor'),
            otherTopic: await plugin.post(elsewhere, alice, 'anchor elsewhere'),
          };
          await plugin.post(topic, alice, 'reply', cell.threading.opts(anchors));

          expect(await storedReplies(table, topic), 'the stored in_reply_to is not what was passed').toEqual([
            null,
            cell.threading.stored(anchors),
          ]);
          const { messages } = await plugin.fetchRecent({ topic });
          expect(messages.map((m) => m.content), 'the graded rows are not the posted ones').toEqual([
            'anchor',
            'reply',
          ]);
        } finally {
          await plugin.disconnect();
          await dropTable(table);
        }
      },
      60000,
    );
  });
} else {
  describe.skip(`post() opts persistence (no server at ${PG_URL})`, () => {
    it('skipped — start postgres (examples/dev-compose) to run', () => undefined);
  });
}
