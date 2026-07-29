import { asHandle, asTopic, type Message, type Topic } from '@sharptrick/parley-core';
import { Client } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { PostgresPlugin } from '../src/index.js';
import { buildSchema, channelFor } from '../src/schema.js';
import { dropTable, isUp, PG_URL, rand, sleep, withAdmin } from './pg-harness.js';

// The NOTIFY channel is derived TWICE — once in Node by channelFor(), once inside the trigger by
// PostgreSQL — and the live path is silently dead whenever the two disagree. Nothing errors: the
// trigger rings a channel nobody LISTENs, push delivers nothing, and blocking fetches stall their
// whole budget while catch-up keeps working, so the deployment looks healthy. These cases pin the
// two derivations together over topic shapes the `t-<n>-<rand>` ASCII generator never produces.

interface TopicShape {
  label: string;
  topic: string;
  /** Representable in LATIN1 — i.e. usable as a topic on a LATIN1-encoded database. */
  latin1: boolean;
}

const TOPIC_SHAPES: TopicShape[] = [
  { label: 'ascii', topic: 'plain-topic', latin1: true },
  { label: 'latin1 accents', topic: 'café', latin1: true },
  { label: 'cjk', topic: '日本語', latin1: false },
  { label: 'emoji', topic: 'room-🚀-ops', latin1: false },
  { label: 'NFC precomposed', topic: 'école'.normalize('NFC'), latin1: true },
  { label: 'NFD decomposed', topic: 'école'.normalize('NFD'), latin1: false },
  { label: 'surrounding spaces', topic: ' padded topic ', latin1: true },
  { label: '500 chars', topic: 'x'.repeat(500), latin1: true },
];

/** Create a throwaway database with `encoding`, returning its DSN, or undefined if not permitted. */
async function makeDatabase(encoding: string): Promise<{ url: string; drop: () => Promise<void> } | undefined> {
  const name = `parley_enc_${encoding.toLowerCase()}_${rand()}`;
  const adminUrl = new URL(PG_URL);
  adminUrl.pathname = '/postgres';
  try {
    await withAdmin(async (admin) => {
      await admin.query(
        `CREATE DATABASE ${name} ENCODING '${encoding}' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`,
      );
    }, adminUrl.toString());
  } catch {
    return undefined;
  }
  const url = new URL(PG_URL);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    drop: async () => {
      await withAdmin(async (a) => {
        await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      }, adminUrl.toString());
    },
  };
}

/** subscribe() + post() on a fresh table: the whole live path, channel derivation included. */
async function pushRoundTrip(url: string, topic: Topic): Promise<Message[]> {
  const table = `parley_enc_${rand()}`;
  const plugin = new PostgresPlugin();
  await plugin.connect({ url, table_name: table });
  const seen: Message[] = [];
  try {
    await plugin.subscribe(topic, (m) => {
      seen.push(m);
    });
    await plugin.post(topic, asHandle('u'), 'pushed');
    for (let i = 0; i < 40 && seen.length === 0; i++) await sleep(25);
    return seen;
  } finally {
    await plugin.disconnect();
    await dropTable(table, url);
  }
}

describe('NOTIFY channel derivation is encoding-explicit on both sides', () => {
  // Runs everywhere, including CI without CREATEDB: a digest taken over the server's own text
  // representation matches Node's only by the accident of the database being UTF8, so the DDL must
  // never hash the bare column.
  it('the trigger hashes explicit UTF-8 bytes, not the value in the database encoding', () => {
    const ddl = buildSchema('parley_messages');
    expect(ddl).toMatch(/md5\(\s*convert_to\(\s*NEW\.topic\s*,\s*'UTF8'\s*\)\s*\)/);
    expect(ddl).not.toMatch(/md5\(\s*NEW\.topic\s*\)/);
  });
});

if (await isUp(PG_URL)) {
  describe('live push over topic shapes (UTF8 database)', () => {
    it.each(TOPIC_SHAPES.map((s) => [s.label, s.topic] as const))(
      'the trigger rings the channel the client LISTENs: %s',
      async (_label, topic) => {
        const seen = await pushRoundTrip(PG_URL, asTopic(topic));
        expect(seen.map((m) => m.content)).toEqual(['pushed']);
      },
      15000,
    );

    it.each(TOPIC_SHAPES.map((s) => [s.label, s.topic] as const))(
      "the server's own digest of the topic equals channelFor(): %s",
      async (_label, topic) => {
        const c = new Client({ connectionString: PG_URL });
        c.on('error', () => undefined);
        await c.connect();
        try {
          const res = await c.query("SELECT 'parley_' || md5(convert_to($1, 'UTF8')) AS ch", [topic]);
          expect((res.rows[0] as { ch: string }).ch).toBe(channelFor(topic));
        } finally {
          await c.end();
        }
      },
    );
  });

  // A non-UTF8 server_encoding is the case that separates "hashes bytes" from "hashes whatever the
  // database happens to store"; skipped rather than failed where CREATEDB is not granted.
  const latin1 = await makeDatabase('LATIN1');
  const describeLatin1 = latin1 === undefined ? describe.skip : describe;
  describeLatin1('live push over topic shapes (LATIN1 database)', () => {
    afterAll(async () => {
      await latin1?.drop();
    }, 15000);

    it.each(TOPIC_SHAPES.filter((s) => s.latin1).map((s) => [s.label, s.topic] as const))(
      'the trigger rings the channel the client LISTENs: %s',
      async (_label, topic) => {
        const seen = await pushRoundTrip(latin1!.url, asTopic(topic));
        expect(seen.map((m) => m.content)).toEqual(['pushed']);
      },
      15000,
    );
  });
} else {
  describe.skip(`NOTIFY channel: live cases (no server at ${PG_URL})`, () => {
    it('skipped — start postgres (examples/dev-compose) to run', () => undefined);
  });
}
