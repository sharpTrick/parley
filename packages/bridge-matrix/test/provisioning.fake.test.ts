import { asCursor, asHandle, asTopic, type Topic } from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MatrixPlugin, ROOM_PRESETS } from '../src/index.js';
import { connectFake, FakeSynapse } from './fake-synapse.js';
import {
  A,
  aliasForTopic,
  HOMESERVER,
  isMatrixUp,
  retireRoom,
  roomIdOf,
  SERVER_NAME,
} from './live-gate.js';

/**
 * Two CLASSES over the same table.
 *
 *  1. Rooms this plugin PROVISIONS must not be world-readable / world-writable by default. The
 *     alias is deterministic and therefore guessable, and Synapse federates, so the join rule is
 *     the only thing standing between a stranger's account and both the topic's history and a live
 *     agent session's `<channel>` events. Opting back in must stay deliberate and visible in config.
 *  2. A READ never provisions. `fetchRecent`'s topic comes from the model, whose context is fed by
 *     untrusted inbound messages, and core's allowlist admits pattern matches — so a read that
 *     creates a room lets inbound data spend the homeserver's per-user room-creation budget
 *     (Synapse: ~2-room burst, then ~1 room / 45s), after which the `post` that genuinely needs a
 *     room is refused. `subscribe`'s topics come from the operator's route config, not the model,
 *     and a route with no room has nothing to sync — it provisions.
 */

const WRITER = asHandle('writer');

