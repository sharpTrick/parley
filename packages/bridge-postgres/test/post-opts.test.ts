import { readFileSync } from 'node:fs';
import {
  asHandle,
  asTopic,
  type BackendMsgId,
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

const SEAM = readFileSync(new URL('../../bridge-core/src/seam.ts', import.meta.url), 'utf8');

const POST_OPTS = [
  ...(/\bpost\(\s*topic: Topic,[\s\S]*?opts\?: \{([^}]*)\}/.exec(SEAM)?.[1] ?? '').matchAll(
    /(\w+)\??\s*:/g,
  ),
]
  .map((m) => m[1] as string)
  .sort();

describe('the seam pins which post() arguments this file has to grade', () => {
  it('post() takes exactly the opts keys graded below', () => {
    expect(POST_OPTS, 'a new post() opts key needs a persistence cell in this file').toEqual([
      'inReplyTo',
    ]);
  });
});

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
  return withAdmin(async (admin) => {
    const res = await admin.query(`SELECT in_reply_to FROM "${table}" WHERE topic = $1 ORDER BY seq`, [
      topic,
    ]);
    return (res.rows as { in_reply_to: string | null }[]).map((r) => r.in_reply_to);
  });
}

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
