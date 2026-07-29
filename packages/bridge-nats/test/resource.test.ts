import { asCursor, asTopic } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { NatsPlugin } from '../src/index.js';
import { fakeJetStream, injectFake, payload } from './fake-jetstream.js';

// Class: every server-side resource this plugin creates is destroyed on EVERY exit path — a throw
// between creating an ephemeral consumer and deleting it leaks one per call, and a flapping link
// with per-topic polling accumulates them. Fake-backed, so it runs with no server; the live half of
// this class lives in resource-live.test.ts, in its own FILE so that a server that failed to come
// up trips CI's whole-file skip gate instead of silently deleting its own coverage.
const STREAM = 'PARLEY_leak';
const TOPIC = asTopic('leak');

const readPaths = [
  {
    name: 'fetchRecent',
    records: [{ seq: 1, data: payload('a') }],
    run: (p: NatsPlugin) => p.fetchRecent({ topic: TOPIC }),
    propagates: true,
  },
  {
    name: 'blockMs long-poll',
    records: [],
    run: (p: NatsPlugin) => p.fetchRecent({ topic: TOPIC, since: asCursor('0'), blockMs: 1000 }),
    propagates: false,
  },
];
const faults: ('get' | 'fetch' | 'iterate' | null)[] = [null, 'get', 'fetch', 'iterate'];

describe('nats resource hygiene — no ephemeral consumer survives its call', () => {
  for (const path of readPaths) {
    for (const failOn of faults) {
      it(`${path.name} destroys its consumer when the read ${failOn === null ? 'succeeds' : `throws in ${failOn}`}`, async () => {
        const fake = fakeJetStream({ records: path.records, failOn });
        const plugin = new NatsPlugin();
        injectFake(plugin, fake, STREAM);

        const outcome = await path.run(plugin).then(
          () => 'resolved',
          () => 'rejected',
        );
        if (failOn !== null && path.propagates) expect(outcome).toBe('rejected');

        expect(fake.state.created.length).toBeGreaterThanOrEqual(1);
        expect(fake.state.deleted).toEqual(fake.state.created);
      });
    }
  }
});
