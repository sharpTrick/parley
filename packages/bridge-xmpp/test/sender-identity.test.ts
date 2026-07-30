import { asHandle, asTopic, type Handle } from '@sharptrick/parley-core';
import { describe, expect, it, vi } from 'vitest';

// Class: a `senderHandle` that is a per-CONNECTION token rather than the bridge's logical identity.
// DESIGN §5 defines senderHandle as the logical sender, and core keys the parley_list_users roster
// (computeRoster, engine/presence.ts) on exactly that field — the presence record body carries no
// handle of its own. A backend whose sender is regenerated per process therefore reports a handle
// nobody can hand work off to, AND accumulates one phantom roster entry per restart for the whole
// since_ms window. The table crosses every way this bridge comes back (a fresh process on the same
// config, a stream reconnect) with every way its occupant identity can be configured, and demands
// of each that the archive attributes both beats to ONE handle, and that the handle is the
// configured identity rather than a token.

// Keep the real client reachable when no fake is installed, so that the live row below (and the
// reachability probe that gates it) still talks to a real server from this same file.
const mockState = vi.hoisted(() => ({ client: undefined as unknown }));
vi.mock('@xmpp/client', async () => {
  const actual = await vi.importActual<typeof import('@xmpp/client')>('@xmpp/client');
  return {
    ...actual,
    client: (opts: Parameters<typeof actual.client>[0]) => mockState.client ?? actual.client(opts),
  };
});

import { XmppPlugin, type XmppBackendConfig } from '../src/index.js';
import { FakeXmpp } from './fake-xmpp.js';
import { BASE, canAuth, freshTopic } from './live-xmpp.js';

const TOPIC = asTopic('t-identity');
const IDENTITY: Handle = asHandle('ctx-payments');
const PASSWORD = 'a-real-secret';

type Restart = 'a fresh process on the same config' | 'a stream reconnect';

interface Row {
  restart: Restart;
  config: string;
  cfg: Partial<XmppBackendConfig>;
  expected: string;
}

const configs: Array<{ config: string; cfg: Partial<XmppBackendConfig>; expected: string }> = [
  { config: 'nick unset (taken from identity)', cfg: {}, expected: String(IDENTITY) },
  { config: 'nick pinned', cfg: { nick: 'pinned-session' }, expected: 'pinned-session' },
];
const restarts: Restart[] = ['a fresh process on the same config', 'a stream reconnect'];
const rows: Row[] = restarts.flatMap((restart) => configs.map((c) => ({ restart, ...c })));

const beats = async (row: Row): Promise<string[]> => {
  const fake = new FakeXmpp();
  mockState.client = fake;
  const first = new XmppPlugin();
  await first.connect({ password: PASSWORD, ...row.cfg });
  await first.post(TOPIC, IDENTITY, 'beat-1');

  let reader = first;
  if (row.restart === 'a stream reconnect') {
    fake.emit('online'); // the initial connect, consumed by the first-online guard
    fake.emit('online'); // the reconnect
    await vi.waitFor(() => expect(fake.sent.filter((s) => s.is('presence')).length).toBe(2));
  } else {
    await first.disconnect();
    reader = new XmppPlugin();
    await reader.connect({ password: PASSWORD, ...row.cfg });
  }
  await reader.post(TOPIC, IDENTITY, 'beat-2');

  const read = await reader.fetchRecent({ topic: TOPIC, limit: 10 });
  expect(read.messages.map((m) => m.content)).toEqual(['beat-1', 'beat-2']);
  const handles = read.messages.map((m) => String(m.senderHandle));
  await reader.disconnect();
  return handles;
};

describe('XMPP attributes a bridge to one stable handle across a restart', () => {
  it.each(rows)('$restart, $config', async (row) => {
    const handles = await beats(row);
    // One roster entry, not one per process — and the entry an operator can address.
    expect(new Set(handles).size).toBe(1);
    expect(handles[0]).toBe(row.expected);
  });
});

// Class: a seam argument honoured on the first call and silently discarded on every later one. One
// XMPP connection is one MUC occupant, so `post`'s `identity` can only be taken once — which is
// what `carriesSenderIdentity: false` declares — but a caller that posts under a second handle
// otherwise gets a success, an archived message attributed to the FIRST handle, and nothing
// anywhere saying so. The table drives both configurations of the occupant nick and both a
// differing and a repeated handle, and pins WHICH of them reports.
interface CollapseRow {
  name: string;
  cfg: Partial<XmppBackendConfig>;
  handles: string[];
  reports: boolean;
}

const REPORT = 'is archived — and read back — as';

const collapseRows: CollapseRow[] = [
  {
    name: 'nick unset, a second post under a different handle',
    cfg: {},
    handles: ['alice', 'bob'],
    reports: true,
  },
  {
    name: 'nick unset, every post under the same handle',
    cfg: {},
    handles: ['alice', 'alice', 'alice'],
    reports: false,
  },
  {
    // A pinned nick is the operator SAYING the sender is not the handle, and the README documents
    // it. Reporting here would fire on every post of a configuration that is working as designed.
    name: 'nick pinned, posts under different handles',
    cfg: { nick: 'pinned-session' },
    handles: ['alice', 'bob'],
    reports: false,
  },
];

