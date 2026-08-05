import { asBackendMsgId, asHandle, asTopic } from '@sharptrick/parley-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresPlugin } from '../src/index.js';
import { dropTable, isUp, PG_URL, rand, withAdmin } from './pg-harness.js';
import {
  CORPUS,
  type Field,
  indexableFields,
  ROUND_TRIP_VALUES,
  ROUND_TRIPS,
} from './storable-corpus.js';

// A corpus row claiming a value is stored and read back unchanged is claiming something about the
// SERVER, and the mocked suite cannot see it: `FakePool` records the SQL text and never encodes a
// bind parameter, so a lone surrogate — which the driver rewrites to U+FFFD — graded green there as
// "accepted, and reaches the database" while a real PostgreSQL merged two topics into one history
// and handed back content nobody posted.
//
// So every ROUND_TRIPS value is driven through this plugin and read back off a real server, and the
// last case asserts the whole arm was covered here rather than left to the fake — a row added to
// the corpus and never exercised against a server fails instead of quietly grading nothing.

const up = await isUp(PG_URL);
const table = `parley_rt_${rand()}`;

/** Values proven against the server, filled in by the cells below and audited by the last case. */
const proven = new Set<string>();

const CELLS = CORPUS.filter(([, , arm]) => arm === ROUND_TRIPS).flatMap(([label, value]) =>
  indexableFields(value).map((field) => [`${field} carrying ${label}`, field, value] as const),
);

let plugin: PostgresPlugin;

describe.skipIf(!up)(`a value this backend accepts is read back byte-identical (${table})`, () => {
  beforeAll(async () => {
    plugin = new PostgresPlugin();
    await plugin.connect({ url: PG_URL, table_name: table });
  });

  afterAll(async () => {
    await plugin.disconnect();
    await dropTable(table);
  });

  it('there are cells to run, and they cover every field the seam takes', () => {
    expect(CELLS.length).toBeGreaterThan(0);
    expect([...new Set(CELLS.map(([, field]) => field))].sort()).toEqual(
      ['content', 'handle', 'inReplyTo', 'topic'].sort(),
    );
  });

  // Each cell posts under a topic derived from the cell, and a `topic` cell posts under the corpus
  // value ITSELF. So `messages` holding exactly one row is also the distinctness assertion: two
  // topics the server folded together would each read back both rows.
  it.each(CELLS)('%s', async (label, field: Field, value) => {
    const topic = asTopic(field === 'topic' ? value : `rt-${label}`);
    const handle = asHandle(field === 'handle' ? value : 'u');
    const content = field === 'content' ? value : `body for ${label}`;
    const id = await plugin.post(
      topic,
      handle,
      content,
      field === 'inReplyTo' ? { inReplyTo: asBackendMsgId(value) } : undefined,
    );

    const page = await plugin.fetchRecent({ topic });
    expect(page.messages, 'this topic shares storage with another one').toHaveLength(1);
    const [message] = page.messages;
    expect(message?.topic, 'the topic read back is not the topic posted to').toBe(topic);
    expect(message?.senderHandle, 'the handle was altered in storage').toBe(handle);
    expect(message?.content, 'the content was altered in storage').toBe(content);

    // `in_reply_to` is written but never projected into a Message, so the stored value is only
    // observable over an admin connection.
    const stored = await withAdmin(async (admin) => {
      const res = await admin.query(`SELECT in_reply_to FROM "${table}" WHERE seq = $1::bigint`, [
        String(id),
      ]);
      return (res.rows[0] as { in_reply_to: string | null }).in_reply_to;
    });
    expect(stored, 'in_reply_to was altered in storage').toBe(field === 'inReplyTo' ? value : null);

    const identity = await plugin.resolveIdentity(handle);
    expect(identity.backendRef, 'this handle shares a senders row with another one').toBe(handle);

    proven.add(value);
  }, 30000);

  it('every ROUND_TRIPS value was proven against the server, not against the fake', () => {
    expect(
      ROUND_TRIP_VALUES.filter((value) => !proven.has(value)).map((v) => v.slice(0, 40)),
      'this corpus value is only ever graded by a mock, which cannot decide storage',
    ).toEqual([]);
  });
});
