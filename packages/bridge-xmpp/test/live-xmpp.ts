import { asTopic, type BackendConfig, type Topic } from '@sharptrick/parley-core';
import { client } from '@xmpp/client';
import type { XmppBackendConfig } from '../src/index.js';

/** A live config the suites hand straight to `connect()`, which takes the seam's `BackendConfig`. */
type LiveConfig = XmppBackendConfig & BackendConfig;

/** Shared wiring for the suites that need a real Prosody/ejabberd with MAM (see dev-compose). */
export const BASE: LiveConfig = {
  service: process.env.PARLEY_XMPP_SERVICE ?? 'xmpp://127.0.0.1:5222',
  domain: process.env.PARLEY_XMPP_DOMAIN ?? 'parley.local',
  muc_service: process.env.PARLEY_XMPP_MUC ?? 'muc.parley.local',
  username: process.env.PARLEY_XMPP_USER ?? 'parley',
  password: process.env.PARLEY_XMPP_PASS ?? 'parleypass',
};

/** A SECOND account on the same server — the only way to observe MUC's cross-account nick conflict. */
export const SECOND_ACCOUNT: LiveConfig = {
  ...BASE,
  username: process.env.PARLEY_XMPP_USER2 ?? 'parley2',
  password: process.env.PARLEY_XMPP_PASS2 ?? 'parleypass2',
};

let seq = 0;
export const freshTopic = (prefix = 't'): Topic =>
  asTopic(`${prefix}-${++seq}-${Math.random().toString(36).slice(2, 8)}`);

/** Reachability + credential guard: a short connect/auth, mirroring the redis/nats `isUp` pattern. */
export async function canAuth(cfg: XmppBackendConfig): Promise<boolean> {
  const c = client({
    service: cfg.service,
    domain: cfg.domain,
    username: cfg.username,
    password: cfg.password,
  }) as unknown as {
    start(): Promise<unknown>;
    stop(): Promise<unknown>;
    on(e: string, cb: () => void): void;
  };
  c.on('error', () => undefined);
  try {
    await Promise.race([
      c.start(),
      new Promise((_r, reject) => setTimeout(() => reject(new Error('timeout')), 4000)),
    ]);
    await c.stop().catch(() => undefined);
    return true;
  } catch {
    await c.stop().catch(() => undefined);
    return false;
  }
}
