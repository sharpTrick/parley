import { asCursor, asHandle, asTopic, type Topic } from '@sharptrick/parley-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Class: a READ that provisions durable backend state, and an existence probe that FAILS OPEN into
// doing it. Joining a MUC room auto-creates it and the creator then submits a config making it
// PERSISTENT — deliberately, because a non-persistent room and its whole MAM archive die with the
// last occupant. But `fetchRecent` also joined, and its topic comes from the caller through nothing
// but an allowlist pattern, so `parley_fetch_recent` on a wildcard pattern minted an unbounded
// number of persistent rooms and archives that nothing in this plugin ever reclaims — while
// returning an empty page, so the caller had no signal it had just provisioned anything. Gating that
// on a disco#info probe is only half the guard: the probe can fail to ANSWER — a busy MUC, an s2s
// hiccup, an IQ nothing replies to — and treating "not item-not-found" as "the room is there" put
// every one of those straight back on the creating path. So the third axis is how the probe answers,
// and every read cell must leave the server untouched whatever it says: a question this connection
// could not get an answer to is not permission to provision. The observables are the creation
// handshake (status 201) and the owner config submit.

const mockState = vi.hoisted(() => ({ client: undefined as unknown }));
vi.mock('@xmpp/client', async () => {
  const actual = await vi.importActual<typeof import('@xmpp/client')>('@xmpp/client');
  return { ...actual, client: () => mockState.client };
});

import { XmppPlugin } from '../src/index.js';
import { FakeXmpp, priv } from './fake-xmpp.js';

const NS_MUC_OWNER = 'http://jabber.org/protocol/muc#owner';

interface Call {
  name: string;
  /** Whether this call is allowed to bring a room into existence. */
  mayCreate: boolean;
  run(plugin: XmppPlugin, topic: Topic): Promise<unknown>;
}

const calls: Call[] = [
  {
    name: 'post',
    mayCreate: true,
    run: (plugin, topic) => plugin.post(topic, asHandle('writer'), 'payload'),
  },
  {
    // Its topics come from the allowlist's own list, not from a caller-supplied name, and live
    // delivery is impossible without occupancy — so this one keeps its creation.
    name: 'subscribe',
    mayCreate: true,
    run: (plugin, topic) => plugin.subscribe(topic, () => undefined),
  },
  {
    name: 'fetchRecent',
    mayCreate: false,
    run: (plugin, topic) => plugin.fetchRecent({ topic, limit: 10 }),
  },
  {
    name: 'fetchRecent with a cursor',
    mayCreate: false,
    run: (plugin, topic) => plugin.fetchRecent({ topic, since: asCursor(''), limit: 10 }),
  },
  {
    name: 'fetchRecent long-polling',
    mayCreate: false,
    run: (plugin, topic) => plugin.fetchRecent({ topic, since: asCursor(''), blockMs: 400 }),
  },
];

const existences = [
  { name: 'the room already exists', exists: true },
  { name: 'the room does not exist', exists: false },
];

/**
 * How the disco#info existence probe answers. `answers` is the server telling the truth; the rest
 * are the ways it declines to, and none of them is evidence the room is there. A read may only join
 * a room a probe positively CONFIRMED, so `joinable` is true for exactly one of them.
 */
const probes = [
  { name: 'the probe answers', probe: 'answers' as const, joinable: true },
  { name: 'the probe answers service-unavailable', probe: 'service-unavailable' as const, joinable: false },
  { name: 'the probe answers remote-server-timeout', probe: 'remote-server-timeout' as const, joinable: false },
  { name: 'the probe answers forbidden', probe: 'forbidden' as const, joinable: false },
  { name: 'the probe never answers', probe: 'no-answer' as const, joinable: false },
];

const cells = calls.flatMap((call) =>
  existences.flatMap((existence) => probes.map((probe) => ({ call, existence, probe }))),
);