let fake: FakeSynapse;
beforeEach(() => {
  fake = new FakeSynapse();
  fake.aliasExists = false; // force the create path
  vi.stubGlobal('fetch', fake.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ENTRY_POINTS: Record<
  string,
  { provisions: boolean; drive: (p: MatrixPlugin, t: Topic) => Promise<unknown> }
> = {
  'first post': { provisions: true, drive: (p, t) => p.post(t, WRITER, 'hello') },
  'first fetchRecent': {
    provisions: false,
    drive: (p, t) => p.fetchRecent({ topic: t, limit: 5 }),
  },
  'first subscribe': { provisions: true, drive: (p, t) => p.subscribe(t, () => undefined) },
};

/**
 * The createRoom body asserted WHOLE, so a silently added, removed or flipped field fails. Spot
 * checks on `preset` and `invite` left `visibility` — the field that keeps every topic name out of
 * the homeserver's federated public room directory — asserted only in prose.
 */
const createRoomBodyFor = (preset: string, invite: string[], localpart: string) => ({
  room_alias_name: localpart,
  preset,
  visibility: 'private',
  ...(invite.length > 0 ? { invite } : {}),
});

describe('only a write provisions, and never into a world-joinable room', () => {
  for (const shared of [true, false]) {
    for (const [entryName, entry] of Object.entries(ENTRY_POINTS)) {
      for (const aliasExists of [true, false]) {
        it(`${shared ? 'shared_room' : 'per-topic'} / ${entryName} / alias exists: ${aliasExists}`, async () => {
          fake.aliasExists = aliasExists;
          const invite = ['@ally:parley.local'];
          const p = await connectFake({ shared, invite });
          await entry.drive(p, asTopic('ctx-payments'));

          const expected = !aliasExists && entry.provisions ? 1 : 0;
          expect(fake.createRoomBodies).toHaveLength(expected);
          for (const body of fake.createRoomBodies) {
            expect(body).toEqual(
              createRoomBodyFor(
                'private_chat',
                invite,
                shared ? 'parley_conformance' : 'parley_ctx-payments',
              ),
            );
          }
          await p.disconnect();
        });
      }
    }
  }

  /**
   * CLASS: every value the `room_preset` union accepts is graded, and the whole body it produces is
   * pinned — so a preset added to the union without a case, or a field quietly changed, fails here.
   */
  for (const preset of ROOM_PRESETS) {
    it(`room_preset ${preset} reaches createRoom in an otherwise unchanged body`, async () => {
      fake.aliasExists = false;
      const p = await connectFake({ roomPreset: preset });
      await p.post(asTopic('ctx-payments'), WRITER, 'hello');

      expect(fake.createRoomBodies).toEqual([
        createRoomBodyFor(preset, [], 'parley_ctx-payments'),
      ]);
      await p.disconnect();
    });
  }

  it('a read on an unprovisioned topic degrades to an empty page, spending no creation budget', async () => {
    fake.aliasExists = false;
    fake.createRoomLimited = Number.POSITIVE_INFINITY; // the budget is already exhausted
    const p = await connectFake({});
    const t = asTopic('ctx-attacker-chose-this');

    const absent = await p.fetchRecent({ topic: t, limit: 5 });

    expect(absent.messages).toEqual([]);
    expect(fake.createRoomBodies).toHaveLength(0);
    // …and the same read starts working the moment a legitimate write provisions the room.
    fake.aliasExists = true;
    fake.addMessage(String(t), 'from-a-peer');
    expect((await p.fetchRecent({ topic: t, limit: 5 })).messages.map((m) => m.content)).toEqual([
      'from-a-peer',
    ]);
    await p.disconnect();
  });

  it('a blocking read waits for the room a peer has yet to create', async () => {
    fake.aliasExists = false;
    const p = await connectFake({});
    const t = asTopic('ctx-not-yet');

    const pending = p.fetchRecent({ topic: t, since: asCursor(''), blockMs: 3000, limit: 5 });
    const appears = setTimeout(() => {
      fake.aliasExists = true;
      fake.addMessage(String(t), 'first-ever');
    }, 200);

    const got = await pending;
    clearTimeout(appears);

    expect(got.messages.map((m) => m.content)).toEqual(['first-ever']);
    expect(fake.createRoomBodies).toHaveLength(0);
    await p.disconnect();
  }, 20_000);

  /**
   * CLASS: `blockMs` engages on an EMPTY window, with or without a `since` — so a topic with no room
   * yet blocks either way, and the budget is the only thing that bounds it. Whatever the answer, a
   * READ must never provision: the `createRoomBodies` assertion is what keeps a topic the model
   * pattern-matched out of untrusted context from minting a room on someone's homeserver.
   */
  it.each([
    { name: 'no since', since: undefined, blocks: true },
    { name: 'a since', since: asCursor(''), blocks: true },
  ])('a never-posted topic with blockMs and $name: blocks = $blocks', async ({ since, blocks }) => {
    fake.aliasExists = false;
    const p = await connectFake({});

    const started = Date.now();
    const res = await p.fetchRecent({
      topic: asTopic('ctx-not-yet'),
      since,
      blockMs: 1500,
      limit: 5,
    });
    const elapsed = Date.now() - started;

    expect(res.messages).toEqual([]);
    expect(elapsed > 1000).toBe(blocks);
    expect(fake.createRoomBodies).toHaveLength(0);
    await p.disconnect();
  }, 20_000);

  it('an already-existing room is joined, not re-provisioned', async () => {
    fake.aliasExists = true;
    const p = await connectFake({});
    await p.post(asTopic('ctx-payments'), WRITER, 'hello');

    expect(fake.createRoomBodies).toHaveLength(0);
    await p.disconnect();
  });
});

/**
 * CLASS: no seam call may proceed on a swallowed authorization failure. The default preset makes
 * every provisioned room invite-only, so a SECOND Matrix account — which the README prescribes per
 * session — reaches an existing topic room it was never invited to. A join whose refusal is ignored
 * turns that into an opaque 403 out of `/send` and `/messages` much later, and a live path that
 * registers a route for a room it cannot see.
 */
const REFUSED_JOIN = [403, 404];

describe('a refused join fails the call that needed the room', () => {
  for (const status of REFUSED_JOIN) {
    for (const [entryName, entry] of Object.entries(ENTRY_POINTS)) {
      it(`join → ${status} / ${entryName} rejects and registers no live route`, async () => {
        fake.aliasExists = true; // the room exists; this account is simply not a member
        fake.joinStatus = status;
        const p = await connectFake({});

        await expect(entry.drive(p, asTopic('ctx-payments'))).rejects.toThrow();
        expect([...(p as unknown as { liveTopics: Set<string> }).liveTopics]).toEqual([]);
        await p.disconnect();
      });
    }
  }

  it('a 403 names the alias, the account and the fix', async () => {
    fake.aliasExists = true;
    fake.joinStatus = 403;
    const p = await connectFake({});

    await expect(p.post(asTopic('ctx-payments'), WRITER, 'hello')).rejects.toThrow(
      /#parley_ctx-payments:fake[\s\S]*@parley:fake[\s\S]*invite/,
    );
    await p.disconnect();
  });
});

/**
 * CLASS: every seam argument is either honored or documented as ignored. `post`'s `inReplyTo` is
 * honored on Matrix — the backend that threads most natively — so `parley_post`'s documented
 * `in_reply_to` promise is actually kept on the wire.
 */
describe('post honors the seam arguments it accepts', () => {
  it('inReplyTo becomes an m.in_reply_to relation on the sent event', async () => {
    fake.aliasExists = true;
    const p = await connectFake({});
    const t = asTopic('threaded');
    const parent = await p.post(t, WRITER, 'question');
    await p.post(t, WRITER, 'answer', { inReplyTo: parent });

    expect(fake.sentBodies.at(-1)!['m.relates_to']).toEqual({
      'm.in_reply_to': { event_id: String(parent) },
    });
    await p.disconnect();
  });

  it('a post without inReplyTo carries no relation', async () => {
    fake.aliasExists = true;
    const p = await connectFake({});
    await p.post(asTopic('threaded'), WRITER, 'standalone');

    expect(fake.sentBodies.at(-1)!['m.relates_to']).toBeUndefined();
    await p.disconnect();
  });
});

// The fake asserts what we SEND; only the homeserver can confirm what it actually enforces — a
// preset whose server-side meaning drifts would pass every test above.
const live = (await isMatrixUp()) ? describe : describe.skip;

live('live homeserver: the provisioned room really is invite-only', () => {
  it('m.room.join_rules reads back as `invite`', async () => {
    vi.unstubAllGlobals(); // this one talks to the real Synapse
    const p = new MatrixPlugin();
    await p.connect({
      homeserver_url: HOMESERVER,
      server_name: SERVER_NAME,
      user: A.user,
      password: A.password,
      sync_timeout_ms: 5000,
    });
    // A FRESH topic each run, so the assertion is about a room this run actually provisioned —
    // reusing a stable alias would only ever re-read whatever the first run happened to create.
    const name = `join-rule-probe-${Date.now().toString(36)}`;
    const alias = aliasForTopic(name);
    const token = (p as unknown as { token: string }).token;
    try {
      await p.post(asTopic(name), WRITER, 'probe');

      const roomId = await roomIdOf(token, alias);
      expect(roomId, `${alias} did not resolve`).toBeDefined();
      const state = await fetch(
        `${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent(roomId!)}/state/m.room.join_rules`,
        { headers: { Authorization: `Bearer ${token}` } },
      );

      expect(((await state.json()) as { join_rule: string }).join_rule).toBe('invite');
    } finally {
      await retireRoom(alias, [token]);
      await p.disconnect();
    }
  }, 30_000);
});
