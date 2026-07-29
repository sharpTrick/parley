import { asCursor, asHandle, asTopic } from '@sharptrick/parley-core';
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

const call: Record<Entry, (p: XmppPlugin) => Promise<unknown>> = {
  post: (p) => p.post(TOPIC, asHandle('a'), 'hello'),
  fetchRecent: (p) => p.fetchRecent({ topic: TOPIC, since: asCursor(''), limit: 5 }),
  subscribe: (p) => p.subscribe(TOPIC, () => undefined),
};

interface Row {
  fault: string;
  apply(fake: FakeXmpp): void;
  /** Entry points that must reject naming MAM; the rest must merely not hang. */
  namesMam: Entry[];
}

const rows: Row[] = [
  {
    fault: 'the room does not advertise urn:xmpp:mam:2 (muc_mam is not loaded)',
    apply: (fake) => {
      fake.discoMam = false;
    },
    namesMam: ['post', 'fetchRecent', 'subscribe'],
  },
  {
    fault: 'the MUC reflects posts without a <stanza-id> (nothing is being archived)',
    apply: (fake) => {
      fake.reflectStanzaId = false;
    },
    namesMam: ['post'],
  },
  {
    fault: 'the MAM query is answered service-unavailable',
    apply: (fake) => {
      fake.mamIqError = 'service-unavailable';
    },
    namesMam: ['fetchRecent'],
  },
  {
    fault: 'the MAM query is answered feature-not-implemented',
    apply: (fake) => {
      fake.mamIqError = 'feature-not-implemented';
    },
    namesMam: ['fetchRecent'],
  },
  {
    fault: 'a server with no MUC archiving at all (no feature, no stanza-id, no archive)',
    apply: (fake) => {
      fake.discoMam = false;
      fake.reflectStanzaId = false;
      fake.mamIqError = 'service-unavailable';
    },
    namesMam: ['post', 'fetchRecent', 'subscribe'],
  },
];

const entries: Entry[] = ['post', 'fetchRecent', 'subscribe'];
const cells = rows.flatMap((row) => entries.map((entry) => ({ row, entry })));

describe('XMPP fails fast and names MAM when the archive is missing', () => {
  it.each(cells)('$row.fault -> $entry', async ({ row, entry }) => {
    const fake = new FakeXmpp();
    row.apply(fake);
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
