/**
 * The one fixture every zulip test file boots from, the one conformance context both passes use,
 * and the one place the optional real-server gate is decided. Each used to be copy-pasted per call
 * site, which let them drift apart.
 */
import type { ConformanceContext } from '@sharptrick/parley-conformance';
import { asHandle, asTopic, type Topic } from '@sharptrick/parley-core';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, vi } from 'vitest';
import { ZulipPlugin } from '../src/index.js';
import { type FakeZulip, startFakeZulip } from './fake-zulip.js';

/**
 * The declared type of every `backend_config` key, parsed from the source's own
 * `ZulipBackendConfig` wherever in `src/` it is declared. Read it rather than hand-listing the
 * keys, so a key added later is graded the day it is declared — and graded by the SAME set
 * everywhere, so the config table and the secret-hygiene table cannot end up describing two
 * different surfaces.
 */
export const DECLARED_CONFIG_TYPES: Record<string, string> = ((): Record<string, string> => {
  const src = fileURLToPath(new URL('../src/', import.meta.url));
  const source = readdirSync(src)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => readFileSync(`${src}${f}`, 'utf8'))
    .join('\n');
  const body = /export interface ZulipBackendConfig \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? '';
  return Object.fromEntries(
    [...body.matchAll(/^ {2}(\w+)\??: (\w+);/gm)].map((m) => [m[1] as string, m[2] as string]),
  );
})();

export const DECLARED_CONFIG_KEYS = Object.keys(DECLARED_CONFIG_TYPES);

export const rand = (): string => Math.random().toString(36).slice(2, 8);
export const SENDER = asHandle('writer');
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface ZulipPair {
  plugin: ZulipPlugin;
  fake: FakeZulip;
}

export type Boot = (
  opts?: Parameters<typeof startFakeZulip>[0],
  config?: Record<string, unknown>,
) => Promise<ZulipPair>;

/**
 * Register the shared teardown for this test file and return its `boot`. Every booted pair is
 * disconnected and closed after each test, so a leaked poll loop cannot bleed into the next one.
 */
export function useZulip(): Boot {
  let open: ZulipPair[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const { plugin, fake } of open) {
      await plugin.disconnect().catch(() => undefined);
      await fake.close();
    }
    open = [];
  });

  return async (opts, config) => {
    const fake = await startFakeZulip({ heartbeatMs: 200, ...opts });
    const plugin = new ZulipPlugin();
    await plugin.connect({ site_url: fake.url, events_timeout_ms: 500, ...config });
    const pair: ZulipPair = { plugin, fake };
    open.push(pair);
    return pair;
  };
}

/**
 * Every way a live connection ends — which is every way a subscribe loop can end, because the loop
 * is bound to the connection generation and `connect()` over a live connection tears the old one
 * down itself. Shared so a table crossing this dimension grades a new ending the day it is declared,
 * rather than the day someone remembers to add a row for it in each file.
 */
export interface ConnectionEnding {
  name: string;
  /** Whether a NEW connection is left behind; tables that need one filter on this. */
  reconnects: boolean;
  end: (plugin: ZulipPlugin, url: string) => Promise<void>;
}

export const CONNECTION_ENDINGS: ConnectionEnding[] = [
  { name: 'disconnect', reconnects: false, end: async (plugin) => plugin.disconnect() },
  {
    name: 'disconnect then connect',
    reconnects: true,
    end: async (plugin, url) => {
      await plugin.disconnect();
      await plugin.connect({ site_url: url, events_timeout_ms: 500 });
    },
  },
  {
    name: 'connect with no disconnect',
    reconnects: true,
    end: async (plugin, url) => plugin.connect({ site_url: url, events_timeout_ms: 500 }),
  },
];

let contextSeq = 0;

/**
 * The ONE conformance context for this backend, whichever server it is pointed at. Both passes —
 * the in-process fake and the optional real server — go through here so a change to the concurrent
 * writers, the capability flags, or the teardown cannot be applied to one pass and forgotten in the
 * other; anything that must genuinely differ arrives as a named argument and is visible at the call
 * site.
 */
export function makeZulipContext(args: {
  connect: Record<string, unknown>;
  /** Torn down after the plugin, e.g. closing the in-process fake. Omitted for a real server. */
  closeServer?: () => Promise<void>;
}): () => Promise<ConformanceContext> {
  return async (): Promise<ConformanceContext> => {
    const plugin = new ZulipPlugin();
    await plugin.connect(args.connect);
    return {
      plugin,
      // Zulip honors blockMs NATIVELY via the /api/v1/events long-poll, so the shared
      // blocking-fetch conformance case runs directly against the plugin.
      supportsBlockingFetch: true,
      // Zulip stamps the sender from the authenticated bot, not from `post`'s `identity`.
      carriesSenderIdentity: false,
      freshTopic: (): Topic => asTopic(`t-${++contextSeq}-${rand()}`),
      cleanup: async () => {
        await plugin.disconnect();
        await args.closeServer?.();
      },
      concurrentPost: async (topic: Topic, writers: number, perWriter: number) => {
        const plugins = await Promise.all(
          Array.from({ length: writers }, async () => {
            const p = new ZulipPlugin();
            await p.connect(args.connect);
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

/** Names of the environment variables that opt a run into the real-server conformance pass. */
export const REAL_SERVER_VARS = [
  'PARLEY_ZULIP_URL',
  'PARLEY_ZULIP_EMAIL',
  'PARLEY_ZULIP_API_KEY',
] as const;

/** What a reachability probe of the configured server found. */
export interface GateProbe {
  ok: boolean;
  /** Human-readable outcome, e.g. `401 Unauthorized` or `fetch failed`. */
  detail: string;
}

export type GateDecision =
  | { kind: 'skip'; reason: string }
  | { kind: 'run' }
  | { kind: 'fail'; reason: string };

/**
 * Decide whether the optional real-server pass runs, is skipped, or FAILS. Intent and availability
 * are separate: not asking for a real run is a skip, but asking for one against a server that does
 * not answer is a failure — a silent skip there reports green having verified nothing.
 */
export function decideIntegrationGate(
  vars: Record<string, string | undefined>,
  probe?: GateProbe,
): GateDecision {
  const missing = REAL_SERVER_VARS.filter((v) => (vars[v] ?? '') === '');
  if (missing.length === REAL_SERVER_VARS.length) {
    return { kind: 'skip', reason: `set ${REAL_SERVER_VARS.join('/')} to run` };
  }
  if (missing.length > 0) {
    return {
      kind: 'fail',
      reason: `a real-server run was requested but ${missing.join(', ')} ${
        missing.length === 1 ? 'is' : 'are'
      } unset`,
    };
  }
  if (probe === undefined || !probe.ok) {
    return {
      kind: 'fail',
      reason:
        `a real-server run was requested but ${vars['PARLEY_ZULIP_URL'] ?? ''} did not answer ` +
        `the probe: ${probe?.detail ?? 'not probed'}`,
    };
  }
  return { kind: 'run' };
}
