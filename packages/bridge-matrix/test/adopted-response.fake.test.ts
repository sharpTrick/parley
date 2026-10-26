import { asCursor, asHandle, asTopic, type FetchRecentResult } from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MatrixPlugin } from '../src/index.js';
import { fakeConfig, FakeSynapse, HOMESERVER_URL } from './fake-synapse.js';

/**
 * CLASS: a 200 whose body the plugin ADOPTS. `wire.ts` states the invariant — every field is
 * JSON on which the homeserver enforces no schema, so nothing reaches a consumer without passing a
 * guard — and enforces it for the event fields that reach `buildMessage` and for the resume token.
 * The responses that mint what the plugin then USES were read through a bare `as` cast instead: the
 * credential it bears on every later request, and the id it hands core to persist as this topic's
 * cursor AND its dedup key.
 *
 * The invariant is per-field and has two legal outcomes, never a third: the value is a non-empty
 * string, or the call that would have adopted it FAILS naming this plugin. A resolved call carrying
 * a number, a `null` or an empty string onward is the failure this grades — it does not present at
 * the seam, it presents a restart later as a `read-state.json` cursor no homeserver can resolve, or
 * as `Authorization: Bearer 12345` on every request the deployment makes.
 *
 * Driven per ENDPOINT rather than per known-bad line, so the field a later change starts adopting is
 * graded the day its endpoint is listed, and the well-formed row is what stops the table passing on
 * a plugin that refuses everything.
 */

const TOPIC = asTopic('adopted');
const WRITER = asHandle('writer');

let fake: FakeSynapse;
beforeEach(() => {
  fake = new FakeSynapse();
  vi.stubGlobal('fetch', fake.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Absent — a key the body simply does not carry, which no JSON value can stand in for. */
const ABSENT = Symbol('absent');

/**
 * Values a homeserver, a proxy or a captive portal can put where a Matrix id or a token belongs.
 * Every one of them survives `res.json()`, so no HTTP status and no parse failure reaches this code.
 */
const BAD_VALUES: Record<string, unknown> = {
  'a number': 42,
  'JSON null': null,
  'the empty string': '',
  'an object': { id: 'x' },
  'a list': [],
  absent: ABSENT,
};

/** Replace ONE field of ONE endpoint's 200 body, leaving every other response untouched. */
const mangle = (match: RegExp, field: string, value: unknown): void => {
  const inner = fake.fetch;
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit): Promise<Response> => {
    const res = await inner(input as string, init);
    const url = new URL(String(typeof input === 'string' ? input : (input as Request).url));
    if (!match.test(url.pathname) || res.status !== 200) return res;
    const body = (await res.clone().json()) as Record<string, unknown>;
    if (value === ABSENT) delete body[field];
    else body[field] = value;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
};

const idsOfPage = (result: unknown): unknown[] => {
  const page = result as FetchRecentResult;
  return [page.nextCursor, ...page.messages.flatMap((m) => [m.backendMsgId, m.cursor])];
};

interface Adoption {
  /** The endpoint whose 200 is mangled, and the field of it the plugin reads. */
  match: RegExp;
  field: string;
  /** Whether the topic's room is already there — a create and a lookup mint the same id. */
  aliasExists: boolean;
  seed?: (p: MatrixPlugin) => Promise<void>;
  drive: (p: MatrixPlugin, seeded: string | undefined) => Promise<unknown>;
  /** Every value the call handed back that core would persist. */
  adopted: (result: unknown) => unknown[];
  /** Set where no value can make the call legal — the credential is the whole point of its call. */
  mustReject?: true;
}

const ADOPTIONS: Record<string, Adoption> = {
  'POST /login → access_token': {
    match: /\/v3\/login$/,
    field: 'access_token',
    aliasExists: true,
    drive: (p) => p.connect(fakeConfig()),
    adopted: () => [],
    mustReject: true,
  },
  'POST /createRoom → room_id': {
    match: /\/v3\/createRoom$/,
    field: 'room_id',
    aliasExists: false,
    drive: (p) => p.post(TOPIC, WRITER, 'x'),
    adopted: (r) => [r],
  },
  'GET /directory/room → room_id': {
    match: /\/v3\/directory\/room\//,
    field: 'room_id',
    aliasExists: true,
    drive: (p) => p.post(TOPIC, WRITER, 'x'),
    adopted: (r) => [r],
  },
  'PUT /send → event_id': {
    match: /\/send\/m\.room\.message\//,
    field: 'event_id',
    aliasExists: true,
    drive: (p) => p.post(TOPIC, WRITER, 'x'),
    adopted: (r) => [r],
  },
  'GET /context → end': {
    match: /\/context\//,
    field: 'end',
    aliasExists: true,
    seed: async (p) => void (await p.post(TOPIC, WRITER, 'seed')),
    drive: (p, seeded) =>
      p.fetchRecent({ topic: TOPIC, since: asCursor(seeded ?? ''), limit: 5 }),
    adopted: idsOfPage,
  },
  'GET /messages → chunk': {
    match: /\/messages$/,
    field: 'chunk',
    aliasExists: true,
    seed: async (p) => void (await p.post(TOPIC, WRITER, 'seed')),
    drive: (p) => p.fetchRecent({ topic: TOPIC, limit: 5 }),
    adopted: idsOfPage,
  },
};

describe('no value the plugin adopts from a 200 is anything but a non-empty string', () => {
  for (const [endpoint, row] of Object.entries(ADOPTIONS)) {
    for (const [valueName, value] of Object.entries(BAD_VALUES)) {
      it(`${endpoint} is ${valueName}: the call fails rather than adopting it`, async () => {
        fake.aliasExists = row.aliasExists;
        const p = new MatrixPlugin();
        if (row.match.source.includes('login')) fake.loginBody = { user_id: '@parley:fake' };
        else await p.connect(fakeConfig());
        let seeded: string | undefined;
        if (row.seed !== undefined) {
          await row.seed(p);
          seeded = String((await p.fetchRecent({ topic: TOPIC, limit: 5 })).nextCursor);
        }
        if (!row.match.source.includes('login')) mangle(row.match, row.field, value);
        else if (value !== ABSENT) fake.loginBody = { access_token: value, user_id: '@x:fake' };

        const outcome = await row.drive(p, seeded).then(
          (r) => ({ ok: true as const, r }),
          (err: unknown) => ({ ok: false as const, err: err as Error }),
        );

        if (row.mustReject === true) {
          expect(outcome.ok, 'the credential this call exists to mint was never checked').toBe(
            false,
          );
          const message = String(outcome.ok ? '' : outcome.err.message);
          expect(message).toContain('[parley-matrix]');
          expect(message, 'the operator is not told which homeserver answered').toContain(
            HOMESERVER_URL,
          );
        } else if (outcome.ok) {
          for (const id of row.adopted(outcome.r)) {
            expect(
              typeof id === 'string' && id !== '',
              `${endpoint}: the call resolved carrying ${JSON.stringify(id) ?? typeof id}`,
            ).toBe(true);
          }
        }
        await p.disconnect();
      }, 30_000);
    }
  }

  it('a well-formed homeserver still connects, posts and reads', async () => {
    const p = new MatrixPlugin();
    await p.connect(fakeConfig());
    const id = await p.post(TOPIC, WRITER, 'x');
    const page = await p.fetchRecent({ topic: TOPIC, limit: 5 });
    expect(typeof id).toBe('string');
    for (const v of idsOfPage(page)) expect(typeof v).toBe('string');
    expect(page.messages.map((m) => m.content)).toEqual(['x']);
    await p.disconnect();
  }, 30_000);
});
