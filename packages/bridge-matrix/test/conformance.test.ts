import { runConformanceSuite } from '@sharptrick/parley-conformance';
import { asHandle, asTopic, type Topic } from '@sharptrick/parley-core';
import { describe, it } from 'vitest';
import { MatrixPlugin } from '../src/index.js';

const HOMESERVER = process.env.PARLEY_MATRIX_URL ?? 'http://127.0.0.1:8008';
const SERVER_NAME = process.env.PARLEY_MATRIX_SERVER_NAME ?? 'parley.local';
const USER = process.env.PARLEY_MATRIX_USER ?? 'parley';
const PASSWORD = process.env.PARLEY_MATRIX_PASSWORD ?? 'parleypass';
// Shared-room mode: Synapse rate-limits room CREATION hard (~2-room burst, then ~1 room / 45s per
// user) while send/read/sync are unthrottled, so one-room-per-topic is infeasible for an
// unprivileged login under a 20s test timeout. The suite needs ~7 fresh topics per run; we fold
// them into ONE room and isolate topics by the plugin's `app.parley.topic` tag. Each freshTopic()
// is globally unique, so topics never collide across tests OR runs. A real deployment runs the
// bridge as a rate-limit-exempt appservice and leaves `shared_room` unset.
const STABLE_ROOM = 'parley_conformance';
// The room ROTATES DAILY. One permanent room accumulates every run's traffic forever, and a
// since-less `fetchRecent` pages BACKWARDS through all of it — on a long-lived homeserver each test
// grows to tens of seconds and eventually only times out. A day-stamped alias costs at most one
// createRoom per day, well inside the burst, and bounds the room to a day of traffic.
const dailyRoom = (): string =>
  `${STABLE_ROOM}_${new Date().toISOString().slice(0, 10).replaceAll('-', '')}`;
/** Room housekeeping (provisioning) writes go here, never into a topic under test. */
const HOUSEKEEPING = asTopic('parley-conformance-prewarm');

const configFor = (sharedRoom: string) => ({
  homeserver_url: HOMESERVER,
  server_name: SERVER_NAME,
  user: USER,
  password: PASSWORD,
  shared_room: sharedRoom,
  // Short long-poll so disconnect()/teardown is snappy under the test runner.
  sync_timeout_ms: 5000,
});

/**
 * Provision today's room, falling back to the stable one when the homeserver refuses. Keep the
 * fallback, so that a spent room-creation budget costs this suite its speed and never its result.
 */
async function pickSharedRoom(): Promise<string> {
  const override = process.env.PARLEY_MATRIX_SHARED_ROOM;
  if (override !== undefined) return override;
  const probe = new MatrixPlugin();
  try {
    await probe.connect(configFor(dailyRoom()));
    await probe.post(HOUSEKEEPING, asHandle('prewarm'), 'prewarm');
    return dailyRoom();
  } catch {
    return STABLE_ROOM;
  } finally {
    await probe.disconnect();
  }
}

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

let seq = 0;
const rand = () => Math.random().toString(36).slice(2, 8);

function contextFactory(sharedRoom: string) {
  return async () => {
    const plugin = new MatrixPlugin();
    await plugin.connect(configFor(sharedRoom));
    return {
      plugin,
      // Matrix honors `blockMs` NATIVELY: fetchRecent long-polls a room-filtered `/sync` (the same
      // primitive `subscribe` uses) for a new event, then reconciles via the canonical `/messages`
      // catch-up. So the shared suite runs the blockMs long-poll case against the live homeserver.
      supportsBlockingFetch: true,
      // Each topic is globally unique → its `app.parley.topic` tag isolates it inside the room.
      freshTopic: (): Topic => asTopic(`t-${++seq}-${Date.now().toString(36)}-${rand()}`),
      carriesSenderIdentity: false,
      cleanup: async () => {
        await plugin.disconnect();
      },
      // W independent client connections (separate logins/devices), each posting K messages to `topic`.
      concurrentPost: async (topic: Topic, writers: number, perWriter: number) => {
        // Pre-warm with the main connection so the W writers only resolve+join, never race W
        // creates against the burst limit. It has to be a POST — a read never provisions — and it
        // goes to the housekeeping topic so it cannot land in the topic under test.
        await plugin.post(HOUSEKEEPING, asHandle('prewarm'), 'prewarm');
        const plugins = await Promise.all(
          Array.from({ length: writers }, async () => {
            const p = new MatrixPlugin();
            await p.connect(configFor(sharedRoom));
            return p;
          }),
        );
        try {
          await Promise.all(
            plugins.map(async (p, w) => {
              for (let i = 0; i < perWriter; i++) {
                await p.post(topic, asHandle(`w${w}`), `w${w}-${i}`);
              }
            }),
          );
        } finally {
          await Promise.all(plugins.map((p) => p.disconnect()));
        }
      },
    };
  };
}

if (await isMatrixUp(HOMESERVER)) {
  runConformanceSuite('matrix', contextFactory(await pickSharedRoom()));
} else {
  describe.skip(`seam conformance: matrix (no homeserver at ${HOMESERVER})`, () => {
    it('skipped — start Synapse (examples/dev-compose) to run', () => undefined);
  });
}
