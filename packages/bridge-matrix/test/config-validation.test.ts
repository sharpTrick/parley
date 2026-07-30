import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MatrixPlugin, ROOM_PRESETS } from '../src/index.js';

/**
 * CLASS: a `backend_config` value whose only guard is the TypeScript type. Core loads
 * `backend_config` as `z.record(z.unknown())`, so a YAML file supplies these keys with no runtime
 * check at all — the declared union or `number` exists only at compile time. An unvalidated value
 * either reaches the wire (a `preset` lands verbatim in `POST /createRoom`; `trusted_private_chat`
 * hands every invitee power level 100 and lets any of them flip `m.room.join_rules` to public) or
 * reaches the park arithmetic (a `sync_timeout_ms` of 0 collapses every wait into a re-query storm).
 * Both must be LOAD ERRORS, the way `skip_permissions: true` is — never a lenient coercion.
 *
 * The table walks EVERY typed field of `MatrixBackendConfig` and, per field, a value outside its
 * union/range and a value of the wrong JS type. Each row asserts the REJECTION, and that nothing at
 * all went on the wire — a row grading the request body would pass a plugin that merely sanitized
 * the value after sending it.
 */

const BASE: Record<string, unknown> = {
  homeserver_url: 'http://synapse.fake',
  server_name: 'fake',
  user: 'parley',
  password: 'a-real-test-secret',
  sync_timeout_ms: 5000,
};

const FIELDS: Record<string, { accepted: unknown[]; rejected: Record<string, unknown> }> = {
  homeserver_url: {
    accepted: ['http://synapse.fake', 'https://matrix.example.org:8448'],
    rejected: {
      'the wrong JS type': 42,
      'an empty string': '',
      'a bare host with no scheme': 'synapse.fake',
      'a non-http scheme': 'file:///etc/passwd',
    },
  },
  user: {
    accepted: ['parley', 'parley2'],
    rejected: { 'the wrong JS type': 42, 'an empty string': '' },
  },
  password: {
    accepted: ['a-real-test-secret'],
    rejected: { 'the wrong JS type': null, 'an empty string': '' },
  },
  server_name: {
    accepted: ['fake', 'parley.local'],
    rejected: { 'the wrong JS type': ['fake'], 'an empty string': '' },
  },
  shared_room: {
    accepted: ['parley_conformance'],
    rejected: { 'the wrong JS type': true, 'an empty string': '' },
  },
  sync_timeout_ms: {
    accepted: [1, 25_000, 60_000],
    rejected: {
      'the wrong JS type': '5000',
      'zero — a park slice that never sleeps': 0,
      'negative': -1,
      'NaN': Number.NaN,
      'Infinity': Number.POSITIVE_INFINITY,
      'a fraction of a millisecond': 0.5,
    },
  },
  invite: {
    accepted: [[], ['@ally:parley.local']],
    rejected: {
      'the wrong JS type': '@ally:parley.local',
      'an array with a non-string member': ['@ally:parley.local', 7],
      'an array with an empty member': [''],
    },
  },
  room_preset: {
    accepted: [...ROOM_PRESETS],
    rejected: {
      'the preset the README says is refused': 'trusted_private_chat',
      'a junk value outside the union': 'public_chat_lol',
      'the wrong JS type': 1,
    },
  },
};

let requests: string[];
beforeEach(() => {
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(typeof input === 'string' ? input : ((input as Request).url ?? input)));
      return new Response(JSON.stringify({ access_token: 'tok', user_id: '@parley:fake' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('connect refuses a backend_config value the type system cannot enforce', () => {
  for (const [field, spec] of Object.entries(FIELDS)) {
    for (const [why, value] of Object.entries(spec.rejected)) {
      it(`${field} = ${why}: rejected at load, nothing sent`, async () => {
        await expect(
          new MatrixPlugin().connect({ ...BASE, [field]: value }),
        ).rejects.toThrow(new RegExp(`backend_config\\.${field}`));
        expect(requests).toEqual([]);
      });
    }

    for (const value of spec.accepted) {
      it(`${field} = ${JSON.stringify(value)}: accepted`, async () => {
        const p = new MatrixPlugin();
        await p.connect({ ...BASE, [field]: value });
        expect(requests).toHaveLength(1); // the login, and only the login
        await p.disconnect();
      });
    }

    it(`${field} omitted entirely: accepted`, async () => {
      const cfg = { ...BASE };
      delete cfg[field];
      const p = new MatrixPlugin();
      await p.connect(cfg);
      await p.disconnect();
    });
  }

  it('the refusal of trusted_private_chat says what it would cost', async () => {
    await expect(
      new MatrixPlugin().connect({ ...BASE, room_preset: 'trusted_private_chat' }),
    ).rejects.toThrow(/power level 100[\s\S]*m\.room\.join_rules/);
  });

  /**
   * The accepted-value rows above are GENERATED from `ROOM_PRESETS`, so deleting a member — or
   * adding `trusted_private_chat` to it — moves the table with the code and grades nothing. Pin the
   * membership by value as well.
   */
  it('ROOM_PRESETS is exactly the two presets the README grades', () => {
    expect([...ROOM_PRESETS]).toEqual(['private_chat', 'public_chat']);
  });
});
