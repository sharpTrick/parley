/**
 * The one fixture every zulip test file boots from, and the one place the optional real-server
 * gate is decided. Both used to be copy-pasted per file, which let them drift apart.
 */
import { asHandle } from '@sharptrick/parley-core';
import { afterEach, vi } from 'vitest';
import { ZulipPlugin } from '../src/index.js';
import { type FakeZulip, startFakeZulip } from './fake-zulip.js';

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
