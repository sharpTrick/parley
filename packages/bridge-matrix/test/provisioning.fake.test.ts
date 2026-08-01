import { asCursor, asHandle, asTopic, type Topic } from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MatrixPlugin, ROOM_PRESETS, type RoomPreset } from '../src/index.js';
import {
  aliasForTopic as fakeAliasForTopic,
  connectFake,
  FakeSynapse,
  SELF_MXID,
} from './fake-synapse.js';
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
 * CLASS: a room the plugin ADOPTS is held to the bar it would have PROVISIONED. Only the create path
 * chooses a preset; every other path takes whatever room a deterministic — therefore guessable —
 * alias resolves to, and a homeserver lets any local account (or, under federation, a remote one)
 * claim an alias first. Adopting such a room posts this session's output into its creator's room and
 * delivers that creator's messages into a live agent session as `<channel>` events. So the trust set
 * is the one already in config: `invite` names the accounts whose rooms may be used, `room_preset`
 * the join rules those rooms may carry. Graded at EVERY entry point, because a check on the write
 * path alone still hands a model-named topic to `fetchRecent`.
 */
const PEER = '@ally:parley.local';
const STRANGER = '@squatter:parley.local';
const ADOPTED = asTopic('ctx-payments');
const ADOPTED_ALIAS = /#parley_ctx-payments:fake/;

const ADOPTION: Record<
  string,
  {
    creator: string;
    joinRule: string;
    invite?: string[];
    preset?: RoomPreset;
    /** Undefined → the room is adopted; otherwise what the refusal has to name. */
    refusesNaming?: RegExp;
  }
> = {
  'this account created it, invite-only': { creator: SELF_MXID, joinRule: 'invite' },
  'an invited peer created it, invite-only': { creator: PEER, joinRule: 'invite', invite: [PEER] },
  'a stranger created it, invite-only': {
    creator: STRANGER,
    joinRule: 'invite',
    refusesNaming: /#parley_ctx-payments:fake[\s\S]*@squatter:parley\.local[\s\S]*invite/,
  },
  'a stranger created it, world-joinable': {
    creator: STRANGER,
    joinRule: 'public',
    refusesNaming: /#parley_ctx-payments:fake[\s\S]*@squatter:parley\.local/,
  },
  'a peer this config does not list created it': {
    creator: PEER,
    joinRule: 'invite',
    invite: [STRANGER],
    refusesNaming: /#parley_ctx-payments:fake[\s\S]*@ally:parley\.local/,
  },
  'this account created it, but it is world-joinable': {
    creator: SELF_MXID,
    joinRule: 'public',
    refusesNaming: /#parley_ctx-payments:fake[\s\S]*join rule is public[\s\S]*room_preset/,
  },
  'this account created it, world-joinable, and room_preset says so': {
    creator: SELF_MXID,
    joinRule: 'public',
    preset: 'public_chat',
  },
  'an invited peer created it under a join rule neither preset produces': {
    creator: PEER,
    joinRule: 'knock',
    invite: [PEER],
    refusesNaming: /#parley_ctx-payments:fake[\s\S]*join rule is knock/,
  },
};

