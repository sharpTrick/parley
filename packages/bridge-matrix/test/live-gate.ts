import { asTopic, safeName } from '@sharptrick/parley-core';
import { sanitizeAlias } from '../src/index.js';

/**
 * The ONE live-homeserver gate. Every file that talks to the real Synapse resolves its environment,
 * its accounts and its alias fold through here, so a homeserver that does not match the compose
 * fixture skips (or fails) all of them together rather than one at a time — CI's "no test file skips
 * entirely" check reports each file separately, so three copies of this block turn one mis-set env
 * var into three unrelated-looking skips.
 */

export const HOMESERVER = (process.env.PARLEY_MATRIX_URL ?? 'http://127.0.0.1:8008').replace(
  /\/+$/,
  '',
);
export const SERVER_NAME = process.env.PARLEY_MATRIX_SERVER_NAME ?? 'parley.local';

export interface Account {
  user: string;
  password: string;
}

/** The account the compose fixture seeds; `B` is the second one the per-topic files need. */
export const A: Account = {
  user: process.env.PARLEY_MATRIX_USER ?? 'parley',
  password: process.env.PARLEY_MATRIX_PASSWORD ?? 'parleypass',
};
export const B: Account = {
  user: process.env.PARLEY_MATRIX_USER2 ?? 'parley2',
  password: process.env.PARLEY_MATRIX_PASSWORD2 ?? 'parleypass2',
};

export const mxid = (user: string): string => `@${user}:${SERVER_NAME}`;

/**
 * The alias the plugin will resolve for `topic` in per-topic mode, built from the plugin's OWN
 * exported fold. A hand-written `#parley_${topic}:${server}` template is a second implementation of
 * {@link safeName} that agrees with the first only until a topic needs sanitizing.
 */
export const aliasForTopic = (topic: string): string =>
  `#parley_${safeName(asTopic(topic), sanitizeAlias)}:${SERVER_NAME}`;

export async function isMatrixUp(): Promise<boolean> {
  try {
    const res = await fetch(`${HOMESERVER}/_matrix/client/versions`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * An access token for `account`, or `undefined` when it cannot log in (→ the caller skips). Throws
 * when the homeserver stamps a DIFFERENT `server_name` than the one every alias here is built from:
 * that config resolves aliases on a server this is not talking to, which otherwise presents as an
 * unexplained skip or an empty room rather than as the mis-set variable it is.
 */
export async function tokenFor(account: Account): Promise<string | undefined> {
  let json: { access_token?: string; user_id?: string };
  try {
    const res = await fetch(`${HOMESERVER}/_matrix/client/v3/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: account.user },
        password: account.password,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return undefined;
    json = (await res.json()) as { access_token?: string; user_id?: string };
  } catch {
    return undefined;
  }
  const userId = json.user_id ?? '';
  if (!userId.endsWith(`:${SERVER_NAME}`)) {
    throw new Error(
      `${HOMESERVER} stamped ${userId}, but this suite builds every alias for ` +
        `':${SERVER_NAME}' (PARLEY_MATRIX_SERVER_NAME). Point them at the same homeserver.`,
    );
  }
  return json.access_token;
}

const api = async (
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response | undefined> => {
  try {
    return await fetch(`${HOMESERVER}/_matrix/client/v3${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return undefined;
  }
};

/**
 * Claim `localpart` as `token`, the way any account on this homeserver can. Keep it a raw call and
 * not a second plugin instance, so that a room the plugin would never PROVISION — one somebody else
 * created, under a join rule of their choosing — can be put in front of it.
 */
export async function createRoomAs(
  token: string,
  localpart: string,
  preset: string,
): Promise<string | undefined> {
  const res = await api(token, 'POST', '/createRoom', {
    room_alias_name: localpart,
    preset,
    visibility: 'private',
  });
  if (res === undefined || !res.ok) return undefined;
  return ((await res.json()) as { room_id?: string }).room_id;
}

/** Join `roomId` as `token` — how an invited peer gets into a room this plugin did not create. */
export async function joinAs(token: string, roomId: string): Promise<boolean> {
  const res = await api(token, 'POST', `/rooms/${encodeURIComponent(roomId)}/join`, {});
  return res !== undefined && res.ok;
}

/**
 * Send an `m.room.message` VERBATIM through the raw Client-Server API — what a human in Element
 * sends, and the only way to produce an event carrying no `app.parley.topic` tag: every write this
 * plugin makes stamps one, so a suite driven only through the seam cannot reach the per-topic
 * delivery predicate at all.
 */
export async function sendRawMessage(
  token: string,
  roomId: string,
  content: Record<string, unknown>,
): Promise<string | undefined> {
  const txn = `live-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const res = await api(
    token,
    'PUT',
    `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txn)}`,
    content,
  );
  if (res === undefined || !res.ok) return undefined;
  return ((await res.json()) as { event_id?: string }).event_id;
}

/** The `m.room.message` bodies in `alias` as one of its members sees them — `[]` when it has none. */
export async function roomMessages(token: string, alias: string): Promise<string[]> {
  const roomId = await roomIdOf(token, alias);
  if (roomId === undefined) return [];
  const res = await api(
    token,
    'GET',
    `/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=50`,
  );
  if (res === undefined || !res.ok) return [];
  const { chunk } = (await res.json()) as {
    chunk?: { type?: string; content?: { body?: string } }[];
  };
  return (chunk ?? [])
    .filter((e) => e.type === 'm.room.message')
    .map((e) => e.content?.body ?? '');
}

export async function roomIdOf(token: string, alias: string): Promise<string | undefined> {
  const res = await api(token, 'GET', `/directory/room/${encodeURIComponent(alias)}`);
  if (res === undefined || !res.ok) return undefined;
  return ((await res.json()) as { room_id?: string }).room_id;
}

/**
 * Retire a room a live case provisioned: drop its alias, then have every participant LEAVE. Keep
 * this on every live case that creates a room, so that the fixture accounts' joined-room set stays
 * bounded — `existingRoom()` joins and nothing ever leaves, and every `/sync` degrades with the size
 * of that set (a session was measured going from 3.4s to over 15s), which reads as a flaky
 * homeserver rather than as accumulated fixtures.
 *
 * Keep it to leave + the alias, so that the cleanup itself stays cheap: this runs while the live
 * conformance suite is on the same homeserver in a sibling worker, and adding `/forget` to it was
 * measured pushing that suite's concurrent-writers case from 12s past its 20s budget.
 */
export async function retireRoom(alias: string, tokens: string[]): Promise<void> {
  const owner = tokens[0];
  if (owner === undefined) return;
  const roomId = await roomIdOf(owner, alias);
  if (roomId === undefined) return;
  await api(owner, 'DELETE', `/directory/room/${encodeURIComponent(alias)}`);
  for (const token of tokens) {
    await api(token, 'POST', `/rooms/${encodeURIComponent(roomId)}/leave`, {});
  }
}
