import { asCursor, asHandle, asTopic, type Topic } from '@sharptrick/parley-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Class: a re-drive of an "ensure" that turns into a caller-visible failure for the operation that
// asked for it. MUC occupancy is re-driven from three places the caller never asked for — a
// reconnect, the first post adopting `identity.handle` as the occupant nick, and the deferred
// re-entry after an occupancy loss — and each registers a second join for a room whose first join
// is still in flight. Rejecting the superseded entry delivers that rejection to the ORIGINAL
// caller: a subscribe/fetchRecent/post fails while the successor join is about to succeed, and
// because startPushLoop rethrows anything that is not NoSuchTopicError, a reconnect landing during
// startup takes the whole bridge process down. Every cell below has a join in flight when the
// re-drive lands and demands the seam call still complete, with the room joined exactly once.

const mockState = vi.hoisted(() => ({ client: undefined as unknown }));
vi.mock('@xmpp/client', async () => {
  const actual = await vi.importActual<typeof import('@xmpp/client')>('@xmpp/client');
  return { ...actual, client: () => mockState.client };
});

import { XmppPlugin } from '../src/index.js';
import { expectNoLeaks, FakeXmpp, priv } from './fake-xmpp.js';

/** One round trip of join latency: long enough that a re-drive lands while the join is open. */
const JOIN_LATENCY_MS = 100;

/** Park until the join presence for `room` is out and unanswered — the window the defect needs. */
const untilJoinInFlight = async (plugin: XmppPlugin, room: string): Promise<void> => {
  for (let i = 0; i < 200 && !priv(plugin).pendingJoins.has(room); i++) {
    await new Promise((r) => setTimeout(r, 1));
  }
  expect(priv(plugin).pendingJoins.has(room)).toBe(true);
};

const joinPresences = (fake: FakeXmpp, room: string): number =>
  fake.sent.filter((s) => s.is('presence') && (s.attrs.to ?? '').startsWith(`${room}/`)).length;

/** The subscribe row's own handler, so its registration is distinguishable from the fixture's. */
const ownHandler = (): void => undefined;

interface Call {
  name: string;
  /** Issued but NOT awaited: the re-drive has to land while its join is still in flight. */
  start(plugin: XmppPlugin, topic: Topic): Promise<unknown>;
  /** What a completed call must be observable as, beyond resolving. */
  check(plugin: XmppPlugin, topic: Topic, value: unknown): void;
}

const calls: Call[] = [
  {
    name: 'subscribe',
    start: (plugin, topic) => plugin.subscribe(topic, ownHandler),
    check: (plugin, topic) => {
      expect(priv(plugin).subscriptions.get(priv(plugin).roomJid(topic))?.handlers).toContain(
        ownHandler,
      );
    },
  },
  {
    name: 'fetchRecent (since-less)',
    start: (plugin, topic) => plugin.fetchRecent({ topic, limit: 5 }),
    check: (_plugin, _topic, value) => {
      expect((value as { nextCursor: unknown }).nextCursor).toBeDefined();
    },
  },
  {
    name: 'fetchRecent (blocking, at the tail)',
    start: (plugin, topic) => plugin.fetchRecent({ topic, since: asCursor(''), blockMs: 60 }),
    check: (_plugin, _topic, value) => {
      expect((value as { nextCursor: unknown }).nextCursor).toBeDefined();
    },
  },
  {
    name: 'post',
    start: (plugin, topic) => plugin.post(topic, asHandle('caller'), 'payload'),
    check: (_plugin, _topic, value) => {
      expect(String(value)).toMatch(/^arch-/); // the archive id, not a timeout
    },
  },
];

interface Trigger {
  name: string;
  fire(plugin: XmppPlugin, fake: FakeXmpp, topic: Topic): void;
  /**
   * Join presences the room must have seen once the call settles. Pinned per trigger rather than
   * bounded, so that a re-drive that stops happening and a re-drive that happens twice both fail.
   */
  joins: number;
}

const triggers: Trigger[] = [
  {
    name: 'a reconnect',
    fire: (_plugin, fake) => {
      fake.emit('online'); // the initial connect, consumed by the first-online guard
      fake.emit('online'); // the reconnect: occupancy is gone, every room is re-driven
    },
    joins: 2,
  },
  {
    name: 'an occupancy-loss presence',
    fire: (plugin, fake, topic) => {
      const room = priv(plugin).roomJid(topic);
      priv(plugin).subscriptions.set(room, { topic, handlers: [() => undefined] });
      fake.endOccupancy(room, { statuses: ['307'] });
    },
    // A loss announced while the join is still open is the join's own business: the deferred
    // re-entry must NOT also fire, or the room collects a second occupant presence per loss.
    joins: 1,
  },
];