describe('XMPP creates a MUC room from the write and push paths only', () => {
  afterEach(() => {
    mockState.client = undefined;
  });

  it.each(cells)('$call.name when $existence.name and $probe.name', async ({ call, existence, probe }) => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fake = new FakeXmpp();
    fake.announceCreation = true; // only the creator's self-presence carries status 201
    fake.discoUnknownRoom = 'item-not-found'; // what a server answers about a room nobody created
    fake.discoProbe = probe.probe;
    mockState.client = fake;
    const plugin = new XmppPlugin();
    await plugin.connect({ password: 'a-real-secret', nick: 'reader' });
    const label = `${call.name}-${probe.probe}`.replace(/\W+/g, '-');
    const topic = asTopic(`t-create-${label}-${String(existence.exists)}`);
    const room = priv(plugin).roomJid(topic);
    if (existence.exists) fake.rooms.add(room);

    const started = Date.now();
    await call.run(plugin, topic);
    const elapsed = Date.now() - started;

    const joins = fake.sent.filter(
      (s) => s.is('presence') && (s.attrs.to ?? '').startsWith(`${room}/`),
    ).length;
    const configSubmits = fake.sentIqs.filter(
      (iq) => iq.getChild('query', NS_MUC_OWNER) !== undefined,
    ).length;

    // The write and push paths do not consult the probe at all — their topics are not
    // caller-supplied — so only a READ's outcome moves with it.
    const reads = !call.mayCreate;
    if (reads && !probe.joinable) {
      // A probe that did not answer the question is not permission to act on it: nothing entered
      // the room, whether or not it was there, and the operator is told why the page came back empty.
      expect({ joins, configSubmits, created: fake.rooms.has(room) && !existence.exists }).toEqual({
        joins: 0,
        configSubmits: 0,
        created: false,
      });
      expect(priv(plugin).joined.size).toBe(0);
      expect(String(errors.mock.calls.at(-1)?.[0])).toContain(room);
      expect(elapsed).toBeLessThan(250);
    } else if (existence.exists) {
      // Every call joins a room that is already there, and none of them reconfigures it.
      expect(joins).toBe(1);
      expect(configSubmits).toBe(0);
    } else if (call.mayCreate) {
      expect(joins).toBe(1);
      expect(configSubmits).toBe(1); // the persistent-room submit that unlocks what it created
      expect(fake.rooms.has(room)).toBe(true);
    } else {
      // The read leaves the server exactly as it found it: no occupant presence, no room, no config.
      expect(joins).toBe(0);
      expect(configSubmits).toBe(0);
      expect(fake.rooms.has(room)).toBe(false);
      expect(priv(plugin).joined.size).toBe(0);
      // And it does not park on a topic that cannot receive anything yet.
      expect(elapsed).toBeLessThan(250);
    }
    await plugin.disconnect();
    vi.restoreAllMocks();
  }, 15_000);
});

describe('XMPP reads an absent topic as an empty, replayable page', () => {
  afterEach(() => {
    mockState.client = undefined;
  });

  it('returns the caller cursor unchanged, and starts serving once a post creates the room', async () => {
    const fake = new FakeXmpp();
    fake.announceCreation = true;
    fake.discoUnknownRoom = 'item-not-found';
    mockState.client = fake;
    const plugin = new XmppPlugin();
    await plugin.connect({ password: 'a-real-secret', nick: 'reader' });
    const topic = asTopic('t-absent-then-present');

    const first = await plugin.fetchRecent({ topic, limit: 10 });
    expect(first.messages).toEqual([]);
    const again = await plugin.fetchRecent({ topic, since: first.nextCursor, limit: 10 });
    expect(again.messages).toEqual([]);
    expect(String(again.nextCursor)).toBe(String(first.nextCursor));

    // The write path creates it, and the read that refused to create now reads it.
    await plugin.post(topic, asHandle('writer'), 'first message');
    const read = await plugin.fetchRecent({ topic, since: first.nextCursor, limit: 10 });
    expect(read.messages.map((m) => m.content)).toEqual(['first message']);
    await plugin.disconnect();
  }, 15_000);
});