describe('a room the plugin did not create is adopted only on its stated trust bar', () => {
  for (const [name, row] of Object.entries(ADOPTION)) {
    for (const [entryName, entry] of Object.entries(ENTRY_POINTS)) {
      it(`${name} / ${entryName}`, async () => {
        fake.aliasExists = true;
        fake.existingRoomCreator = row.creator;
        fake.existingRoomJoinRule = row.joinRule;
        const p = await connectFake({ invite: row.invite, roomPreset: row.preset });

        if (row.refusesNaming === undefined) {
          await entry.drive(p, ADOPTED);
        } else {
          await expect(entry.drive(p, ADOPTED)).rejects.toThrow(row.refusesNaming);
          // Nothing of this session reached the room, and no live route feeds it into the agent.
          expect(fake.sentBodies).toEqual([]);
          expect([...(p as unknown as { liveTopics: Set<string> }).liveTopics]).toEqual([]);
        }
        await p.disconnect();
      });
    }
  }

  /**
   * CLASS: a trust decision taken on a provenance nobody could read. `res.json()` accepts every shape
   * below, so no status check catches one — and a plugin that reads an absent `m.room.create` as "no
   * objection" adopts exactly the room the table above exists to refuse.
   */
  const UNREADABLE_STATE: Record<string, unknown> = {
    'not a list': { error: 'nope' },
    'an empty state': [],
    'no m.room.create': [
      { type: 'm.room.join_rules', state_key: '', sender: SELF_MXID, content: { join_rule: 'invite' } },
    ],
    'a create event with no sender': [
      { type: 'm.room.create', state_key: '', content: { creator: SELF_MXID } },
      { type: 'm.room.join_rules', state_key: '', sender: SELF_MXID, content: { join_rule: 'invite' } },
    ],
    'a create event that is not the room-wide one': [
      { type: 'm.room.create', state_key: 'x', sender: SELF_MXID, content: {} },
      { type: 'm.room.join_rules', state_key: '', sender: SELF_MXID, content: { join_rule: 'invite' } },
    ],
    'no m.room.join_rules': [{ type: 'm.room.create', state_key: '', sender: SELF_MXID, content: {} }],
    'scalars where the events should be': [1, 'two', null],
  };

  for (const [name, body] of Object.entries(UNREADABLE_STATE)) {
    it(`room state the plugin cannot read (${name}) is refused, not adopted`, async () => {
      fake.aliasExists = true;
      fake.stateBodyOverrides.push(body);
      const p = await connectFake({});

      await expect(p.post(ADOPTED, WRITER, 'hello')).rejects.toThrow(ADOPTED_ALIAS);
      expect(fake.sentBodies).toEqual([]);
      await p.disconnect();
    });
  }
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

/**
 * CLASS: a provisioning race whose LOSER must recover rather than fail. Two bridges first-posting to
 * the same topic both find the alias unresolved and both call `POST /createRoom`; a real homeserver
 * enforces alias uniqueness, so exactly one wins and the other is refused. The loser must resolve the
 * winner's alias and JOIN it — CLAUDE.md's "multi-process writes don't corrupt or error" — and the
 * genuinely unresolvable case must still fail loudly, carrying the homeserver's own body.
 *
 * The live fixture cannot reach this: `conformance.test.ts` pre-warms each topic's room so its
 * writers only resolve and join, and `live-per-topic.test.ts` is sequential.
 */
const RACE_OUTCOMES: Record<string, { status: number; resolvesAfter: boolean }> = {
  'createRoom 409, then the alias resolves': { status: 409, resolvesAfter: true },
  'createRoom 400, then the alias resolves': { status: 400, resolvesAfter: true },
  'createRoom 409, then the alias still 404s': { status: 409, resolvesAfter: false },
};

const CONTENDED = asTopic('ctx-contended');

/** The alias both racers ask for, composed from the plugin's own fold (see fake-synapse). */
const contendedAlias = (shared: boolean): string => fakeAliasForTopic(String(CONTENDED), shared);

/**
 * Put the winner's room in the fake's directory, and decide whether the loser's SECOND lookup — the
 * one the recovery branch makes after its create is refused — finds it. `aliasExists` is what the
 * loser's FIRST lookup answers, so it stays false until the create has been refused.
 */
const winnerAlreadyCreated = (fake: FakeSynapse, alias: string, resolvesAfter: boolean): void => {
  fake.addRaw('m.room.create', alias);
  fake.aliasExists = false;
  fake.onRequest = (_method, path) => {
    if (path.endsWith('/createRoom')) fake.aliasExists = resolvesAfter;
  };
};

/** Every `POST` this run issued against a room, as `<room_id>` — the evidence a join happened. */
const joinedRooms = (fake: FakeSynapse): string[] =>
  fake.requestUrls
    .filter((u) => u.pathname.endsWith('/join'))
    .map((u) => decodeURIComponent(u.pathname.split('/rooms/')[1]!.split('/')[0]!));

describe('the loser of a create race joins the winner’s room instead of failing', () => {
  for (const shared of [true, false]) {
    for (const [outcomeName, outcome] of Object.entries(RACE_OUTCOMES)) {
      for (const [entryName, entry] of Object.entries(ENTRY_POINTS)) {
        if (!entry.provisions) continue; // a read never creates, so it never races a create.
        const mode = shared ? 'shared_room' : 'per-topic';

        it(`${mode} / ${outcomeName} / ${entryName}`, async () => {
          const alias = contendedAlias(shared);
          fake.createRoomConflictStatus = outcome.status;
          winnerAlreadyCreated(fake, alias, outcome.resolvesAfter);
          const p = await connectFake({ shared });

          const drive = entry.drive(p, CONTENDED);
          if (!outcome.resolvesAfter) {
            // Loud, and carrying what the homeserver said — an unresolvable alias is not a state any
            // retry recovers from, and the operator needs the errcode to tell it from a lost race.
            await expect(drive).rejects.toThrow(
              new RegExp(`createRoom failed \\(${outcome.status}\\)[\\s\\S]*M_ROOM_IN_USE`),
            );
            await p.disconnect();
            return;
          }

          await drive;
          expect(fake.createRoomBodies).toHaveLength(1); // it tried exactly once, then recovered
          expect(fake.rooms).toHaveLength(1); // …and no second room was minted
          expect(joinedRooms(fake)).toContain(fake.roomIdFor(alias));
          if (entryName === 'first post') {
            expect(fake.timelineOf(alias).map((e) => (e.content as { body: string }).body)).toContain(
              'hello',
            );
          }
          await p.disconnect();
        });
      }
    }
  }

  it('a 403 on the JOIN that recovers the race still names the alias, the account and the fix', async () => {
    const alias = contendedAlias(false);
    winnerAlreadyCreated(fake, alias, true);
    fake.joinStatus = 403;
    const p = await connectFake({});

    await expect(p.post(CONTENDED, WRITER, 'hello')).rejects.toThrow(
      /#parley_ctx-contended:fake[\s\S]*@parley:fake[\s\S]*invite/,
    );
    await p.disconnect();
  });

  /**
   * The race itself rather than a staged replay of it: every writer's FIRST post lands together, so
   * whichever create wins is the fake's own scheduling. One room, and nobody's message lost.
   */
  for (const writers of [2, 4]) {
    it(`${writers} bridges first-posting at once converge on one room`, async () => {
      fake.aliasExists = false;
      const alias = contendedAlias(false);
      const bridges = await Promise.all(
        Array.from({ length: writers }, () => connectFake({})),
      );

      await Promise.all(bridges.map((p, i) => p.post(CONTENDED, WRITER, `w${i}`)));

      expect(fake.rooms).toHaveLength(1);
      expect(
        fake.timelineOf(alias).map((e) => (e.content as { body: string }).body).sort(),
      ).toEqual(Array.from({ length: writers }, (_v, i) => `w${i}`));
      for (const p of bridges) await p.disconnect();
    }, 20_000);
  }
});

/**
 * CLASS: an unbounded, model-reachable side effect on a path documented as read-only. The tables
 * above grade one write — `createRoom` — which leaves every OTHER state change a seam call makes
 * ungraded, and a read makes one: it JOINs. That join is permanent (nothing in `src/` ever leaves or
 * forgets a room), the topic naming it comes from the model, and the joined-room set is what bounds
 * every later `/sync` — a cost this repo's own live fixture records as a session going from 3.4s to
 * over 15s. Declaring the whole set per call makes a new write on a read path fail HERE rather than
 * being discovered later as homeserver slowness.
 */
const WRITE_SHAPES: [RegExp, string][] = [
  [/\/v3\/createRoom$/, 'POST /createRoom'],
  [/\/join$/, 'POST /join'],
  [/\/send\/m\.room\.message\//, 'PUT /send'],
];

/**
 * The reads that decide whether a room may be used at all, listed with the writes and in wire order.
 * Keep them declared here rather than filtered out with every other GET, so that a path which starts
 * ADOPTING a room without asking who made it fails in this table too, not only where its outcome is
 * graded — the sequence is the invariant: the probe precedes the first use of the room.
 */
const PROBE_SHAPES: [RegExp, string][] = [[/\/v3\/rooms\/[^/]+\/state$/, 'GET /state']];

/** Every declared request a driver issued, named — an unclassified write names itself and fails. */
const recordWrites = (fake: FakeSynapse): (() => string[]) => {
  const writes: string[] = [];
  fake.onRequest = (method, path) => {
    if (path.endsWith('/v3/login')) return;
    const declared = [...WRITE_SHAPES, ...PROBE_SHAPES].find(([re]) => re.test(path))?.[1];
    if (declared !== undefined) writes.push(declared);
    else if (method !== 'GET') writes.push(`${method} ${path}`);
  };
  return () => writes;
};

const SIDE_EFFECTS: Record<
  string,
  { aliasExists: boolean; effects: string[]; drive: (p: MatrixPlugin, t: Topic) => Promise<unknown> }
> = {
  'fetchRecent (no since) on a room that exists': {
    aliasExists: true,
    effects: ['POST /join', 'GET /state'],
    drive: (p, t) => p.fetchRecent({ topic: t, limit: 5 }),
  },
  'fetchRecent (no since) with block_ms on a room that exists': {
    aliasExists: true,
    effects: ['POST /join', 'GET /state'],
    drive: (p, t) => p.fetchRecent({ topic: t, limit: 5, blockMs: 300 }),
  },
  'fetchRecent (since) with block_ms on a topic with no room': {
    aliasExists: false,
    effects: [],
    drive: (p, t) => p.fetchRecent({ topic: t, since: asCursor(''), limit: 5, blockMs: 300 }),
  },
  'post to a room that exists': {
    aliasExists: true,
    effects: ['POST /join', 'GET /state', 'PUT /send'],
    drive: (p, t) => p.post(t, WRITER, 'x'),
  },
  'post to a topic with no room': {
    aliasExists: false,
    effects: ['POST /createRoom', 'PUT /send'],
    drive: (p, t) => p.post(t, WRITER, 'x'),
  },
  'subscribe to a room that exists': {
    aliasExists: true,
    effects: ['POST /join', 'GET /state'],
    drive: (p, t) => p.subscribe(t, () => undefined),
  },
  'subscribe to a topic with no room': {
    aliasExists: false,
    effects: ['POST /createRoom'],
    drive: (p, t) => p.subscribe(t, () => undefined),
  },
};

describe('every seam call issues exactly the state changes it is declared to', () => {
  for (const [name, row] of Object.entries(SIDE_EFFECTS)) {
    it(`${name}: ${row.effects.join(' + ') || 'nothing'}`, async () => {
      fake.aliasExists = row.aliasExists;
      const p = await connectFake({});
      const writes = recordWrites(fake);

      await row.drive(p, asTopic('ctx-declared'));

      expect(writes()).toEqual(row.effects);
      await p.disconnect();
    }, 20_000);
  }

  it('a read of N distinct topics permanently joins N rooms', async () => {
    fake.aliasExists = true;
    const topics = ['ctx-a', 'ctx-b', 'ctx-c', 'ctx-d', 'ctx-e'].map(asTopic);
    const p = await connectFake({});
    const writes = recordWrites(fake);

    for (const t of topics) await p.fetchRecent({ topic: t, limit: 5 });

    // Unbounded in the number of topics a model can name, and permanent — which is why the README
    // has to say so, and why `topics`/`post_topics` are the operator's only lever.
    expect(writes()).toEqual(topics.flatMap(() => ['POST /join', 'GET /state']));
    expect(fake.rooms).toHaveLength(topics.length);
    await p.disconnect();
  }, 20_000);
});