const cells = calls.flatMap((call) => triggers.map((trigger) => ({ call, trigger })));

describe('XMPP a join re-driven under an in-flight one never fails the original caller', () => {
  afterEach(() => {
    mockState.client = undefined;
  });

  it.each(cells)('$call.name survives $trigger.name mid-join', async ({ call, trigger }) => {
    const fake = new FakeXmpp();
    fake.joinLatencyMs = JOIN_LATENCY_MS;
    mockState.client = fake;
    const plugin = new XmppPlugin();
    await plugin.connect({ password: 'a-real-secret', nick: 'supersede' });
    const label = `${call.name}-${trigger.name}`.replace(/\W+/g, '-');
    const topic = asTopic(`t-${label}`);
    const room = priv(plugin).roomJid(topic);

    const pending = call.start(plugin, topic);
    await untilJoinInFlight(plugin, room);
    trigger.fire(plugin, fake, topic);

    const value = await pending; // the assertion: it settles, and it settles by succeeding
    call.check(plugin, topic, value);
    await vi.waitFor(() => expect(priv(plugin).joined.size).toBe(1));
    await expect(priv(plugin).joined.get(room)).resolves.toBeUndefined();
    expect(priv(plugin).pendingJoins.size).toBe(0);
    expect(joinPresences(fake, room)).toBe(trigger.joins);

    await plugin.disconnect();
    expectNoLeaks(plugin);
  }, 30_000);
});

// The third re-drive: the first `post` taking `identity.handle` as the occupant nick clears the
// join cache for every room, including one whose join has not answered yet. It cannot be a row
// above because a post is what triggers it, so the in-flight call is always a different one — and
// it is the only re-drive that changes the NICK, so it is also the only one where the server's
// answer to the superseded join names a name the successor never asked for. The `answers` axis
// therefore carries both halves: the superseded join answered successfully, and answered with each
// refusal a MUC can send. Attributing the refusal to the successor rejects a caller that is about
// to be in the room (startPushLoop rethrows it, taking the process down during startup) and, for
// `conflict`, drags the connection back to its random provisional nick while telling the operator a
// handle nobody holds was taken.
const REFUSALS = ['forbidden', 'conflict', 'registration-required', 'item-not-found'];

interface Answer {
  name: string;
  /** Armed once the superseded join's presence is out and before the nick switch re-drives it. */
  arm(fake: FakeXmpp): void;
}
const answers: Answer[] = [
  { name: 'successfully', arm: () => undefined },
  ...REFUSALS.map((condition) => ({
    name: `with ${condition}`,
    arm: (fake: FakeXmpp): void => {
      fake.joinErrorCondition = condition;
      fake.joinErrorsRemaining = 1; // only the FIRST (superseded) join is refused
    },
  })),
];

const adoptCells = (['subscribe', 'fetchRecent'] as const).flatMap((which) =>
  answers.map((answer) => ({ which, answer })),
);

describe('XMPP a join re-driven by the first post adopting its identity nick', () => {
  afterEach(() => {
    mockState.client = undefined;
  });

  it.each(adoptCells)(
    'an in-flight $which completes when the superseded join is answered $answer.name',
    async ({ which, answer }) => {
      const fake = new FakeXmpp();
      fake.joinLatencyMs = JOIN_LATENCY_MS;
      mockState.client = fake;
      const plugin = new XmppPlugin();
      await plugin.connect({ password: 'a-real-secret' }); // nick unset: the first post adopts one
      const topic = asTopic(`t-adopt-${which}-${answer.name}`.replace(/\W+/g, '-'));
      const room = priv(plugin).roomJid(topic);
      const provisional = priv(plugin).nick;

      const pending =
        which === 'subscribe'
          ? plugin.subscribe(topic, () => undefined)
          : plugin.fetchRecent({ topic, limit: 5 });
      await untilJoinInFlight(plugin, room);
      answer.arm(fake);
      const posted = plugin.post(topic, asHandle('ctx-payments'), 'one');

      await expect(pending).resolves.not.toBeInstanceOf(Error);
      expect(String(await posted)).toMatch(/^arch-/);
      // The nick really did change, so the row is not passing because nothing was re-driven — and
      // an answer meant for the nick it left cannot drag it back to the provisional one.
      expect(priv(plugin).nick).toBe('ctx-payments');
      expect(priv(plugin).nick).not.toBe(provisional);
      expect(priv(plugin).joined.size).toBe(1);
      await plugin.disconnect();
      expectNoLeaks(plugin);
    },
    30_000,
  );
});
