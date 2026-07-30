import { asCursor, asHandle, asTopic, type Topic } from '@sharptrick/parley-core';
import { describe, expect, it, vi } from 'vitest';

// Class: a hard prerequisite that is never checked, so its absence surfaces as a timeout and a
// silent no-op instead of a message naming it. MAM (mod_mam + muc_mam) is what gives this backend
// its cursor, its dedup key AND its post-reflection correlator, so a server without it makes post
// unresolvable, subscribe permanently and silently dead, and fetchRecent fail with a bare
// `service-unavailable` — an operator sees an idle bridge, not a misconfigured one. The table walks
// each shape the missing module takes on the wire and demands of every seam entry point it can
// reach that it fails FAST and says 'MAM', never a bare timeout and never silence.

const mockState = vi.hoisted(() => ({ client: undefined as unknown }));
vi.mock('@xmpp/client', async () => {
  const actual = await vi.importActual<typeof import('@xmpp/client')>('@xmpp/client');
  return { ...actual, client: () => mockState.client };
});

import { XmppPlugin } from '../src/index.js';
import { FakeXmpp } from './fake-xmpp.js';

const TOPIC = asTopic('t-mam-prereq');
/** Far below JOIN/POST/MAM_TIMEOUT_MS: a bare timeout can never pass for a fast failure. */
const PROMPT_MS = 1_000;

type Entry = 'post' | 'fetchRecent' | 'subscribe';

const call: Record<Entry, (p: XmppPlugin, topic?: Topic) => Promise<unknown>> = {
  post: (p, topic = TOPIC) => p.post(topic, asHandle('a'), 'hello'),
  fetchRecent: (p, topic = TOPIC) => p.fetchRecent({ topic, since: asCursor(''), limit: 5 }),
  subscribe: (p, topic = TOPIC) => p.subscribe(topic, () => undefined),
};

/** The fault as a PATCH, so healing it is a mechanical restore rather than a second hand-written
 * list that can drift away from the one that broke the server. */
type Fault = Partial<Pick<FakeXmpp, 'discoMam' | 'reflectStanzaId' | 'mamIqError'>>;

interface Row {
  fault: string;
  broken: Fault;
  /** Entry points that must reject naming MAM; the rest must merely not hang. */
  namesMam: Entry[];
}

const apply = (fake: FakeXmpp, patch: Fault): void => {
  Object.assign(fake, patch);
};
/** Undo `patch`, restoring each key to the value a healthy server's stand-in carries. */
const heal = (fake: FakeXmpp, patch: Fault): void => {
  const healthy = new FakeXmpp() as unknown as Record<string, unknown>;
  for (const key of Object.keys(patch)) {
    (fake as unknown as Record<string, unknown>)[key] = healthy[key];
  }
};

const rows: Row[] = [
  {
    fault: 'the room does not advertise urn:xmpp:mam:2 (muc_mam is not loaded)',
    broken: { discoMam: false },
    namesMam: ['post', 'fetchRecent', 'subscribe'],
  },
  {
    fault: 'the MUC reflects posts without a <stanza-id> (nothing is being archived)',
    broken: { reflectStanzaId: false },
    namesMam: ['post'],
  },
  {
    fault: 'the MAM query is answered service-unavailable',
    broken: { mamIqError: 'service-unavailable' },
    namesMam: ['fetchRecent'],
  },
  {
    fault: 'the MAM query is answered feature-not-implemented',
    broken: { mamIqError: 'feature-not-implemented' },
    namesMam: ['fetchRecent'],
  },
  {
    fault: 'a server with no MUC archiving at all (no feature, no stanza-id, no archive)',
    broken: { discoMam: false, reflectStanzaId: false, mamIqError: 'service-unavailable' },
    namesMam: ['post', 'fetchRecent', 'subscribe'],
  },
];

const entries: Entry[] = ['post', 'fetchRecent', 'subscribe'];
const cells = rows.flatMap((row) => entries.map((entry) => ({ row, entry })));

describe('XMPP fails fast and names MAM when the archive is missing', () => {
  it.each(cells)('$row.fault -> $entry', async ({ row, entry }) => {
    const fake = new FakeXmpp();
    apply(fake, row.broken);
    mockState.client = fake;
    const plugin = new XmppPlugin();
    await plugin.connect({ password: 'a-real-secret', nick: 'prereq' });

    const started = Date.now();
    const outcome = await call[entry](plugin).then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(PROMPT_MS);
    if (row.namesMam.includes(entry)) {
      expect(outcome).toContain('MAM');
      expect(outcome).not.toMatch(/^post reflection timeout|^MUC join timeout/);
    }
    await plugin.disconnect();
  });
});

// Class: a prerequisite probe memoized with `??=`, where a REJECTED promise is not `undefined` and
// so latches for the whole connection. The operator fixes the server, and every later call on every
// topic still fails with the first probe's error — naming the first room, not the one addressed —
// until the bridge process is restarted. The table drives each fault to its failure, heals the
// server, and demands the next call succeed without a reconnect.

const recoverable = rows.flatMap((row) => row.namesMam.map((entry) => ({ row, entry })));

describe('XMPP recovers when a missing prerequisite is fixed, without a reconnect', () => {
  it.each(recoverable)('$row.fault -> $entry', async ({ row, entry }) => {
    const fake = new FakeXmpp();
    apply(fake, row.broken);
    mockState.client = fake;
    const plugin = new XmppPlugin();
    await plugin.connect({ password: 'a-real-secret', nick: 'prereq' });
    try {
      await expect(call[entry](plugin)).rejects.toThrow();
      const roomsAfterFirst = fake.rooms.size;
      await expect(call[entry](plugin)).rejects.toThrow();
      expect(fake.rooms.size, 'a retry minted another room').toBe(roomsAfterFirst);

      heal(fake, row.broken);
      const healed = await call[entry](plugin).then(
        () => 'ok',
        (e: Error) => e.message,
      );
      expect(healed).toBe('ok');
    } finally {
      await plugin.disconnect();
    }
  });

  it.each(recoverable)('$row.fault -> $entry names the room being addressed', async ({
    row,
    entry,
  }) => {
    const fake = new FakeXmpp();
    apply(fake, row.broken);
    mockState.client = fake;
    const plugin = new XmppPlugin();
    await plugin.connect({ password: 'a-real-secret', nick: 'prereq' });
    try {
      await expect(call[entry](plugin)).rejects.toThrow();

      const other = asTopic('t-mam-second');
      const failure = await call[entry](plugin, other).then(
        () => 'resolved',
        (e: Error) => e.message,
      );
      expect(failure).toContain(String(other));
    } finally {
      await plugin.disconnect();
    }
  });
});
