import { asHandle, asTopic } from '@sharptrick/parley-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG_KEYS, RedisPlugin } from '../src/index.js';

// CLASS: a config knob whose accept matrix, reject matrix, null matrix and examples matrix are all
// complete while the one place its value is CONSUMED is asserted nowhere. Validation grades the
// values a knob refuses; nothing here grades that the knob is wired to anything at all, so the
// plugin could ignore one outright — take the default, or a constant — and every existing matrix
// would still certify it. Round-8's `block_ms` was exactly that: 23 accepted values round-tripped
// through post → fetchRecent, a path that never reads the knob, while replacing the subscribe
// loop's `BLOCK: this.blockMs` with `BLOCK: 1` left the whole package suite green.
//
// One row per declared knob, generated from CONFIG_KEYS, so a knob added later with no declared
// wire observation fails here instead of shipping unobserved. Driven through the mocked `redis`
// module rather than a live server, because the observation IS the argument on the wire: a live
// round-trip cannot see the difference between `BLOCK: 2000` and `BLOCK: 1`.

interface ClientOptions {
  url?: string;
  socket?: { connectTimeout?: number };
}

interface Command {
  name: string;
  args: unknown[];
}

const seen = vi.hoisted(() => ({
  clients: [] as ClientOptions[],
  commands: [] as Command[],
}));

vi.mock('redis', () => ({
  createClient: (options: ClientOptions) => {
    seen.clients.push(options);
    const record = (name: string, args: unknown[]): void => {
      seen.commands.push({ name, args });
    };
    const client: Record<string, unknown> = {
      isOpen: false,
      on: () => client,
      connect: async () => {
        client.isOpen = true;
      },
      ping: async () => 'PONG',
      disconnect: async () => {
        client.isOpen = false;
      },
      exists: async (...args: unknown[]) => {
        record('exists', args);
        return 1;
      },
      xInfoStream: async (...args: unknown[]) => {
        record('xInfoStream', args);
        return { lastGeneratedId: '5-0' };
      },
      xAdd: async (...args: unknown[]) => {
        record('xAdd', args);
        return '5-1';
      },
      xRange: async (...args: unknown[]) => {
        record('xRange', args);
        return [];
      },
      xRevRange: async (...args: unknown[]) => {
        record('xRevRange', args);
        return [];
      },
      // Answers on a macrotask, so the read loop can never starve the timer queue with a tight
      // microtask chain.
      xRead: async (...args: unknown[]) => {
        record('xRead', args);
        return new Promise((resolve) => setTimeout(() => resolve(null), 20));
      },
    };
    return client;
  },
}));

const commandsNamed = (name: string): Command[] => seen.commands.filter((c) => c.name === name);

const T = asTopic('ops');
const BASE_URL = 'redis://knob-effects.invalid:6380';

/**
 * What a knob's value must be observable as on the wire once `connect()` has accepted it. `value`
 * is deliberately not the default, so a plugin that ignores the knob and uses its own constant
 * fails the row.
 */
interface WireEffect {
  value: unknown;
  /** The seam call that puts the knob on the wire. */
  exercise: (plugin: RedisPlugin) => Promise<void>;
  /** What the recorded traffic must show, given the wall-clock window `exercise` ran in. */
  check: (window: { before: number; after: number }) => void;
}

const effects: Record<string, WireEffect> = {
  url: {
    value: 'redis://knob-url.invalid:6381',
    exercise: async () => undefined,
    check: () => {
      expect(seen.clients.map((c) => c.url)).toEqual(['redis://knob-url.invalid:6381']);
    },
  },
  key_prefix: {
    value: 'knob-prefix:',
    exercise: async (plugin) => {
      await plugin.post(T, asHandle('w'), 'x');
    },
    check: () => {
      expect(commandsNamed('xAdd').map((c) => c.args[0])).toEqual([`knob-prefix:${T}`]);
    },
  },
  block_ms: {
    value: 1234,
    exercise: async (plugin) => {
      await plugin.subscribe(T, () => undefined);
      await vi.waitFor(() => expect(commandsNamed('xRead')).not.toEqual([]));
    },
    check: () => {
      const blocks = commandsNamed('xRead').map((c) => (c.args[1] as { BLOCK: number }).BLOCK);
      expect(blocks, 'the subscribe loop issued no XREAD, so this row grades nothing').not.toEqual(
        [],
      );
      expect(
        blocks,
        'the subscribe loop re-arms on an interval of its own, so block_ms buys nothing',
      ).toEqual(blocks.map(() => 1234));
    },
  },
  connect_timeout_ms: {
    value: 4321,
    exercise: async () => undefined,
    check: () => {
      expect(seen.clients.map((c) => c.socket?.connectTimeout)).toEqual([4321]);
    },
  },
  retention_days: {
    value: 3,
    exercise: async (plugin) => {
      await plugin.post(T, asHandle('w'), 'x');
    },
    check: ({ before, after }) => {
      const trims = commandsNamed('xAdd').map(
        (c) => (c.args[3] as { TRIM?: { threshold?: number } } | undefined)?.TRIM?.threshold,
      );
      expect(trims, 'post sent no MINID trim at all, so retention_days is a no-op').toHaveLength(1);
      const threshold = trims[0] ?? Number.NaN;
      expect(threshold).toBeGreaterThanOrEqual(before - 3 * 86_400_000);
      expect(threshold).toBeLessThanOrEqual(after - 3 * 86_400_000);
    },
  },
};

describe('bridge-redis — every accepted knob reaches the command it configures', () => {
  beforeEach(() => {
    seen.clients.length = 0;
    seen.commands.length = 0;
  });

  it.each(CONFIG_KEYS)('%s', async (knob) => {
    const effect = effects[knob];
    expect(
      effect,
      `no wire observation is declared for '${knob}', so nothing grades that it is wired to ` +
        `anything — declare one in this file's table`,
    ).toBeDefined();
    if (effect === undefined) return;

    const plugin = new RedisPlugin();
    try {
      await plugin.connect({ url: BASE_URL, [knob]: effect.value });
      const before = Date.now();
      await effect.exercise(plugin);
      const after = Date.now();
      effect.check({ before, after });
    } finally {
      await plugin.disconnect();
    }
  });

  // The inverse arm: every row above sets its knob explicitly, so a plugin that read the knob only
  // when it was given one would pass them all while the documented DEFAULT reached nothing.
  it('the subscribe loop blocks for the default block_ms when the knob is omitted', async () => {
    const plugin = new RedisPlugin();
    try {
      await plugin.connect({ url: BASE_URL });
      await plugin.subscribe(T, () => undefined);
      await vi.waitFor(() => expect(commandsNamed('xRead')).not.toEqual([]));
      expect(commandsNamed('xRead').map((c) => (c.args[1] as { BLOCK: number }).BLOCK)).toEqual([
        2000,
      ]);
    } finally {
      await plugin.disconnect();
    }
  });
});
