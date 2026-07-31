import { afterAll, describe, expect, it } from 'vitest';
import { isNatsUp, rand, SERVERS } from './helpers.js';
import { AGREEMENT_ROWS, liveArena } from './jetstream-agreement.js';

// The live half of the fake's fidelity. Each row of `jetstream-agreement.ts` states one JetStream
// semantic as an expected literal; window.test.ts grades the fake against it and this file grades
// the SERVER against the same literal, so a fake that models a semantic the server does not have is
// a red test here rather than a whole table of window rows passing down a path the server never
// selects. Every test here is server-gated, and the file holds nothing else.
const suite = (await isNatsUp()) ? describe : describe.skip;

suite('nats JetStream semantics — the real server answers as the fake models it', () => {
  const arenas: { close: () => Promise<void> }[] = [];

  afterAll(async () => {
    for (const arena of arenas) await arena.close().catch(() => undefined);
  });

  for (const row of AGREEMENT_ROWS) {
    it(row.name, async () => {
      const arena = await liveArena(SERVERS, rand().toUpperCase());
      arenas.push(arena);

      expect(await row.run(arena)).toEqual(row.expected);
    }, 60_000);
  }
});
