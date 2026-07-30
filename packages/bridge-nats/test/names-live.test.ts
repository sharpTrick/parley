import { asHandle, asTopic } from '@sharptrick/parley-core';
import { afterAll, describe, expect, it } from 'vitest';
import { NatsPlugin } from '../src/index.js';
import { dropStreams, isNatsUp, rand, SERVERS, storedMessages } from './helpers.js';

// Class: what the fold composes has to be a name the SERVER accepts, and only a server can say so —
// a fake grades the plugin against the plugin's own idea of a legal name. Two properties per row,
// deliberately orthogonal: every post resolves and is readable back exactly once (the fold produced
// a usable name), and the count the server holds equals the count of posts that RESOLVED (a post
// that reports failure has stored nothing — otherwise every retry duplicates the message under a
// fresh id, which core's dedup on backendMsgId cannot collapse).
// Every test here is server-gated, and the file holds nothing else.

const suite = (await isNatsUp()) ? describe : describe.skip;

const hex = (ch: string): string =>
  `U+${ch.codePointAt(0)!.toString(16).padStart(4, '0').toUpperCase()}`;

// One per family NATS bars, plus both ends of the control range and the two characters only a
// stream name bars.
const CHARS = [
  '.', '*', '>', '/', '\\', ' ', '\t', '\n',
  ...[0x00, 0x01, 0x07, 0x1f, 0x7f, 0xa0, 0x2028, 0xfeff].map((c) => String.fromCodePoint(c)),
];
const POSTS = 3;

suite('nats topic fold — an illegal character survives a round trip through a live server', () => {
  const tag = rand();

  afterAll(async () => {
    await dropStreams(`PN_${tag}_`);
  });

  CHARS.forEach((ch, row) => {
    it(`a topic carrying ${hex(ch)} stores exactly the posts that resolved, and reads them back`, async () => {
      const streamPrefix = `PN_${tag}_${row}_`;
      const plugin = new NatsPlugin();
      await plugin.connect({
        servers: SERVERS,
        subject_prefix: `pn.${tag}.r${row}.`,
        stream_prefix: streamPrefix,
      });
      try {
        const topic = asTopic(`chat${ch}room`);
        const posted: string[] = [];
        const refused: string[] = [];
        for (let i = 0; i < POSTS; i++) {
          await plugin.post(topic, asHandle('sys'), `m${i}`).then(
            () => posted.push(`m${i}`),
            (err: unknown) => refused.push(`m${i}: ${String(err)}`),
          );
        }

        expect({ char: hex(ch), refused }).toEqual({ char: hex(ch), refused: [] });
        expect(await storedMessages(streamPrefix)).toBe(posted.length);
        const page = await plugin.fetchRecent({ topic });
        expect(page.messages.map((m) => m.content)).toEqual(posted);
      } finally {
        await plugin.disconnect();
      }
    }, 60_000);
  });
});
