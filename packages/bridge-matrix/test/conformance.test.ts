import { runConformanceSuite } from '@parley/conformance';
import { asHandle, asTopic, type Topic } from '@parley/core';
import { describe, it } from 'vitest';
import { MatrixPlugin } from '../src/index.js';

const HOMESERVER = process.env.PARLEY_MATRIX_URL ?? 'http://127.0.0.1:8008';
const SERVER_NAME = process.env.PARLEY_MATRIX_SERVER_NAME ?? 'parley.local';
const USER = process.env.PARLEY_MATRIX_USER ?? 'parley';
const PASSWORD = process.env.PARLEY_MATRIX_PASSWORD ?? 'parleypass';
// Shared-room mode: Synapse rate-limits room CREATION hard (~2-room burst, then ~1 room / 45s per
// user) while send/read/sync are unthrottled, so one-room-per-topic is infeasible for an
// unprivileged login under a 20s test timeout. The suite needs ~7 fresh topics per run; we fold
// them into ONE stable, pre-existing room and isolate topics by the plugin's `app.parley.topic`
// tag. Each freshTopic() is globally unique, so topics never collide across tests OR runs. A real
// deployment runs the bridge as a rate-limit-exempt appservice and leaves `shared_room` unset.
const SHARED_ROOM = process.env.PARLEY_MATRIX_SHARED_ROOM ?? 'parley_conformance';

const baseConfig = {
  homeserver_url: HOMESERVER,
  server_name: SERVER_NAME,
  user: USER,
  password: PASSWORD,
  shared_room: SHARED_ROOM,
  // Short long-poll so disconnect()/teardown is snappy under the test runner.
  sync_timeout_ms: 5000,
};

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

async function makeContext() {
  const plugin = new MatrixPlugin();
  await plugin.connect(baseConfig);
  return {
    plugin,
    // Each topic is globally unique → its `app.parley.topic` tag isolates it inside the shared room.
    freshTopic: (): Topic => asTopic(`t-${++seq}-${Date.now().toString(36)}-${rand()}`),
    cleanup: async () => {
      await plugin.disconnect();
    },
    // W independent client connections (separate logins/devices), each posting K messages to `topic`.
    concurrentPost: async (topic: Topic, writers: number, perWriter: number) => {
      // Pre-warm the shared room with the main connection so the W writers only resolve+join it
      // (the stable room already exists across runs, so this is a no-op create — zero rate cost).
      await plugin.fetchRecent({ topic });
      const plugins = await Promise.all(
        Array.from({ length: writers }, async () => {
          const p = new MatrixPlugin();
          await p.connect(baseConfig);
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
}

if (await isMatrixUp(HOMESERVER)) {
  runConformanceSuite('matrix', makeContext);
} else {
  describe.skip(`seam conformance: matrix (no homeserver at ${HOMESERVER})`, () => {
    it('skipped — start Synapse (examples/dev-compose) to run', () => undefined);
  });
}
