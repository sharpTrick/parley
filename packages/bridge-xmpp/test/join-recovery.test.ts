import { asHandle, asTopic, type Topic } from '@sharptrick/parley-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Class: a recovery branch the README advertises as a safety property that no case drives. Two of
// them lived here — the bounded retry for the MUC cold-creation race, and the fallback for a nick
// another occupant already holds — and deleting either left the whole package suite green. The nick
// fallback was worse than uncovered: it only ran when a room was ALREADY joined, so the same
// misconfiguration failed every post forever on the post-first path and recovered loudly on the
// subscribe-first path. The table crosses each first-failure condition with each call order and
// pins one outcome per condition, so an order-dependent asymmetry fails a row rather than hiding in
// the branch the suite never drives.

const mockState = vi.hoisted(() => ({ client: undefined as unknown }));
vi.mock('@xmpp/client', async () => {
  const actual = await vi.importActual<typeof import('@xmpp/client')>('@xmpp/client');
  return { ...actual, client: () => mockState.client };
});

import { XmppPlugin } from '../src/index.js';
import { FakeXmpp, priv } from './fake-xmpp.js';

const HANDLE = 'ctx-payments';

type Order = 'post first' | 'subscribe then post' | 'fetch then post';

/** What the plugin must do about a first join answered with this condition. */
type Recovery = 'retries and joins' | 'reverts the nick and joins' | 'surfaces the condition';

interface Row {
  fault: string;
  /** The condition the surfaced error must name. */
  condition: string;
  apply(fake: FakeXmpp, provisional: string): void;
  recovery: Recovery;
  /**
   * When the nick fallback runs. `post-first-only` is the honest answer for a fault that both nicks
   * hit: with a subscribe/fetch first the conflict lands before any nick was adopted, so there is
   * nothing to fall back FROM — and that difference is a fact about the fault, not an asymmetry in
   * the outcome, which stays 'surfaces the condition' for every order.
   */
  revert: 'always' | 'never' | 'post-first-only';
}

const rows: Row[] = [
  {
    fault: 'item-not-found for the first 3 joins (the cold-creation race)',
    condition: 'item-not-found',
    apply: (fake) => {
      fake.joinErrorCondition = 'item-not-found';
      fake.joinErrorsRemaining = 3;
    },
    recovery: 'retries and joins',
    revert: 'never',
  },
  {
    fault: 'recipient-unavailable for the first 3 joins',
    condition: 'recipient-unavailable',
    apply: (fake) => {
      fake.joinErrorCondition = 'recipient-unavailable';
      fake.joinErrorsRemaining = 3;
    },
    recovery: 'retries and joins',
    revert: 'never',
  },
  {
    fault: 'remote-server-not-found for the first 3 joins',
    condition: 'remote-server-not-found',
    apply: (fake) => {
      fake.joinErrorCondition = 'remote-server-not-found';
      fake.joinErrorsRemaining = 3;
    },
    recovery: 'retries and joins',
    revert: 'never',
  },
  {
    fault: 'the adopted identity nick is held by another occupant',
    condition: 'conflict',
    apply: (fake) => fake.conflictNicks.add(HANDLE),
    recovery: 'reverts the nick and joins',
    revert: 'always',
  },
  {
    fault: 'BOTH the adopted nick and the provisional fallback are held',
    condition: 'conflict',
    apply: (fake, provisional) => {
      fake.conflictNicks.add(HANDLE);
      fake.conflictNicks.add(provisional);
    },
    recovery: 'surfaces the condition',
    revert: 'post-first-only',
  },
  {
    fault: 'forbidden (this account may not enter the room at all)',
    condition: 'forbidden',
    apply: (fake) => {
      fake.joinReply = 'error';
      fake.joinErrorCondition = 'forbidden';
    },
    recovery: 'surfaces the condition',
    revert: 'never',
  },
  {
    fault: 'item-not-found forever (a room that never commits)',
    condition: 'item-not-found',
    apply: (fake) => {
      fake.joinErrorCondition = 'item-not-found';
      fake.joinErrorsRemaining = 999;
    },
    recovery: 'surfaces the condition',
    revert: 'never',
  },
];

const orders: Order[] = ['post first', 'subscribe then post', 'fetch then post'];
const cells = rows.flatMap((row) => orders.map((order) => ({ row, order })));

const drive = async (plugin: XmppPlugin, topic: Topic, order: Order): Promise<unknown> => {
  if (order === 'subscribe then post') await plugin.subscribe(topic, () => undefined);
  if (order === 'fetch then post') await plugin.fetchRecent({ topic, limit: 5 });
  return plugin.post(topic, asHandle(HANDLE), 'payload');
};

describe('XMPP recovers from a first join failure, the same way whatever the call order', () => {
  afterEach(() => {
    mockState.client = undefined;
    vi.restoreAllMocks();
  });

  it.each(cells)('$row.fault, $order -> $row.recovery', async ({ row, order }) => {
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((m) => {
      logged.push(String(m));
    });
    const fake = new FakeXmpp();
    mockState.client = fake;
    const plugin = new XmppPlugin();
    await plugin.connect({ password: 'a-real-secret' }); // nick unset: HANDLE is adopted, and can clash
    const provisional = priv(plugin).nick;
    row.apply(fake, provisional);
    const topic = asTopic(`t-${row.condition}-${rows.indexOf(row)}-${order.replace(/\W+/g, '-')}`);

    const outcome = await drive(plugin, topic, order).then(
      (id) => String(id),
      (e: Error) => e.message,
    );

    if (row.recovery === 'surfaces the condition') {
      expect(outcome).toContain(row.condition);
      expect(outcome).not.toMatch(/timeout/);
    } else {
      expect(outcome).toMatch(/^arch-/); // the post landed, whatever the first join answered
    }
    const reverted =
      row.revert === 'always' || (row.revert === 'post-first-only' && order === 'post first');
    if (reverted) {
      expect(priv(plugin).nick).toBe(provisional);
      expect(logged.join('\n')).toContain(`could not take '${HANDLE}'`);
    } else {
      expect(logged.some((m) => m.includes('could not take'))).toBe(false);
    }
    await plugin.disconnect();
  }, 25_000);
});

// The retry ladder is bounded, and the bound is what makes a permanently broken room fail rather
// than retry forever. Pinned as a count of join presences so deleting the ladder (or unbounding it)
// both fail: with JOIN_RETRIES=8 a room that never commits sees exactly 9 join presences.
describe('XMPP bounds the cold-creation retry', () => {
  afterEach(() => {
    mockState.client = undefined;
  });

  it('retries a never-committing room a bounded number of times, then surfaces it', async () => {
    const fake = new FakeXmpp();
    fake.joinErrorCondition = 'item-not-found';
    fake.joinErrorsRemaining = 999;
    mockState.client = fake;
    const plugin = new XmppPlugin();
    await plugin.connect({ password: 'a-real-secret', nick: 'cold' });
    const topic = asTopic('t-cold');
    const room = priv(plugin).roomJid(topic);

    await expect(plugin.post(topic, asHandle('a'), 'x')).rejects.toThrow(/item-not-found/);
    const joins = fake.sent.filter(
      (s) => s.is('presence') && (s.attrs.to ?? '').startsWith(`${room}/`),
    ).length;
    expect(joins).toBe(9); // one attempt plus JOIN_RETRIES
    await plugin.disconnect();
  }, 25_000);
});
