import { asCursor, asHandle, asTopic, type Topic } from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MatrixPlugin } from '../src/index.js';
import { connectFake, FakeSynapse } from './fake-synapse.js';

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

describe('only a write provisions, and never into a world-joinable room', () => {
  for (const shared of [true, false]) {
    for (const [entryName, entry] of Object.entries(ENTRY_POINTS)) {
      for (const aliasExists of [true, false]) {
        it(`${shared ? 'shared_room' : 'per-topic'} / ${entryName} / alias exists: ${aliasExists}`, async () => {
          fake.aliasExists = aliasExists;
          const p = await connectFake({ shared });
          await entry.drive(p, asTopic('ctx-payments'));

          const expected = !aliasExists && entry.provisions ? 1 : 0;
          expect(fake.createRoomBodies).toHaveLength(expected);
          for (const body of fake.createRoomBodies) expect(body.preset).not.toBe('public_chat');
          await p.disconnect();
        });
      }
    }
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

  it('opting back in to a public room is explicit config, never a default', async () => {
    const p = await connectFake({ roomPreset: 'public_chat' });
    await p.post(asTopic('open-house'), WRITER, 'hello');

    expect(fake.createRoomBodies[0]!.preset).toBe('public_chat');
    await p.disconnect();
  });

  it('configured invitees are provisioned onto the room', async () => {
    const p = await connectFake({ invite: ['@ally:parley.local'] });
    await p.post(asTopic('ctx-payments'), WRITER, 'hello');

    expect(fake.createRoomBodies[0]!.invite).toEqual(['@ally:parley.local']);
    await p.disconnect();
  });

  it('an already-existing room is joined, not re-provisioned', async () => {
    fake.aliasExists = true;
    const p = await connectFake({});
    await p.post(asTopic('ctx-payments'), WRITER, 'hello');

    expect(fake.createRoomBodies).toHaveLength(0);
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

const HOMESERVER = process.env.PARLEY_MATRIX_URL ?? 'http://127.0.0.1:8008';

async function isMatrixUp(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/_matrix/client/versions`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// The fake asserts what we SEND; only the homeserver can confirm what it actually enforces — a
// preset whose server-side meaning drifts would pass every test above.
const live = (await isMatrixUp(HOMESERVER)) ? describe : describe.skip;

live('live homeserver: the provisioned room really is invite-only', () => {
  it('m.room.join_rules reads back as `invite`', async () => {
    vi.unstubAllGlobals(); // this one talks to the real Synapse
    const p = new MatrixPlugin();
    await p.connect({
      homeserver_url: HOMESERVER,
      server_name: process.env.PARLEY_MATRIX_SERVER_NAME ?? 'parley.local',
      user: process.env.PARLEY_MATRIX_USER ?? 'parley',
      password: process.env.PARLEY_MATRIX_PASSWORD ?? 'parleypass',
      sync_timeout_ms: 5000,
    });
    // A FRESH topic each run, so the assertion is about a room this run actually provisioned —
    // reusing a stable alias would only ever re-read whatever the first run happened to create.
    const name = `join-rule-probe-${Date.now().toString(36)}`;
    await p.post(asTopic(name), WRITER, 'probe');

    const token = (p as unknown as { token: string }).token;
    const serverName = process.env.PARLEY_MATRIX_SERVER_NAME ?? 'parley.local';
    const alias = encodeURIComponent(`#parley_${name}:${serverName}`);
    const dir = await fetch(`${HOMESERVER}/_matrix/client/v3/directory/room/${alias}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const { room_id: roomId } = (await dir.json()) as { room_id: string };
    const state = await fetch(
      `${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.join_rules`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    expect(((await state.json()) as { join_rule: string }).join_rule).toBe('invite');
    await p.disconnect();
  }, 30_000);
});