const postAll = async (
  cfg: Partial<XmppBackendConfig>,
  topic: ReturnType<typeof asTopic>,
  handles: string[],
): Promise<{ errors: string[]; senders: string[]; contents: string[] }> => {
  const errors: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((m) => {
    errors.push(String(m));
  });
  mockState.client = new FakeXmpp();
  const plugin = new XmppPlugin();
  await plugin.connect({ password: PASSWORD, ...cfg });
  try {
    for (const h of handles) await plugin.post(topic, asHandle(h), `from-${h}`);
    const read = await plugin.fetchRecent({ topic, limit: 10 });
    return {
      errors,
      senders: read.messages.map((m) => String(m.senderHandle)),
      contents: read.messages.map((m) => m.content),
    };
  } finally {
    await plugin.disconnect();
    vi.restoreAllMocks();
    mockState.client = undefined;
  }
};

describe('XMPP reports the identity it collapses onto its one occupant nick', () => {
  it.each(collapseRows)('$name', async (row) => {
    const topic = asTopic(`t-collapse-${row.handles.join('-')}-${String(row.cfg.nick)}`);
    const { errors, senders, contents } = await postAll(row.cfg, topic, row.handles);

    const reported = errors.filter((m) => m.includes(REPORT));
    expect(reported).toHaveLength(row.reports ? 1 : 0);
    if (row.reports) for (const h of new Set(row.handles)) expect(reported[0]).toContain(`'${h}'`);
    // Whatever it reports, the seam contract is unchanged: one occupant is one sender.
    expect(contents).toEqual(row.handles.map((h) => `from-${h}`));
    expect(new Set(senders).size).toBe(1);
  });

  it('reports it once however many further handles arrive', async () => {
    const { errors } = await postAll({}, asTopic('t-collapse-many'), [
      'alice',
      'bob',
      'carol',
      'dave',
    ]);
    expect(errors.filter((m) => m.includes(REPORT))).toHaveLength(1);
  });
});

// Class: `resolveIdentity` answering a name the archive never carries. `backendRef` is the only
// thing core can map a handle onto a backend by, and for a backend declaring
// `carriesSenderIdentity: false` the honest answer is the sender its posts actually read back as —
// which the per-handle fold stops being the moment the connection's nick is settled by anything
// other than that handle. The table crosses every provenance the occupant nick has with the handle
// being resolved, and grades `backendRef` against an OBSERVED `senderHandle` rather than a string
// literal, so it survives a change to the fold.

const ADOPTED = 'alice';
const OTHER = 'carol';

interface NickProvenance {
  name: string;
  cfg: Partial<XmppBackendConfig>;
  reach(plugin: XmppPlugin, fake: FakeXmpp): Promise<void>;
}
const provenances: NickProvenance[] = [
  { name: 'unset, nothing posted yet', cfg: {}, reach: async () => undefined },
  { name: 'pinned by backend_config.nick', cfg: { nick: 'session-a' }, reach: async () => undefined },
  {
    name: "adopted from an earlier post's handle",
    cfg: {},
    reach: async (plugin) => {
      await plugin.post(asTopic('t-ref-seed'), asHandle(ADOPTED), 'seed');
    },
  },
  {
    name: 'reverted to the provisional nick after a conflict',
    cfg: {},
    reach: async (plugin, fake) => {
      fake.conflictNicks.add(ADOPTED);
      await plugin.post(asTopic('t-ref-seed'), asHandle(ADOPTED), 'seed');
    },
  },
];

const refCells = provenances.flatMap((provenance) =>
  [ADOPTED, OTHER].map((handle) => ({ provenance, handle })),
);

describe('XMPP resolveIdentity answers the nick a handle is read back under', () => {
  it.each(refCells)('$provenance.name -> $handle', async ({ provenance, handle }) => {
    const fake = new FakeXmpp();
    mockState.client = fake;
    const plugin = new XmppPlugin();
    await plugin.connect({ password: PASSWORD, ...provenance.cfg });
    try {
      await provenance.reach(plugin, fake);

      const { backendRef } = await plugin.resolveIdentity(asHandle(handle));
      const topic = asTopic(`t-ref-${handle}`);
      await plugin.post(topic, asHandle(handle), 'x');
      const { messages } = await plugin.fetchRecent({ topic, limit: 5 });

      expect(messages.map((m) => String(m.senderHandle))).toEqual([backendRef]);
    } finally {
      await plugin.disconnect();
      mockState.client = undefined;
    }
  });
});

const serverUp = await canAuth(BASE);

describe.skipIf(!serverUp)('XMPP sender identity against a real MUC archive', () => {
  it('two runs of the same config archive under one handle, and it is identity.handle', async () => {
    mockState.client = undefined;
    const topic = freshTopic('ident');
    const first = new XmppPlugin();
    await first.connect(BASE);
    await first.post(topic, IDENTITY, 'beat-1');
    await first.disconnect();

    const second = new XmppPlugin();
    await second.connect(BASE);
    try {
      await second.post(topic, IDENTITY, 'beat-2');
      const read = await second.fetchRecent({ topic, limit: 10 });
      expect(read.messages.map((m) => m.content)).toEqual(['beat-1', 'beat-2']);
      const handles = read.messages.map((m) => String(m.senderHandle));
      expect(new Set(handles)).toEqual(new Set([String(IDENTITY)]));
    } finally {
      await second.disconnect();
    }
  }, 30_000);
});
